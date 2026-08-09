"""office-3d dashboard API.

Scans gateway_state.json files across Hermes profiles and returns a fixed
list of six profile status entries for the Office 3D visualization.

'online' is determined by PROCESS LIVENESS (os.kill(pid, 0)), not by the
freshness of updated_at — the gateway does not refresh updated_at on a
short interval, so a stale timestamp does not imply the gateway is down.

Stdlib only.
"""
from __future__ import annotations

import glob
import json
import os
import sqlite3
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter

router = APIRouter()

# Resolve the Hermes home the same way the app does: honor $HERMES_HOME
# (set under a named profile / custom install), fall back to ~/.hermes.
HERMES_HOME = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def _discover_profiles() -> List[str]:
    """Discover profiles on THIS machine instead of hard-coding names.

    'default' (the root home) is always first; named profiles are whatever
    directories exist under <home>/profiles/, sorted. This makes the plugin
    portable to any user's setup, not just the author's.
    """
    order = ["default"]
    prof_dir = os.path.join(HERMES_HOME, "profiles")
    try:
        names = sorted(
            d for d in os.listdir(prof_dir)
            if os.path.isdir(os.path.join(prof_dir, d))
        )
        order.extend(names)
    except OSError:
        pass
    return order


def _pid_alive(pid: Any) -> bool:
    """Return True if the given pid corresponds to a live process.

    os.kill(pid, 0) semantics:
      - success            -> process exists and we can signal it -> ALIVE
      - PermissionError    -> process exists but not owned by us  -> ALIVE
      - ProcessLookupError -> no such process                     -> DEAD
      - other OSError      -> treat as DEAD (defensive)
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _state_path(profile: str) -> str:
    if profile == "default":
        return os.path.join(HERMES_HOME, "gateway_state.json")
    return os.path.join(HERMES_HOME, "profiles", profile, "gateway_state.json")


def _db_path(profile: str) -> str:
    if profile == "default":
        return os.path.join(HERMES_HOME, "state.db")
    return os.path.join(HERMES_HOME, "profiles", profile, "state.db")


def _read_session_stats(profile: str) -> Dict[str, Any]:
    """Read READ-ONLY aggregate stats from a profile's state.db sessions table.

    Aggregate SELECTs only (COUNT/SUM/MAX). Never touches messages.content,
    system_prompt, or title. Tolerates missing db / locked / missing table
    by returning zeros.
    """
    result: Dict[str, Any] = {
        "active_sessions": 0,
        "open_sessions": 0,
        "tokens_total": 0,
        "cost_total": 0.0,
        "last_session_activity": None,
    }
    path = _db_path(profile)
    if not os.path.exists(path):
        return result
    con: Optional[sqlite3.Connection] = None
    try:
        uri = "file:" + path + "?mode=ro"
        con = sqlite3.connect(uri, uri=True, timeout=0.5)
    except sqlite3.Error:
        return result
    try:
        now = time.time()
        try:
            cur = con.execute(
                "SELECT COUNT(*) FROM sessions WHERE last_activity_at IS NOT NULL "
                "AND last_activity_at >= ?",
                (now - 90.0,),
            )
            row = cur.fetchone()
            if row and row[0] is not None:
                result["active_sessions"] = int(row[0])
        except sqlite3.Error:
            pass
        try:
            cur = con.execute("SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL")
            row = cur.fetchone()
            if row and row[0] is not None:
                result["open_sessions"] = int(row[0])
        except sqlite3.Error:
            pass
        try:
            cur = con.execute(
                "SELECT SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) "
                "FROM sessions"
            )
            row = cur.fetchone()
            if row and row[0] is not None:
                result["tokens_total"] = int(row[0])
        except sqlite3.Error:
            pass
        try:
            cur = con.execute(
                "SELECT SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)) "
                "FROM sessions"
            )
            row = cur.fetchone()
            if row and row[0] is not None:
                result["cost_total"] = float(row[0])
        except sqlite3.Error:
            pass
        try:
            cur = con.execute("SELECT MAX(last_activity_at) FROM sessions")
            row = cur.fetchone()
            if row and row[0] is not None:
                try:
                    result["last_session_activity"] = float(row[0])
                except (TypeError, ValueError):
                    result["last_session_activity"] = None
        except sqlite3.Error:
            pass
    finally:
        try:
            con.close()
        except sqlite3.Error:
            pass
    return result


def _read_profile(profile: str) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "profile": profile,
        "active_agents": 0,
        "state": "offline",
        "updated_at": None,
        "online": False,
        "busy": False,
        "idle_since": None,
        "active_sessions": 0,
        "open_sessions": 0,
        "tokens_total": 0,
        "cost_total": 0.0,
        "last_session_activity": None,
    }
    path = _state_path(profile)
    # Session stats are independent of gateway_state.json availability.
    try:
        stats = _read_session_stats(profile)
    except Exception:
        stats = {
            "active_sessions": 0,
            "open_sessions": 0,
            "tokens_total": 0,
            "cost_total": 0.0,
            "last_session_activity": None,
        }
    entry.update(stats)

    # Session activity ALONE is enough to be considered online+busy — a worker
    # profile (dev/data/…) running `hermes -p … chat` has active sessions but
    # NO persistent gateway_state.json. Compute this up front so the two early
    # returns below (missing/unreadable gateway_state.json) still report busy.
    sess_active = int(entry.get("active_sessions") or 0) > 0
    if sess_active:
        entry["online"] = True
        entry["busy"] = True
        entry["state"] = "working"

    if not os.path.exists(path):
        return entry
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
    except OSError:
        return entry

    data: Optional[Dict[str, Any]] = None
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            data = parsed
    except json.JSONDecodeError:
        # The state file can accumulate concatenated JSON objects across
        # gateway restarts. Try to isolate the last well-formed JSON object.
        end = raw.rfind("}")
        while end != -1 and data is None:
            start = raw.rfind("{", 0, end)
            while start != -1:
                chunk = raw[start : end + 1]
                try:
                    candidate = json.loads(chunk)
                    if isinstance(candidate, dict):
                        data = candidate
                        break
                except json.JSONDecodeError:
                    start = raw.rfind("{", 0, start)
                    continue
                break
            if data is not None:
                break
            end = raw.rfind("}", 0, end)

    if not isinstance(data, dict):
        return entry

    active_raw = data.get("active_agents", 0)
    try:
        active_int = int(active_raw)
    except (TypeError, ValueError):
        active_int = 0

    gw_state = data.get("gateway_state")
    if not isinstance(gw_state, str) or not gw_state:
        gw_state = "unknown"

    updated_at_raw = data.get("updated_at")
    updated_at_str = updated_at_raw if isinstance(updated_at_raw, str) else None

    pid_raw = data.get("pid")
    try:
        pid_int = int(pid_raw)
    except (TypeError, ValueError):
        pid_int = 0

    online = _pid_alive(pid_int)
    sess_active = int(entry.get("active_sessions") or 0) > 0

    entry["active_agents"] = active_int
    # online if the gateway process is alive OR there is live session activity
    # (worker profiles have sessions but no persistent gateway pid).
    entry["online"] = bool(online or sess_active)
    # busy is driven by session activity (active_sessions > 0), NOT by gateway
    # active_agents. active_agents is kept as a display-only counter.
    entry["busy"] = bool(sess_active)
    entry["updated_at"] = updated_at_str  # informational only
    # state text: prefer 'working' when sessions are live, else the gateway's.
    entry["state"] = "working" if sess_active else gw_state
    online = entry["online"]

    # idle_since: when the profile last changed state, used by the UI to show
    # "idle for Xm". Prefer last_session_activity (from state.db) when
    # present, else the file mtime (updated whenever the gateway writes its
    # state), fall back to parsed updated_at. Epoch seconds (UTC). Only
    # meaningful when online and not busy; null otherwise so the UI can hide it.
    idle_since = None
    if online and not entry["busy"]:
        lsa = entry.get("last_session_activity")
        if isinstance(lsa, (int, float)):
            idle_since = float(lsa)
        if idle_since is None:
            try:
                idle_since = os.path.getmtime(path)
            except OSError:
                idle_since = None
        if idle_since is None and updated_at_str:
            try:
                from datetime import datetime
                idle_since = datetime.fromisoformat(
                    updated_at_str.replace("Z", "+00:00")
                ).timestamp()
            except (ValueError, TypeError):
                idle_since = None
    entry["idle_since"] = idle_since
    return entry


@router.get("/state")
async def state() -> List[Dict[str, Any]]:
    return [_read_profile(p) for p in _discover_profiles()]


# Debug-only discovery helper (not routed).
def _discover_profile_files() -> List[str]:
    files = [os.path.join(HERMES_HOME, "gateway_state.json")]
    files.extend(sorted(glob.glob(os.path.join(HERMES_HOME, "profiles", "*", "gateway_state.json"))))
    return files