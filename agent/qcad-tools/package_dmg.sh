#!/usr/bin/env bash
# Package a self-contained, distributable DMG from a working QCAD.app that
# already has the Architect Copilot addon, Qt frameworks, plugins and resources
# bundled. Use this when you have a known-good app (e.g. /Applications/QCAD.app)
# and want a fresh, verified DMG without rebuilding from source.
#
# Usage: package_dmg.sh [path-to-QCAD.app]   (default: /Applications/QCAD.app)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
ADDON_SRC="$ROOT_DIR/scripts/Tools/ArchitectCopilot"
APP_SRC="${1:-/Applications/QCAD.app}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS only."; exit 1; }
[[ -d "$APP_SRC" ]] || { echo "App not found: $APP_SRC"; exit 1; }

# Name the DMG by the APP's real architecture, not the host's (the app may be
# x86_64 running under Rosetta on an arm64 host).
APP_BIN="$APP_SRC/Contents/MacOS/QCAD"
if file "$APP_BIN" 2>/dev/null | grep -q arm64; then ARCH_SUFFIX="arm64"; else ARCH_SUFFIX="x86_64"; fi
DMG="$DIST_DIR/qcad-architect-copilot-macos-$ARCH_SUFFIX.dmg"

STAGE="$(mktemp -d)/dmg-root"
APP_DST="$STAGE/QCAD.app"
mkdir -p "$STAGE"

echo "==> Copying $APP_SRC"
cp -R "$APP_SRC" "$APP_DST"

# Refresh the addon from the repo (source of truth) so the DMG ships the latest.
ADDON_DST="$APP_DST/Contents/Resources/scripts/Tools/ArchitectCopilot"
if [[ -d "$ADDON_SRC" ]]; then
  echo "==> Refreshing addon from repo"
  mkdir -p "$ADDON_DST"
  for f in ArchitectCopilot.js qcad_plan_lib.py qcad_run_plan.py qcad_mcp_server.py setup_mcp.py setup_mcp.sh; do
    [[ -f "$ADDON_SRC/$f" ]] && cp "$ADDON_SRC/$f" "$ADDON_DST/$f"
  done
fi

# Drop dev cruft that shouldn't ship.
find "$APP_DST" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$APP_DST" -name '.DS_Store' -delete 2>/dev/null || true

echo "==> Verifying addon is present"
for f in ArchitectCopilot.js qcad_plan_lib.py qcad_run_plan.py qcad_mcp_server.py setup_mcp.py setup_mcp.sh; do
  [[ -f "$ADDON_DST/$f" ]] || { echo "MISSING addon file: $f"; exit 1; }
done

echo "==> Ad-hoc re-signing"
codesign --force --sign - --deep "$APP_DST" >/dev/null 2>&1 || true

# Drag-to-install UX.
ln -s /Applications "$STAGE/Applications"

mkdir -p "$DIST_DIR"
echo "==> Creating DMG"
hdiutil create \
  -volname "QCAD Architect Copilot" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG" >/dev/null

echo "==> Verifying DMG"
hdiutil verify "$DMG"

shasum -a 256 "$DMG" > "$DIST_DIR/SHA256SUMS-macos.txt"
rm -rf "$(dirname "$STAGE")"

echo
echo "DMG: $DMG"
ls -lh "$DMG"
echo "SHA256: $(cat "$DIST_DIR/SHA256SUMS-macos.txt")"
