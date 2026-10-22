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

* ``gateway_state.json`` per profile — liveness is decided by PROCESS liveness
  (``os.kill(pid, 0)``), never by ``updated_at`` freshness, because the gateway
  does not refresh that timestamp on a short interval.
* ``state.db`` per profile — opened READ-ONLY, aggregate columns only.

Privacy: only COUNT/SUM/MAX over the ``sessions`` table. Never message content,
system prompts or titles. No network calls, no credentials.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from typing import Any, Dict, List, Optional

# Resolve the Hermes home the same way the app does: honour $HERMES_HOME (set
# under a named profile / custom install), fall back to ~/.hermes.
HERMES_HOME = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")

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


def _discover_profiles() -> List[str]:
    """Profiles on THIS machine: 'default' (the root home) plus every directory
    under <home>/profiles/. Nothing is hard-coded."""
    order = ["default"]
    prof_dir = os.path.join(HERMES_HOME, "profiles")
    try:
        order.extend(
            sorted(
                d for d in os.listdir(prof_dir)
                if os.path.isdir(os.path.join(prof_dir, d))
            )
        )
    except OSError:
        pass
    return order


def _pid_alive(pid: Any) -> bool:
    """True when ``pid`` is a live process.

    os.kill(pid, 0): success or PermissionError means the process exists;
    ProcessLookupError means it does not. On Windows every signal other than
    CTRL_C_EVENT/CTRL_BREAK_EVENT is routed through TerminateProcess, so
    os.kill(pid, 0) would KILL the target — the manifest declares
    ``platforms: [linux, macos]`` and this refuses the check rather than risk
    killing a live gateway.
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
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


def _read_profile(profile: str) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "profile": profile,
        "online": False,
        "busy": False,
        "state": "offline",
        "active_agents": 0,
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

    path = _state_path(profile)
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
    pid = _as_int(data.get("pid"))

    sess_active = int(entry.get("active_sessions") or 0) > 0
    entry["online"] = bool(_pid_alive(pid) or sess_active)
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
    return [_read_profile(p) for p in _discover_profiles()]


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
