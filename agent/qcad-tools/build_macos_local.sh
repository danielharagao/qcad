#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
QT_DIR="$ROOT_DIR/.qt"
QT_VERSION="${QT_VERSION:-5.15.2}"
QT_ARCH="${QT_ARCH:-clang_64}"
QT_INSTALL_METHOD="${QT_INSTALL_METHOD:-aqt}"
ARCH_SUFFIX="$(uname -m)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This build script must be run on macOS."
  exit 1
fi

cd "$ROOT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required."
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are required. Run: xcode-select --install"
  exit 1
fi

if [[ "$QT_INSTALL_METHOD" == "brew" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required when QT_INSTALL_METHOD=brew."
    exit 1
  fi
  brew list qt@5 >/dev/null 2>&1 || brew install qt@5
  export PATH="$(brew --prefix qt@5)/bin:$PATH"
else
  VENV_DIR="$ROOT_DIR/.qt-venv"
  if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    python3 -m venv "$VENV_DIR"
  fi
  "$VENV_DIR/bin/pip" install --upgrade aqtinstall
  "$VENV_DIR/bin/python" -m aqt install-qt mac desktop "$QT_VERSION" "$QT_ARCH" -O "$QT_DIR" -m qtscript
  export PATH="$QT_DIR/$QT_VERSION/$QT_ARCH/bin:$PATH"
fi

qmake -v
qmake CONFIG+=release qcad.pro
make -j"$(sysctl -n hw.ncpu)"

APP_PATH="$(find "$ROOT_DIR" -path '*/QCAD.app' -type d | head -n 1)"
if [[ -z "$APP_PATH" ]]; then
  echo "QCAD.app not found after build."
  find "$ROOT_DIR" -maxdepth 4 -type d -name '*.app' -print
  exit 1
fi

macdeployqt "$APP_PATH" -verbose=2

mkdir -p "$APP_PATH/Contents/Resources/architect-copilot"
cp -R "$ROOT_DIR/agent" "$APP_PATH/Contents/Resources/architect-copilot/"

# Ensure the Architect Copilot addon is bundled where QCAD loads scripts from.
ADDON_DST="$APP_PATH/Contents/Resources/scripts/Tools/ArchitectCopilot"
mkdir -p "$ADDON_DST"
cp -R "$ROOT_DIR/scripts/Tools/ArchitectCopilot/." "$ADDON_DST/"
find "$ADDON_DST" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

codesign --force --sign - --deep "$APP_PATH" >/dev/null 2>&1 || true

rm -rf "$DIST_DIR/dmg-root"
mkdir -p "$DIST_DIR/dmg-root"
cp -R "$APP_PATH" "$DIST_DIR/dmg-root/"
ln -s /Applications "$DIST_DIR/dmg-root/Applications"

DMG="$DIST_DIR/qcad-architect-copilot-macos-$ARCH_SUFFIX.dmg"
hdiutil create \
  -volname "QCAD Architect Copilot" \
  -srcfolder "$DIST_DIR/dmg-root" \
  -ov \
  -format UDZO \
  "$DMG"

hdiutil verify "$DMG"
shasum -a 256 "$DMG" > "$DIST_DIR/SHA256SUMS-macos.txt"
ls -lh "$DIST_DIR"
