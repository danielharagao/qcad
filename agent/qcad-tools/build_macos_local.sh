#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
QT_DIR="$ROOT_DIR/.qt"
QT_VERSION="${QT_VERSION:-5.15.2}"
QT_ARCH="${QT_ARCH:-clang_64}"

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

python3 -m pip install --user --upgrade aqtinstall
python3 -m aqt install-qt mac desktop "$QT_VERSION" "$QT_ARCH" -O "$QT_DIR"

export PATH="$QT_DIR/$QT_VERSION/$QT_ARCH/bin:$PATH"

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

rm -rf "$DIST_DIR/dmg-root"
mkdir -p "$DIST_DIR/dmg-root"
cp -R "$APP_PATH" "$DIST_DIR/dmg-root/"

hdiutil create \
  -volname "QCAD Architect Copilot" \
  -srcfolder "$DIST_DIR/dmg-root" \
  -ov \
  -format UDZO \
  "$DIST_DIR/qcad-architect-copilot-macos-x86_64.dmg"

shasum -a 256 "$DIST_DIR/qcad-architect-copilot-macos-x86_64.dmg" > "$DIST_DIR/SHA256SUMS-macos.txt"
ls -lh "$DIST_DIR"
