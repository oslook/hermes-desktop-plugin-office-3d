# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2026-10-22

### Changed
- **Catalog-ready unified-package layout.** The repo is now one installable folder:
  `plugin.yaml` + `desktop/plugin.js` + `dashboard/{manifest.json,plugin_api.py}`.
  The old two-target split (`desktop-plugins/office-3d/` + `plugins/office-3d/dashboard/`)
  is gone — the Desktop app copies `desktop/plugin.js` into
  `$HERMES_HOME/desktop-plugins/office-3d/` itself.
- Added `plugin.yaml` manifest (name, version, description, author, license,
  `requires_hermes: ">=0.20.0"`, `kind: standalone`, `platforms: [linux, macos]`).
- Added `__init__.py` (agent half, registers nothing yet) so the package is a proper
  Hermes plugin: the admission capability probe runs and `hermes plugins doctor` passes.
- `requires_hermes` corrected to `>=0.20.0` (the unified-package desktop door landed in
  0.20.0; the README previously claimed 0.17.0+).
- `install.sh` now copies the single package folder; `install.ps1` was removed (see below).
- README (EN + zh-CN): new repository-layout section, `hermes plugins install` instructions,
  and a privacy/no-credentials note.
- Added a GitHub Actions workflow running the catalog admission gate
  (`hermes plugins validate`) on push and PR.

### Fixed
- **Windows safety.** `_pid_alive()` judges profile liveness with `os.kill(pid, 0)`. On
  Windows every signal other than `CTRL_C_EVENT`/`CTRL_BREAK_EVENT` is routed through
  `TerminateProcess`, so that call would **kill** the target process (the gateway). The
  check now refuses to run on Windows and the manifest declares `platforms: [linux, macos]`.
- README uninstall instructions no longer use `rm -rf "$HERMES_HOME/..."` (the install
  scanner flagged it as `destructive_home_rm`); use `hermes plugins remove office-3d`.
- `desktop/plugin.js` header comment no longer claims offline profiles are drawn greyed-out
  in the lounge (they are not drawn at all — empty desk, dark monitor).

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
