#!/usr/bin/env bash
# office-3d installer — copies this unified package into your Hermes home,
# enables the backend, and prints how to reload. Portable: honours $HERMES_HOME.
#
# The package is a single folder: the Desktop app copies desktop/plugin.js into
# $HERMES_HOME/desktop-plugins/office-3d/ by itself, so there is nothing to copy
# there by hand. POSIX only (see README → Requirements).
set -euo pipefail

HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$HOME_DIR/plugins/office-3d"

echo "office-3d installer"
echo "  Hermes home: $HOME_DIR"

if [ ! -d "$HOME_DIR" ]; then
  echo "  ✗ $HOME_DIR not found. Is Hermes installed? (set HERMES_HOME if using a custom path)" >&2
  exit 1
fi

# 1. The whole unified package (desktop half + dashboard backend + manifest).
mkdir -p "$PKG_DIR"
cp -R "$HERE/desktop" "$HERE/dashboard" "$HERE/plugin.yaml" "$PKG_DIR/"
echo "  ✓ package   -> $PKG_DIR/"

# 2. Enable the backend so the dashboard imports it (security gate).
if command -v hermes >/dev/null 2>&1; then
  hermes plugins enable office-3d >/dev/null 2>&1 && echo "  ✓ enabled   -> plugins.enabled += office-3d" \
    || echo "  ! could not run 'hermes plugins enable office-3d' — add 'office-3d' to plugins.enabled in config.yaml manually (must be a YAML list)"
else
  echo "  ! 'hermes' not on PATH — add 'office-3d' to plugins.enabled in $HOME_DIR/config.yaml manually (must be a YAML list)"
fi

cat <<'EOF'

Next steps to make it appear:
  • Desktop half: fully quit and reopen the Hermes Desktop app
                  (or ⌘K → "Reload desktop plugins"), then open the "Office"
                  page from the sidebar.
  • Backend half: restart the dashboard web server so it mounts
                  /api/plugins/office-3d/  (e.g. stop & start `hermes dashboard`,
                  or restart your dashboard service).

Done.
EOF
