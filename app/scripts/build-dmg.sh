#!/usr/bin/env bash
#
# build-dmg.sh — end-to-end build of the self-contained FlowMap.app + FlowMap.dmg.
#
# Pipeline:
#   1. build the WebGL2 client            (client/dist, bundled as the frontend)
#   2. bundle the relocatable Python      (app/src-tauri/resources/pyruntime)
#   3. generate the Tauri icon set        (from app/icons/icon-1024.png)
#   4. cargo tauri build --bundles app    → FlowMap.app (release)
#   5. inject the pyruntime into the .app (ditto — preserves symlinks/metadata)
#   6. deep ad-hoc codesign               (no Developer ID → unsigned/ad-hoc)
#   7. hdiutil → compressed FlowMap.dmg   (drag-to-Applications layout)
#
# Env toggles (default = full clean build):
#   SKIP_NPM_CI=1     reuse the existing client/node_modules (just `npm run build`)
#   SKIP_PYRUNTIME=1  reuse an already-bundled app/src-tauri/resources/pyruntime
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_DIR="$REPO_ROOT/client"
TAURI_DIR="$REPO_ROOT/app/src-tauri"
PYRUNTIME="$TAURI_DIR/resources/pyruntime"
export PATH="$HOME/.cargo/bin:$PATH"

VERSION="1.2.0"
APP_PATH="$TAURI_DIR/target/release/bundle/macos/FlowMap.app"
DMG_DIR="$TAURI_DIR/target/release/bundle/dmg"
DMG_PATH="$DMG_DIR/FlowMap_${VERSION}_aarch64.dmg"

echo "==> [1/7] Building the client (client/dist)"
cd "$CLIENT_DIR"
if [[ "${SKIP_NPM_CI:-}" == "1" ]]; then
  echo "    SKIP_NPM_CI=1 → reusing node_modules"
else
  npm ci
fi
npm run build

echo "==> [2/7] Bundling the Python runtime"
if [[ "${SKIP_PYRUNTIME:-}" == "1" && -x "$PYRUNTIME/bin/python3.13" ]]; then
  echo "    SKIP_PYRUNTIME=1 → reusing $PYRUNTIME"
else
  bash "$REPO_ROOT/app/scripts/bundle-python.sh"
fi

echo "==> [3/7] Generating the Tauri icon set"
cd "$TAURI_DIR"
cargo tauri icon ../icons/icon-1024.png >/dev/null

echo "==> [4/7] cargo tauri build --bundles app (release; first run is slow)"
cargo tauri build --bundles app

[[ -d "$APP_PATH" ]] || { echo "ERROR: $APP_PATH not produced" >&2; exit 1; }

echo "==> [5/7] Injecting the pyruntime into the .app"
rm -rf "$APP_PATH/Contents/Resources/pyruntime"
ditto "$PYRUNTIME" "$APP_PATH/Contents/Resources/pyruntime"

echo "==> [6/7] Deep ad-hoc codesign (no Developer ID available)"
# Ad-hoc, WITHOUT the hardened runtime, so the bundled unsigned dylibs/.so load
# freely (library validation is not enforced for an ad-hoc, non-hardened bundle).
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --verbose=1 "$APP_PATH" 2>&1 | tail -2 || true

echo "==> [7/7] Building the DMG (hdiutil, compressed, /Applications symlink)"
mkdir -p "$DMG_DIR"
STAGING="$(mktemp -d)"
ditto "$APP_PATH" "$STAGING/FlowMap.app"
ln -s /Applications "$STAGING/Applications"
rm -f "$DMG_PATH"
hdiutil create \
  -volname "FlowMap" \
  -srcfolder "$STAGING" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$DMG_PATH" >/dev/null
rm -rf "$STAGING"

APP_SIZE="$(du -sh "$APP_PATH" | cut -f1)"
DMG_SIZE="$(du -sh "$DMG_PATH" | cut -f1)"
echo ""
echo "==> DONE"
echo "    FlowMap.app : $APP_PATH  ($APP_SIZE)"
echo "    FlowMap.dmg : $DMG_PATH  ($DMG_SIZE)"
echo ""
echo "    First run (unsigned/unnotarized): right-click → Open, or"
echo "    xattr -cr /Applications/FlowMap.app"
