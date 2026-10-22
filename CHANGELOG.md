# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-10-22

> **One release.** Every version bump after 1.2.0 was an internal iteration that never
> shipped, so they are all folded in here — the 1.4.x / 1.5.x numbers do not exist.

### Added
- **One global profile overview above the scene.** Total / Working / Idle / Offline
  use the complete backend response; Working is online with recent session activity,
  Idle is online but not working, and Offline is not online. Hide-offline filters
  only the scene and usage list, with an explicit “Showing N of M” scope notice.
- **Recorded-session usage semantics.** Ranking and details label tokens/cost as sums
  over recorded sessions, not today, this visit, or a guaranteed lifetime. Cost is
  actual USD with estimated fallback. Details name the 90-second activity window,
  unended sessions, and gateway-reported agents accurately. Selected details survive
  hiding their offline profile, with a visible explanation.
- **Responsive page hierarchy and repeatable DOM verification.** Duplicate bottom
  stats/legend are removed; narrow screens stack the scene and inspectable usage,
  while wide screens keep the side panel. Local-library React/Tailwind browser tests
  cover partitions, filtering, selection, loading/error, and 320/390/1440px layouts
  without new dependencies or claiming Electron integration.
- **Zoom and pan.** The scene used to be locked to fit-the-canvas. **⌘/Ctrl + scroll** (or
  a trackpad pinch, which browsers report as a ctrl-wheel) zooms about the pointer, so the
  desk under the cursor stays put; **drag** pans; **double-click** or the **% readout**
  returns to fit; **−/+** step the zoom (0.4×–6×, shown live as a percentage). A plain
  wheel is deliberately left alone, so the page still scrolls over the canvas. The
  transform is a pure function (`frameTransform`) shared by `drawFrame` and the zoom
  handler, so a click is hit-tested against the exact projection the pixels came from at
  any zoom — and a drag that starts on a desk no longer selects it.
- **The devices are drawn at the same fidelity as the people.** Two new primitives —
  `drawIsoBoxSoft` and `drawIsoDiscSoft` — give every face a *gradient* and light only the
  top-front edges, replacing flat fills plus a hard 1px outline all the way round (that
  outline was the "wireframe toy" look). On top of them: a **monitor** (plinth + gas neck +
  bezel panel with the glass inset, plus an additive halo drawn *behind* the panel so the
  light spills around it rather than washing over the screen), a **keyboard and mouse** on
  the desk, a **mug** on its free end, a **chair** (plinth + post + cushion + soft
  backrest), a **stool**, a **sofa**, and a **coffee table** with four legs and a top —
  the teacups stand on it instead of sinking through it.
- **Pure layout functions and a headless harness.** `deskLayout()`, `loungeLayout()`,
  `sofaDims()` and `drawSofa()` keep every piece of geometry in one place, shared by the
  drawing code and the tests. The harness asserts, across several scales: both hands lie
  outside the torso silhouette, both arms reach *downward* on screen, there is no gap
  between head and neck, and the sofa's world-space upholstery proportions. The sofa
  browser regression independently ray-tests the frontmost box at sampled pixels to verify
  both arm/back overlaps and hidden seat seams, with the saved pre-fix module as a failing
  negative control, plus pixel-level head checks and colour-pipeline guards
  (`shade()` must never return its input unchanged; every palette colour must respond).

### Changed
- **Distinct, jointed working and tea poses.** Pure `deskPose()` / `loungePose()` keep
  shoulder, elbow, wrist, head and held cup on one timeline, offset by stable profile
  identity. Working keeps the approved off-centre workstation and rear-facing head;
  fingers type smoothly out of phase with only subtle breathing (no whole-body bounce).
  Tea sitting keeps hips/feet planted, visible separated shins and shoes, a relaxed
  lap hand, and a 12-second rest/lift/sip-hold/lower cycle. The held cup stays in the
  grasp and its rim stops at the lower lip, not through the face.
- **Table cups do not animate.** The three tea-table cups stay at exactly
  `tableZ + topH`; the separate workstation mug also remains fixed on its desktop.
  Only the sitter's own held cup moves. Real-browser regression tests compare tableware
  pixels across times, with the former floating tableware as a failing negative control.
- **Repeatable pose regression.** Both themes, small/default/enlarged scales, phase
  sweeps, finite joints, palm/key contact, cup/grasp/lip geometry, hand-depth pixels and
  face gates are covered in `tests/pose-preview.py` / `tests/pose-regression.html`.
  Browser images are explicitly not Electron screenshots; the sofa oracle is unchanged.
- **Unified low-poly semi-realistic figures.** Shared human-only polygon primitives
  now draw chamfered skull/jaw, geometric hair, restrained size-gated eyes and a
  calibrated lower-lip line, broad shoulders/chest, tapered waist and seated pelvis,
  tapered jointed limbs, polygon palms/grasp and shoes. Upper-left planar lighting
  uses a small, deliberate set of faces, without black contour outlines or random
  triangulation. Clothes retain profile identity; skin/hair/trousers/shoes remain
  neutral in both themes. Furniture primitives and all layout/pose trajectories stay
  unchanged, including right-sleeve partial masking, fixed tea-arm bones and static
  tableware. Real-browser tests cover actual facet paths, jaw silhouette, feature
  ownership, full-avatar eyes, lip/rim contact and small-scale rendering; saved sphere
  and fixed-elbow builds remain failing negative controls.

- **Heads face the right way in both poses.** `drawHead` now takes a `facing` direction, in
  **screen** space, because the two poses look in genuinely different directions: the desk
  sitter faces the monitor (−y in world, which projects to up-right, 0.816/−0.577), so the
  hair stays a full cap, **no features are drawn**, and only a sliver of cheek plus one ear
  show — the back of the head; the lounge sitter faces the room (0.19, 0.98), so the face is
  drawn. Features are emitted only when the face is turned toward the viewer
  (`facing[1] > 0.45`); rear-facing heads retain a geometric hair mass with only
  a small side cheek/ear plane.
- **The sofa faces the room.** Its backrest sits on the near (+y) edge: `+y` faces the
  camera in this projection, so a backrest on the far edge turns the sofa around to face the
  viewer with its back to the room. Its full-depth arms sit at the ±x ends. The back has a
  continuous rear upholstery panel; cushion divisions belong on the seat, not the rear.
- **Lounge group placement.** The whole group — stool ring + coffee table + sofa — is
  anchored at the ZONE's centre instead of hanging off the work floor's left edge, which had
  crammed it into the first third of an 11-wide zone and left the rest of the floor empty.
- **Coffee table** widened 1.4 → 2.0 so all three teacups stand on it with an even margin
  instead of crowding the near edge.

### Fixed
- **Cancelable modifier-wheel zoom in React.** Register the canvas wheel listener
  natively with `passive: false` and remove it on unmount, instead of React's passive
  delegated `onWheel`. Ctrl/⌘ wheel now prevents browser default zoom and updates the
  scene exactly once; plain wheel remains untouched. A synchronous latest-view ref
  preserves consecutive wheel updates before React commits. Real React/Chromium
  DOM-event regressions cover cancellation, deltas, bursts, and cleanup/remount.
- **Tea sleeves no longer stretch.** Both seated arms use fixed-length two-bone
  geometry with continuous outward elbow poles: held arm 0.32/0.32, relaxed lap
  arm 0.33/0.30 world units. The cup/wrist trajectory is unchanged; elbows follow
  the lift instead of anchoring a telescoping forearm. Browser regression sweeps
  four identities, both themes and three scales, checks seam continuity and
  full-avatar eye pixels after cup/arm paint, and rejects the saved dirty
  fixed-elbow implementation as a negative control.
- **A readable workstation right sleeve cap.** Only a clipped outer upper-sleeve
  patch crosses the torso edge; shoulder root, sitter, keyboard and monitor
  coordinates are unchanged. The distant forearm stays behind the body. Pixel
  tests confine changes to the cap while retaining keyboard/hand-depth guards.
  Magenta right / cyan left diagnostic copies confirm sleeve attachment at the
  unchanged shoulder and partial torso masking at default and enlarged scale.
  Actual Canvas path endpoints are checked over 121 times × four identities ×
  three scales (5,808 arm segments), independently of pure pose-only assertions.
  Full-scene eye checks classify dark cool eye ink (not exact antialiased RGB),
  separate blinking frames, and require nonzero raster evidence at fit/enlarged zoom.
- **`hexToRgb()` only understood `#hex`.** Any colour already in `rgb()` form — e.g. the
  sofa's base, `shade(accent, -0.4)` — silently skipped the entire shading chain, so every
  face of that object came out the exact same colour and it rendered as a featureless slab
  (`shade('rgb(46, 92, 153)', -0.22)` returned its input unchanged). It now parses
  `rgb()`/`rgba()` too, so shading works for colours `shade()` itself produced.
- **Sofa construction and occlusion.** Comparing screen-top bounds of components at
  different x/y was an invalid height rule and produced an unnecessarily tall 1.42 back.
  The seat remains at 0.45, back top is 1.02, arm tops 0.70. The far arm is now painted
  before the seat and back; only the near arm is painted after the back. Seat divisions are
  painted before the opaque back so hidden lines cannot cut through it. False cushion
  divisions/top rail on the rear panel were removed. The frame fits between the arms,
  avoiding coincident solid surfaces. No people or lounge placement changed in this fix.
- **The typing pose.** In this projection "forward" (−y) also moves a point up-and-right on
  screen, so a sitter on the desk centre line put one hand inside their own torso silhouette
  (reading as "hands in the lap") while the other stretched sideways. The sitter is seated
  at the desk's **west end** — a hand only shows outside the torso when its `(x − y)` exceeds
  the torso's by ≈0.41 — the neck is framed by a **collar** with the head sitting low enough
  to cover it (a bare neck cylinder read as a bald patch), and the arms are shaded **darker**
  than the torso so a limb does not disappear into the clothes it is in front of. Both arms
  are painted **before** the torso so the body occludes the top of each arm; painted last,
  the near hand lay ON TOP of the body.
- **The face was drawn ON TOP OF THE HAIR.** The hair was painted as one big off-centre
  disc whose lower edge bowed *down* through the middle of the head, so the "hairline"
  landed below the eyes and the features — painted last — sat on the hair instead of on a
  face. The head is now built the other way round: skull → hair over the whole skull → the
  face **cut back out of the hair** (an oval biased to the front). The hairline is therefore
  an edge of the hair leaving a forehead, and the cut-out reuses the skull's own skin
  gradient so the shading stays continuous. The separate side "lock" was dropped: it left a
  visible diagonal seam at high zoom.
- **Lounge legs** are placed near-vertical **under the hip** rather than extended forward:
  "forward" also moves a point *up* the screen, so a leg reaching far forward projected back
  into the torso and disappeared.
- The stool ring's south slot no longer lands inside the sofa.

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
