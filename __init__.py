"""office-3d — agent half.

The plugin is UI-first: the Desktop half (``desktop/plugin.js``) renders the
isometric office and the dashboard half (``dashboard/plugin_api.py``) serves
``/api/plugins/office-3d/state`` to it. This module adds the one piece of
agent-side surface the plugin has: a read-only ``office_status`` tool, so the
model can answer "who is working right now?" without the Desktop app.

The scan logic is deliberately a compact copy of ``dashboard/plugin_api.py``'s:
the two halves run in different processes (the gateway vs. the dashboard web
server), each is loaded independently, and neither can import the other. Both
read the same two sources:

* Hermes gateway liveness — includes multiplexed and standalone profiles,
  without relying on ``updated_at`` freshness.
* ``state.db`` per profile — opened READ-ONLY, aggregate columns only.

Privacy: only COUNT/SUM/MAX over the ``sessions`` table. Never message content,
system prompts or titles. No network calls, no credentials.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from pathlib import Path
from functools import partial
from typing import Any, Dict, List, Optional

# Fail closed on older Hermes versions without fleet-root resolution: using a
# named profile's HERMES_HOME as the root silently reports the wrong fleet.
try:
    from hermes_constants import get_default_hermes_root
except ImportError as exc:
    raise RuntimeError("office-3d requires Hermes with get_default_hermes_root; please upgrade Hermes") from exc

try:
    from gateway.status import resolve_gateway_liveness, get_running_pid_cached
except ImportError as exc:
    raise RuntimeError("office-3d requires Hermes with resolve_gateway_liveness; please upgrade Hermes") from exc

HERMES_HOME = str(get_default_hermes_root())

# A session counts as "active" (profile busy) if it saw activity this recently.
ACTIVE_WINDOW_SEC = 90.0

# Aggregate-only: counts, token/cost totals and the newest activity stamp.
# Never selects message content, system prompts or titles.
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


def _as_int(value: Any, default: int = 0) -> int:
    """int() that tolerates None / junk from a hand-edited state file."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


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
    """True when ``pid`` is a live process, without ever signalling it.

    POSIX: os.kill(pid, 0) — success or PermissionError means the process
    exists; ProcessLookupError means it does not.
    Windows (fork patch v1.4.2-win.1): os.kill(pid, 0) would KILL the target, so
    the ctypes-backed probe above is used instead of refusing the check.
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


def _read_session_stats(profile: str) -> Dict[str, Any]:
    """Read-only aggregate stats from a profile's state.db. A missing db, a
    locked db or a schema change all degrade to zeros instead of raising."""
    stats: Dict[str, Any] = {
        "active_sessions": 0,
        "open_sessions": 0,
        "tokens_total": 0,
        "cost_total": 0.0,
        "last_session_activity": None,
    }
    path = _db_path(profile)
    if not os.path.exists(path):
        return stats
    con: Optional[sqlite3.Connection] = None
    try:
        con = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=2.0)
        try:
            con.execute("PRAGMA query_only=ON")
        except sqlite3.Error:
            pass
        row = con.execute(_STATS_SQL, (time.time() - ACTIVE_WINDOW_SEC,)).fetchone()
    except Exception:
        return stats
    finally:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass
    if not row:
        return stats
    active, opened, tokens, cost, last_act = row
    if active is not None:
        stats["active_sessions"] = int(active)
    if opened is not None:
        stats["open_sessions"] = int(opened)
    if tokens is not None:
        stats["tokens_total"] = int(tokens)
    if cost is not None:
        stats["cost_total"] = float(cost)
    if isinstance(last_act, (int, float)):
        stats["last_session_activity"] = float(last_act)
    return stats


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
    con: Optional[sqlite3.Connection] = None
    try:
        con = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=2.0)
        try:
            con.execute("PRAGMA query_only=ON")
        except sqlite3.Error:
            pass
        rows = con.execute(
            "SELECT task_json FROM async_delegations WHERE state IN (" + marks + ")",
            _DELEGATION_ACTIVE_STATES,
        ).fetchall()
    except Exception:
        # Older Hermes without async_delegations, or a locked db.
        return {}
    finally:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass
    counts: Dict[str, int] = {}
    for (task_json,) in rows:
        for label in _route_labels_from_task(task_json):
            counts[label] = counts.get(label, 0) + 1
    return counts


def _count_live_subagent_sessions() -> int:
    """Subagent sessions with activity inside the active window (top-level db)."""
    path = _db_path("default")
    if not os.path.exists(path):
        return 0
    con: Optional[sqlite3.Connection] = None
    try:
        con = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=2.0)
        try:
            con.execute("PRAGMA query_only=ON")
        except sqlite3.Error:
            pass
        row = con.execute(
            "SELECT COUNT(*) FROM sessions "
            "WHERE source = 'subagent' AND last_activity_at >= ?",
            (time.time() - ACTIVE_WINDOW_SEC,),
        ).fetchone()
    except Exception:
        return 0
    finally:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass
    return int(row[0] or 0) if row else 0


def _read_profile(
    profile: str,
    delegation_routes: Optional[Dict[str, int]] = None,
    live_subagents: Optional[int] = None,
) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "profile": profile,
        "online": False,
        "busy": False,
        "state": "offline",
        "active_agents": 0,
        "delegated_sessions": 0,
        "active_sessions": 0,
        "open_sessions": 0,
        "tokens_total": 0,
        "cost_total": 0.0,
        "last_session_activity": None,
        "idle_since": None,
    }
    try:
        entry.update(_read_session_stats(profile))
    except Exception:
        pass

    # Session activity alone means online+busy: a worker profile running
    # `hermes -p <name> chat` has live sessions but no persistent
    # gateway_state.json, and must not be reported offline.
    if int(entry.get("active_sessions") or 0) > 0:
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

    path = _state_path(profile)
    liveness = resolve_gateway_liveness(
        profile_dir=Path(path).parent,
        pid_probe=partial(get_running_pid_cached, cleanup_stale=False),
    )
    if liveness.running:
        entry["online"] = True
        if not entry["busy"]:
            entry["state"] = "unknown"
            entry["idle_since"] = entry.get("last_session_activity")
    # A served profile's old state file belongs to a previous gateway, not the host.
    if liveness.source == "multiplexer":
        return entry
    if not os.path.exists(path):
        return entry

    data: Optional[Dict[str, Any]] = None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return entry
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            data = parsed
    except ValueError:
        # The file can accumulate concatenated objects across restarts; take
        # the last well-formed one.
        end = raw.rfind("}")
        while end != -1 and data is None:
            start = raw.rfind("{", 0, end)
            while start != -1:
                try:
                    candidate = json.loads(raw[start:end + 1])
                except ValueError:
                    start = raw.rfind("{", 0, start)
                    continue
                if isinstance(candidate, dict):
                    data = candidate
                break
            if data is not None:
                break
            end = raw.rfind("}", 0, end)
    if not isinstance(data, dict):
        return entry

    entry["active_agents"] = _as_int(data.get("active_agents"))
    sess_active = bool(entry.get("active_sessions") or entry.get("delegated_sessions"))
    entry["online"] = bool(liveness.running or sess_active)
    entry["busy"] = bool(sess_active)
    gw_state = data.get("gateway_state")
    entry["state"] = (
        "working" if sess_active
        else (gw_state if isinstance(gw_state, str) and gw_state else "unknown")
    )

    if entry["online"] and not entry["busy"]:
        idle_since = entry.get("last_session_activity")
        if not isinstance(idle_since, (int, float)):
            try:
                idle_since = os.path.getmtime(path)
            except OSError:
                idle_since = None
        entry["idle_since"] = idle_since
    return entry


def collect(profile: Optional[str] = None) -> List[Dict[str, Any]]:
    """Status entries for one profile, or for every profile on this machine."""
    if profile:
        return [_read_profile(str(profile))]
    # Attribution inputs are computed once per scan, not per profile.
    routes = _read_delegation_routes()
    live_subagents = _count_live_subagent_sessions() if routes else 0
    return [
        _read_profile(p, delegation_routes=routes, live_subagents=live_subagents)
        for p in _discover_profiles()
    ]


def _format(entries: List[Dict[str, Any]]) -> str:
    if not entries:
        return "No Hermes profiles found under " + HERMES_HOME + "."
    online = sum(1 for e in entries if e["online"])
    busy = sum(1 for e in entries if e["busy"])
    sessions = sum(int(e["active_sessions"]) for e in entries)
    tokens = sum(int(e["tokens_total"]) for e in entries)
    cost = sum(float(e["cost_total"]) for e in entries)

    lines = [
        "office-3d — {} profile(s): {} online, {} busy, {} active session(s), "
        "{} tokens, ${:.2f}".format(len(entries), online, busy, sessions, tokens, cost)
    ]
    for e in entries:
        state = "busy" if e["busy"] else ("idle" if e["online"] else "offline")
        bits = ["{}: {}".format(e["profile"], state)]
        if e["busy"]:
            bits.append("{} active session(s)".format(e["active_sessions"]))
        elif e["online"] and isinstance(e["idle_since"], (int, float)):
            mins = max(0, int((time.time() - float(e["idle_since"])) // 60))
            bits.append("idle {}m".format(mins))
        if e["tokens_total"]:
            bits.append("{} tokens".format(e["tokens_total"]))
        if e["cost_total"]:
            bits.append("${:.2f}".format(float(e["cost_total"])))
        if e["active_agents"]:
            bits.append("{} agent(s)".format(e["active_agents"]))
        lines.append("  " + " · ".join(bits))
    return "\n".join(lines)


def office_status(args: Dict[str, Any], **kwargs: Any) -> str:
    """Tool handler: report profile online/busy/offline plus aggregate totals."""
    raw = args.get("profile") if isinstance(args, dict) else None
    profile = str(raw).strip() if raw else None
    try:
        return _format(collect(profile))
    except Exception as exc:  # a scan failure must never kill the turn
        return "office-3d: could not read profile status ({})".format(exc)


OFFICE_STATUS_SCHEMA = {
    "name": "office_status",
    "description": (
        "Report which Hermes profiles are online, busy or offline right now, "
        "with their aggregate session, token and cost totals. Reads only "
        "aggregate columns (COUNT/SUM/MAX) from each profile's state.db "
        "read-only — never message content, system prompts or titles. Use it to "
        "answer 'who is working right now?' or to check on a specific profile."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "profile": {
                "type": "string",
                "description": (
                    "Optional profile name to report on (e.g. 'dev', 'ops'). "
                    "Omit to report on every profile."
                ),
            },
        },
    },
}


def register(ctx) -> None:
    """Register the read-only office_status tool."""
    ctx.register_tool(
        name="office_status",
        toolset="office-3d",
        schema=OFFICE_STATUS_SCHEMA,
        handler=office_status,
    )
