# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-10-22

### Added
- **Click a desk to inspect a profile.** `OfficeCanvas` hands the frame transform back to the
  page, so a click is hit-tested against exactly the projection the pixels came from; the
  clicked desk gets an accent mat on the floor and a detail panel opens with state, active/open
  sessions, agents, tokens, cost and idle time.
- **Open from the panel**: "Open chat" (`host.newChat(profile)`) always, and "Open latest
  session" (`host.openSession(id, { profile })`) when the profile has one — the id comes from
  the app's own `session.list` RPC, and the button simply does not appear when nothing resolves.
- **Cost / tokens leaderboard** in the right-hand column, switchable between the two metrics and
  ranked descending; a row click inspects that profile.
- `docs/banner.png` — the 2:1 (1200×600) catalog banner, composed from the real screenshot.

### Changed
- Hit testing is pure (`deskHitBox` / `hitTestDesks`): overlapping isometric boxes resolve to the
  **front-most** desk (the one painted last), and the harness asserts that against an
  independent computation for 1–40 profiles on two canvas sizes.
- `drawFrame` / `buildPalette` dropped their unused `mode` parameter — the theme has always come
  from the `documentElement.dark` class.

## [1.1.0] - 2026-10-22

### Added
- **`office_status` agent tool** — read-only: reports which profiles are online, busy or
  offline with aggregate session / token / cost totals, so the model can answer "who is
  working right now?" without the Desktop app. Same privacy boundary as the backend
  (aggregate columns only, `state.db` opened read-only).
- **Status-bar chip** — an always-mounted summary (`🏢 2 busy` / `🏢 4 online`) at the right
  end of the status bar; click it to open the office. It also hosts the state-change poller.
- **⌘K palette command + keybind** — "Open Office 3D" (default `mod+shift+o`),
  user-rebindable in Settings.
- **Settings ▸ Plugins ▸ Office 3D** — refresh interval (2s/5s/15s/60s), hide offline
  profiles, and opt-in desktop notifications when a profile changes state. Persisted with
  `ctx.storage`.
- A GitHub Actions workflow running the catalog admission gate (`hermes plugins validate`).

### Fixed
- **Desk grid overflow with 7+ profiles.** The grid was hard-coded to 3 columns and the work
  floor to a fixed 6.5 world-units deep, so the 7th desk (y=6.9) was painted outside the
  floor and the office spilled over. The grid and both floor extents are now computed from
  the profile count — 3×2 for six profiles (identical to before), 3×3 for nine, 4×3 for
  twelve, capped at 5 columns — the lounge zone follows the work floor, and the scene scale
  clamps lower so a large install still fits the canvas.
- README uninstall instructions no longer use `rm -rf "$HERMES_HOME/..."` (the install
  scanner flagged it as `destructive_home_rm`); use `hermes plugins remove office-3d`.
- `desktop/plugin.js` header comment no longer claims offline profiles are drawn greyed-out
  in the lounge (they are not drawn at all — empty desk, dark monitor).

### Changed
- The poll interval is now a setting (default still 5s). The office page and the status-bar
  chip share one React Query key, so they never poll twice.
- `install.sh` now copies the single package folder; `install.ps1` was removed (Windows is
  unsupported — see the safety note under 1.0.3).

## [1.0.3] - 2026-10-22

### Changed
- **Catalog-ready unified-package layout.** The repo is now one installable folder:
  `plugin.yaml` + `__init__.py` + `desktop/plugin.js` + `dashboard/{manifest.json,plugin_api.py}`.
  The old two-target split (`desktop-plugins/office-3d/` + `plugins/office-3d/dashboard/`)
  is gone — the Desktop app copies `desktop/plugin.js` into
  `$HERMES_HOME/desktop-plugins/office-3d/` itself.
- Added `plugin.yaml` manifest (name, version, description, author, license,
  `requires_hermes: ">=0.20.0"`, `kind: standalone`, `platforms: [linux, macos]`).
- `requires_hermes` corrected to `>=0.20.0` (the unified-package desktop door landed in
  0.20.0; the README previously claimed 0.17.0+).

### Fixed
- **Windows safety.** `_pid_alive()` judges profile liveness with `os.kill(pid, 0)`. On
  Windows every signal other than `CTRL_C_EVENT`/`CTRL_BREAK_EVENT` is routed through
  `TerminateProcess`, so that call would **kill** the target process (the gateway). The
  check now refuses to run on Windows and the manifest declares `platforms: [linux, macos]`.

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
