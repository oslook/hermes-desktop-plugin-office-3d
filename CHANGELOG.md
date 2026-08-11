# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-08-11

### Fixed
- **FD / load hardening** for the dashboard backend and frontend polling path
  - Cache one read-only SQLite connection per profile `state.db` (serialized under a lock) instead of open/close on every poll
  - Collapse five aggregate queries into a single `SELECT`
  - Serve `/state` via `asyncio.to_thread` so SQLite never blocks the FastAPI event loop
  - Add a 2s in-process response TTL to absorb stacked polls
  - Pause frontend `refetchInterval` while `document.hidden` (canvas already paused; the query did not)

### Technical Details
v1.0.1 made connection cleanup exception-safe, but each 5s poll still opened a fresh RO handle for every profile (~4k open/close cycles per hour). That churn drove high transient fd use under load. v1.0.2 keeps steady-state SQLite fds roughly proportional to the number of profiles and stops background polling when the Office page is not visible.

## [1.0.1] - 2026-08-11

### Fixed
- **Critical**: Fixed SQLite connection leak in `plugin_api.py` that caused dashboard to crash after 1-2 hours
  - Increased database connection timeout from 0.5s to 2.0s to prevent timeout-induced connection leaks
  - Changed exception handling from `sqlite3.Error` to `Exception` to catch all failure modes
  - Added null-check before closing connections to prevent `AttributeError` leaks
  - Impact: Dashboard now runs stably without file descriptor exhaustion

### Technical Details
The plugin polls 6 profiles every 5 seconds (720 requests/hour × 6 connections = 4,320 connection attempts/hour).
The original code had three bugs:
1. `timeout=0.5` was too short for FTS queries, causing timeouts that left connections in a half-closed state
2. `except sqlite3.Error` was too narrow and missed `AttributeError`, `SystemError`, etc.
3. Missing `if con is not None` check before `con.close()` caused exceptions in early-return paths

These combined to leak ~150 file descriptors per hour, hitting the macOS default limit of 256 in ~1.7 hours.

## [1.0.0] - 2026-08-09

### Added
- Initial release
- 3D isometric office visualization showing all Hermes profiles
- Real-time status updates: busy profiles "type" at their desk, idle profiles relax in the lounge
- Dark/light theme support
- Six profile support: default, data, dev, ops, research, sandbox
- Backend API endpoint `/state` providing real-time profile statistics from `state.db`

### Features
- **Work Zone**: Individual desks with monitors and chairs for each profile
- **Lounge Zone**: Shared relaxation area with tea service
- **Animations**: Typing hands for busy profiles, tea-sipping for idle profiles
- **Stats Display**: Session counts, token usage, costs, and idle duration
- **Theme Integration**: Automatically follows Hermes desktop theme (dark/light)
