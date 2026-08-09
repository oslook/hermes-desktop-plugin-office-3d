# office-3d — a live isometric office for Hermes Desktop

A Hermes Desktop plugin that renders your Hermes **profiles as people in an isometric office**. Each profile owns a desk; when a profile is doing real work it sits at its desk typing with a green terminal screen, when it's online but idle it relaxes in the lounge with tea 🍵, and when it's offline its desk sits empty with a dark monitor. A slim stats bar shows aggregate active sessions, tokens, and cost.

English | [中文](./README.zh-CN.md)

## Screenshot

![office-3d screenshot](./docs/screenshot.jpeg)
![office-3d screenshot](./docs/screenshot-2.jpeg)

## What it shows

| State | Meaning | In the office |
|---|---|---|
| **busy** | the profile has a session active in the last ~90s (real work) | person typing at the desk, green code on screen |
| **idle** | online but no recent session activity | person in the lounge holding tea 🍵 |
| **offline** | no live process / no recent activity | empty desk, dark monitor, dimmed name |

- Follows the Hermes light/dark theme automatically.
- Bottom stat chips: **online / busy / active sessions / tokens / agents / cost** aggregated across every profile.
- Backend reads only aggregate columns (COUNT/SUM/MAX) from each profile's `state.db` — never message contents.

## Built with

- **@hermes/plugin-sdk** — Hermes Desktop plugin API (single-file ESM, no build step)
- **Canvas 2D** — hand-rolled isometric projection (no WebGL / three.js)
- **React** via the SDK's jsx runtime — `useQuery` polling + canvas lifecycle
- **Python + FastAPI** — read-only dashboard backend at `/api/plugins/office-3d/`
- **SQLite** (read-only, stdlib only) — per-profile session / token / cost aggregates

## How it works

Three pieces (matching the three layers of a Hermes desktop plugin):

1. **Frontend** — `desktop-plugins/office-3d/plugin.js` — a single ESM file the desktop app loads at runtime (canvas 2D isometric scene; no build step).
2. **Backend** — `plugins/office-3d/dashboard/plugin_api.py` + `manifest.json` — a FastAPI router mounted at `/api/plugins/office-3d/state` by the dashboard web server. It scans each profile's `gateway_state.json` (process liveness) and `state.db` (session activity + token/cost aggregates).
3. **Enable flag** — `office-3d` must be listed in `plugins.enabled` in your `config.yaml` before the backend is imported (security gate).

The plugin is portable: `HERMES_HOME` honours `$HERMES_HOME` (falls back to `~/.hermes`), and profiles are discovered by scanning `~/.hermes/profiles/` — no names are hard-coded.

## Install

### Quick (script)

```bash
git clone https://github.com/oslook/hermes-desktop-plugin-office-3d.git
cd hermes-desktop-plugin-office-3d
bash install.sh
```

The script copies the files into your Hermes home, enables the backend, and tells you how to reload.

### Manual

```bash
# 1. Frontend
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/desktop-plugins/office-3d"
cp desktop-plugins/office-3d/plugin.js "${HERMES_HOME:-$HOME/.hermes}/desktop-plugins/office-3d/"

# 2. Backend
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins/office-3d/dashboard"
cp plugins/office-3d/dashboard/plugin_api.py plugins/office-3d/dashboard/manifest.json \
   "${HERMES_HOME:-$HOME/.hermes}/plugins/office-3d/dashboard/"

# 3. Enable the backend (writes a real YAML list into config.yaml)
hermes plugins enable office-3d
```

Then make it take effect:

- **Frontend**: fully quit and reopen the Hermes Desktop app (or ⌘K → **Reload desktop plugins**), then open the **Office** page from the sidebar.
- **Backend**: restart the dashboard web server so it mounts `/api/plugins/office-3d/`. If you run `hermes dashboard`, stop and start it again. (On a LAN/LaunchAgent setup, restart that service.)

## Requirements

- Hermes Desktop **0.17.0+** — the desktop app is required; the CLI/gateway alone does not load desktop plugins. (Developed on 0.20.0, tested down to 0.17.0.)
- The dashboard web server running (it serves `/api/plugins/...`).

## Uninstall

```bash
hermes plugins disable office-3d
rm -rf "${HERMES_HOME:-$HOME/.hermes}/desktop-plugins/office-3d"
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/office-3d"
```
Then reload desktop plugins / restart the dashboard.

## Privacy

The backend opens each profile's `state.db` **read-only** and runs only aggregate queries (COUNT/SUM/MAX) over the `sessions` table — session counts, token totals, cost, and last-activity time. It never reads message content, system prompts, or titles.

## License

MIT — see [LICENSE](./LICENSE).