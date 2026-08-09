#!/usr/bin/env bash
# office-3d installer — copies the plugin into your Hermes home, enables the
# backend, and prints how to reload. Portable: honours $HERMES_HOME.
set -euo pipefail

HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "office-3d installer"
echo "  Hermes home: $HOME_DIR"

if [ ! -d "$HOME_DIR" ]; then
  echo "  ✗ $HOME_DIR not found. Is Hermes installed? (set HERMES_HOME if using a custom path)" >&2
  exit 1
fi

# 1. Frontend (desktop plugin ESM)
FE_DIR="$HOME_DIR/desktop-plugins/office-3d"
mkdir -p "$FE_DIR"
cp "$HERE/desktop-plugins/office-3d/plugin.js" "$FE_DIR/plugin.js"
echo "  ✓ frontend  -> $FE_DIR/plugin.js"

# 2. Backend (dashboard FastAPI router + manifest)
BE_DIR="$HOME_DIR/plugins/office-3d/dashboard"
mkdir -p "$BE_DIR"
cp "$HERE/plugins/office-3d/dashboard/plugin_api.py" "$BE_DIR/plugin_api.py"
cp "$HERE/plugins/office-3d/dashboard/manifest.json" "$BE_DIR/manifest.json"
echo "  ✓ backend   -> $BE_DIR/"

# 3. Enable the backend so the dashboard imports it (security gate).
if command -v hermes >/dev/null 2>&1; then
  hermes plugins enable office-3d >/dev/null 2>&1 && echo "  ✓ enabled   -> plugins.enabled += office-3d" \
    || echo "  ! could not run 'hermes plugins enable office-3d' — add 'office-3d' to plugins.enabled in config.yaml manually (must be a YAML list)"
else
  echo "  ! 'hermes' not on PATH — add 'office-3d' to plugins.enabled in $HOME_DIR/config.yaml manually (must be a YAML list)"
fi

cat <<'EOF'

Next steps to make it appear:
  • Frontend: fully quit and reopen the Hermes Desktop app
             (or ⌘K → "Reload desktop plugins"), then open the "Office"
             page from the sidebar.
  • Backend:  restart the dashboard web server so it mounts
             /api/plugins/office-3d/  (e.g. stop & start `hermes dashboard`,
             or restart your dashboard service).

Done.
EOF