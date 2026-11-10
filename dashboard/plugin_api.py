"""office-3d dashboard API.

Scans gateway_state.json files across Hermes profiles and returns profile
status entries for the Office 3D visualization.

'online' uses Hermes gateway liveness, including multiplexed profiles, not
updated_at freshness.

FD / load design (v1.0.2):
- One cached read-only SQLite connection per profile state.db (not open/close
  on every poll). Caps steady-state db fds at ~1–3 per profile.
- All use of a cached connection is serialized under a lock (sqlite3
  connections are not safe for concurrent multi-thread use).
- Single aggregate SELECT per profile instead of five round-trips.
- Short in-process response TTL to collapse concurrent/stacked polls.
- Blocking work runs in a worker thread so the FastAPI event loop stays free.

Stdlib only (+ fastapi for the router).
"""
from __future__ import annotations

import atexit
import asyncio
import glob
import json
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from functools import partial
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter

router = APIRouter()

# Never mistake a named profile's runtime home for the fleet root.
try:
    from hermes_constants import get_default_hermes_root
except ImportError as exc:
    raise RuntimeError("office-3d requires Hermes with get_default_hermes_root; please upgrade Hermes") from exc

try:
    from gateway.status import resolve_gateway_liveness, get_running_pid_cached
except ImportError as exc:
    raise RuntimeError("office-3d requires Hermes with resolve_gateway_liveness; please upgrade Hermes") from exc

from hermes_cli.profiles import read_profile_meta

HERMES_HOME = str(get_default_hermes_root())

# How long a computed /state payload may be reused (seconds). Frontend polls
# every 5s; a 2s TTL collapses bursts without making the UI feel stale.
_STATE_TTL_SEC = 2.0

# Cached RO connections: path -> connection.
# _db_lock serializes both cache mutation AND execute/fetch on those conns.
_db_lock = threading.Lock()
_ro_conns: Dict[str, sqlite3.Connection] = {}

# Cached /state response: (monotonic_deadline, payload)
_state_cache_lock = threading.Lock()
_state_cache: Optional[Tuple[float, List[Dict[str, Any]]]] = None


# Keep both independently loaded plugin halves aligned with Hermes discovery.
# Older supported Hermes releases may not expose these helpers yet.
try:
    from hermes_constants import PROFILE_ID_RE, named_profile_is_live
except ImportError:
    PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

    def named_profile_is_live(home: Path) -> bool:
        markers = ("config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db")
        return (
            home.is_dir()
            and not (home.parent / ".deleted" / home.name).exists()
            and any((home / marker).is_file() or (home / marker).is_symlink()
                    for marker in markers)
        )


def _discover_profiles() -> List[str]:
    """Default first, then valid, non-deleted profiles in this Hermes home.

    Discovery is independent of gateway/session liveness: offline profiles
    still own desks. Keep the scan scoped to the home used by the readers.
    """
    order = ["default"]
    try:
        order.extend(sorted(
            entry.name for entry in (Path(HERMES_HOME) / "profiles").iterdir()
            if entry.name != "default"
            and PROFILE_ID_RE.fullmatch(entry.name)
            and named_profile_is_live(entry)
        ))
    except OSError:
        pass
    return order


def _windows_pid_alive(pid: int) -> bool:
    """Windows-safe liveness probe: never signals the target process.

    ``os.kill(pid, 0)`` on Windows is routed through ``TerminateProcess`` and
    would KILL the gateway, so the probe goes through ``OpenProcess`` +
    ``GetExitCodeProcess`` (the same technique Hermes' own
    ``pid_exists_stdlib`` uses, kept local so this plugin imports no private
    core module). Fork patch v1.4.2-win.1.
    """
    try:
        import ctypes
        from ctypes import wintypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            # ERROR_ACCESS_DENIED (5) means the process exists but is not ours.
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return False


def _pid_alive(pid: Any) -> bool:
    """Return True if the given pid corresponds to a live process, without
    signalling it.

    POSIX — os.kill(pid, 0) semantics:
      - success            -> process exists and we can signal it -> ALIVE
      - PermissionError    -> process exists but not owned by us  -> ALIVE
      - ProcessLookupError -> no such process                     -> DEAD
      - other OSError      -> treat as DEAD (defensive)

    Windows — os.kill(pid, 0) would *kill* the target (TerminateProcess), so the
    ctypes-backed probe above is used instead of refusing the check (fork patch
    v1.4.2-win.1; upstream declared platforms: [linux, macos]).
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_alive(pid)
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


def _close_ro_conn_unlocked(path: str) -> None:
    """Drop a cached connection. Caller must hold _db_lock."""
    con = _ro_conns.pop(path, None)
    if con is None:
        return
    try:
        con.close()
    except Exception:
        pass


def _get_ro_conn_unlocked(path: str) -> Optional[sqlite3.Connection]:
    """Return a process-cached read-only connection. Caller must hold _db_lock."""
    con = _ro_conns.get(path)
    if con is not None:
        try:
            con.execute("SELECT 1")
            return con
        except Exception:
            _close_ro_conn_unlocked(path)

    try:
        uri = "file:" + path + "?mode=ro"
        con = sqlite3.connect(
            uri,
            uri=True,
            timeout=2.0,
            check_same_thread=False,
        )
        try:
            con.execute("PRAGMA query_only=ON")
        except sqlite3.Error:
            pass
        _ro_conns[path] = con
        return con
    except Exception:
        return None


def _close_all_ro_conns() -> None:
    with _db_lock:
        paths = list(_ro_conns.keys())
        for path in paths:
            _close_ro_conn_unlocked(path)


atexit.register(_close_all_ro_conns)


_STATS_SQL = (
    "SELECT "
    "SUM(CASE WHEN last_activity_at IS NOT NULL AND last_activity_at >= ? "
    "THEN 1 ELSE 0 END), "
    "SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END), "
    "SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), "
    "SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)), "
    "MAX(last_activity_at) "
    "FROM sessions"
)


def _read_session_stats(profile: str) -> Dict[str, Any]:
    """Read READ-ONLY aggregate stats from a profile's state.db sessions table.

    Aggregate SELECTs only (COUNT/SUM/MAX). Never touches messages.content,
    system_prompt, or title. Tolerates missing db / locked / missing table
    by returning zeros.

    Uses one cached RO connection per db path and a single SQL statement
    (v1.0.2) to avoid per-poll fd churn and multi-query lock time.
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

    with _db_lock:
        con = _get_ro_conn_unlocked(path)
        if con is None:
            return result
        try:
            now = time.time()
            cur = con.execute(_STATS_SQL, (now - 90.0,))
            row = cur.fetchone()
        except Exception:
            # Connection may be broken (db replaced, locked hard, schema change).
            _close_ro_conn_unlocked(path)
            return result

    if not row:
        return result
    active, opened, tokens, cost, last_act = row
    try:
        if active is not None:
            result["active_sessions"] = int(active)
        if opened is not None:
            result["open_sessions"] = int(opened)
        if tokens is not None:
            result["tokens_total"] = int(tokens)
        if cost is not None:
            result["cost_total"] = float(cost)
        if last_act is not None:
            try:
                result["last_session_activity"] = float(last_act)
            except (TypeError, ValueError):
                result["last_session_activity"] = None
    except (TypeError, ValueError):
        pass
    return result


# --- delegated subagent attribution (v1.4.0) ---
#
# delegate_task children run as managed workers inside the gateway process and
# record their sessions in the TOP-LEVEL state.db with source='subagent' and
# profile_name='default'. Without attribution that activity can only ever
# light up the 'default' desk, so a specialist desk (meo-finance, meo-coding,
# …) shows offline while its delegation is actively working.
#
# Attribute LIVE subagent sessions to the profile each in-flight delegation is
# routed to. The route is parsed from the delegation task's explicit 'profile'
# field, or from the '[profile]' goal prefix — the same convention specialist
# profiles already use. Display-only heuristic: two concurrent delegations
# routed to the same profile share credit, and historical (finished) subagent
# sessions are not re-attributed. Reads the async_delegations table with
# aggregate-only access; every failure degrades to "no attribution".

_DELEGATION_ACTIVE_STATES = ("running", "dispatched", "pending")


def _route_labels_from_task(task_json: Any) -> List[str]:
    """Profile labels a delegation task is routed to, in first-seen order."""
    try:
        data = json.loads(task_json or "{}")
    except (json.JSONDecodeError, ValueError):
        return []
    tasks = data.get("tasks") if isinstance(data.get("tasks"), list) else [data]
    labels: List[str] = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        explicit = task.get("profile")
        if isinstance(explicit, str) and explicit.strip():
            label = explicit.strip().lower()
            if label not in labels:
                labels.append(label)
            continue
        goal = task.get("goal") or task.get("task") or ""
        match = re.match(
            r"^\s*\[([a-z0-9][a-z0-9_-]{0,63})\]", str(goal), re.IGNORECASE
        )
        if match:
            label = match.group(1).lower()
            if label not in labels:
                labels.append(label)
    return labels


def _read_delegation_routes() -> Dict[str, int]:
    """Profile label -> number of delegations currently in flight for it."""
    path = _db_path("default")
    if not os.path.exists(path):
        return {}
    marks = ", ".join("?" for _ in _DELEGATION_ACTIVE_STATES)
    with _db_lock:
        con = _get_ro_conn_unlocked(path)
        if con is None:
            return {}
        try:
            rows = con.execute(
                "SELECT task_json FROM async_delegations WHERE state IN ("
                + marks
                + ")",
                _DELEGATION_ACTIVE_STATES,
            ).fetchall()
        except Exception:
            # Older Hermes without async_delegations, or a locked db.
            return {}
    counts: Dict[str, int] = {}
    for (task_json,) in rows:
        for label in _route_labels_from_task(task_json):
            counts[label] = counts.get(label, 0) + 1
    return counts


def _count_live_subagent_sessions() -> int:
    """Subagent sessions with activity inside the 90s window (top-level db)."""
    path = _db_path("default")
    if not os.path.exists(path):
        return 0
    with _db_lock:
        con = _get_ro_conn_unlocked(path)
        if con is None:
            return 0
        try:
            row = con.execute(
                "SELECT COUNT(*) FROM sessions "
                "WHERE source = 'subagent' AND last_activity_at >= ?",
                (time.time() - 90.0,),
            ).fetchone()
        except Exception:
            return 0
    return int(row[0] or 0) if row else 0


def _read_profile(
    profile: str,
    delegation_routes: Optional[Dict[str, int]] = None,
    live_subagents: Optional[int] = None,
) -> Dict[str, Any]:
    # Share Bots' metadata reader, including its cache and error handling.
    meta = read_profile_meta(Path(_state_path(profile)).parent)
    entry: Dict[str, Any] = {
        "profile": profile,
        "display_name": meta.get("bot_title") or meta.get("display_name") or "",
        "active_agents": 0,
        "delegated_sessions": 0,
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

    # Delegated subagent attribution: a specialist desk lights up while a
    # delegation routed to it has live subagent activity (managed workers
    # record sessions in the top-level state.db, not this profile's own db).
    if profile != "default":
        if delegation_routes is None:
            delegation_routes = _read_delegation_routes()
        if live_subagents is None:
            live_subagents = _count_live_subagent_sessions()
        if delegation_routes.get(profile) and live_subagents > 0:
            entry["delegated_sessions"] = int(live_subagents)
            entry["online"] = True
            entry["busy"] = True
            entry["state"] = "working"

    liveness = resolve_gateway_liveness(
        profile_dir=Path(path).parent,
        pid_probe=partial(get_running_pid_cached, cleanup_stale=False),
    )
    if liveness.running:
        entry["online"] = True
        if not entry["busy"]:
            entry["state"] = "unknown"
            entry["idle_since"] = entry.get("last_session_activity")
    # Ignore a served profile's stale standalone record and host-wide counters.
    if liveness.source == "multiplexer":
        return entry
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

    online = liveness.running
    sess_active = bool(entry.get("active_sessions") or entry.get("delegated_sessions"))

    entry["active_agents"] = active_int
    # online if the gateway process is alive OR there is live session activity
    # (worker profiles have sessions but no persistent gateway pid).
    entry["online"] = bool(online or sess_active)
    # Busy includes local or attributed delegated sessions, not gateway counters.
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


def _collect_state() -> List[Dict[str, Any]]:
    """Synchronous full scan — intended to run off the event loop."""
    global _state_cache
    now = time.monotonic()
    with _state_cache_lock:
        cached = _state_cache
        if cached is not None and cached[0] > now:
            return cached[1]

    # Attribution inputs are computed once per scan, not per profile.
    routes = _read_delegation_routes()
    live_subagents = _count_live_subagent_sessions() if routes else 0
    payload = [
        _read_profile(p, delegation_routes=routes, live_subagents=live_subagents)
        for p in _discover_profiles()
    ]
    with _state_cache_lock:
        _state_cache = (now + _STATE_TTL_SEC, payload)
    return payload


@router.get("/state")
async def state() -> List[Dict[str, Any]]:
    # Never block the dashboard event loop on SQLite / disk I/O.
    return await asyncio.to_thread(_collect_state)


# Debug-only discovery helper (not routed).
def _discover_profile_files() -> List[str]:
    files = [os.path.join(HERMES_HOME, "gateway_state.json")]
    files.extend(sorted(glob.glob(os.path.join(HERMES_HOME, "profiles", "*", "gateway_state.json"))))
    return files
