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
#   7. hdiutil + Finder → FlowMap.dmg     (designed background, drag-to-Applications layout)
#
# Env toggles (default = full clean build):
#   SKIP_NPM_CI=1     reuse the existing client/node_modules (just `npm run build`)
#   SKIP_PYRUNTIME=1  reuse an already-bundled app/src-tauri/resources/pyruntime
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_DIR="$REPO_ROOT/client"
TAURI_DIR="$REPO_ROOT/app/src-tauri"
PYRUNTIME="$TAURI_DIR/resources/pyruntime"
DMG_ART="$REPO_ROOT/app/icons/dmg"          # bg-<arch>.png (660x440) + @2x (1320x880)
export PATH="$HOME/.cargo/bin:$PATH"

VERSION="1.3.0"

# Arch-aware so the same script drives both the Apple-Silicon (macos-14) and
# Intel (macos-13) release runners as well as a local machine of either arch.
case "$(uname -m)" in
  arm64)  TARGET_TRIPLE="aarch64-apple-darwin"; DMG_ARCH="aarch64" ;;
  x86_64) TARGET_TRIPLE="x86_64-apple-darwin";  DMG_ARCH="x86_64"  ;;
  *) echo "ERROR: unsupported macOS arch $(uname -m)" >&2; exit 1 ;;
esac

APP_PATH="$TAURI_DIR/target/release/bundle/macos/FlowMap.app"
DMG_DIR="$TAURI_DIR/target/release/bundle/dmg"
DMG_PATH="$DMG_DIR/FlowMap_${VERSION}_${DMG_ARCH}.dmg"
VOLNAME="FlowMap"

echo "==> [1/7] Building the client (client/dist)"
cd "$CLIENT_DIR"
if [[ "${SKIP_NPM_CI:-}" == "1" ]]; then
  echo "    SKIP_NPM_CI=1 → reusing node_modules"
else
  npm ci
fi
npm run build

echo "==> [2/7] Bundling the Python runtime ($TARGET_TRIPLE)"
if [[ "${SKIP_PYRUNTIME:-}" == "1" && -x "$PYRUNTIME/bin/python3.13" ]]; then
  echo "    SKIP_PYRUNTIME=1 → reusing $PYRUNTIME"
else
  bash "$REPO_ROOT/app/scripts/bundle-python.sh" "$TARGET_TRIPLE"
fi

echo "==> [3/7] Generating the Tauri icon set"
cd "$TAURI_DIR"
cargo tauri icon ../icons/icon-1024.png >/dev/null

echo "==> [4/7] cargo tauri build --bundles app (release; first run is slow)"
cargo tauri build --bundles app

[[ -d "$APP_PATH" ]] || { echo "ERROR: $APP_PATH not produced" >&2; exit 1; }

echo "==> [5/7] Injecting the pyruntime into the .app"
# macOS deliberately injects the pyruntime via `ditto` (symlink- and
# metadata-preserving) rather than Tauri's `bundle.resources`: the base
# tauri.conf.json carries NO resources key, so `cargo tauri build` above does
# not copy the ~529 MB tree — no double-copy. (Windows/Linux DO use
# bundle.resources, declared in tauri.windows.conf.json / tauri.linux.conf.json,
# because those runners have no ditto step.) The rm -rf makes this idempotent.
rm -rf "$APP_PATH/Contents/Resources/pyruntime"
ditto "$PYRUNTIME" "$APP_PATH/Contents/Resources/pyruntime"

echo "==> [6/7] Deep ad-hoc codesign (no Developer ID available)"
# Ad-hoc, WITHOUT the hardened runtime, so the bundled unsigned dylibs/.so load
# freely (library validation is not enforced for an ad-hoc, non-hardened bundle).
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --verbose=1 "$APP_PATH" 2>&1 | tail -2 || true

echo "==> [7/7] Building the DMG (designed background + drag-to-Applications layout)"
# A plain `hdiutil create -format UDZO` cannot carry a window layout: the icon
# positions, window size and background picture live in the volume's .DS_Store,
# which only Finder can write. So: stage → UDRW image → mount → tell Finder the
# layout → detach → convert to a compressed, read-only UDZO.
# One background per architecture: the artwork names the CPU in its subtitle, so
# the Intel image must not ship the Apple-Silicon plate. Regenerate both with
# `python3 app/icons/dmg/make-bg.py <version> --all` when the version changes.
BG_1X="$DMG_ART/bg-${DMG_ARCH}.png"
BG_2X="$DMG_ART/bg-${DMG_ARCH}@2x.png"
[[ -f "$BG_1X" && -f "$BG_2X" ]] || {
  echo "ERROR: missing $BG_1X or $BG_2X (run app/icons/dmg/make-bg.py)" >&2; exit 1; }

mkdir -p "$DMG_DIR"
STAGING="$(mktemp -d)"
ditto "$APP_PATH" "$STAGING/FlowMap.app"
ln -s /Applications "$STAGING/Applications"

# One HiDPI TIFF holding both reps — Finder picks 1x or 2x per display, so the
# background stays crisp on Retina without being half-size on a 1x screen.
mkdir -p "$STAGING/.background"
tiffutil -cathidpicheck "$BG_1X" "$BG_2X" \
  -out "$STAGING/.background/background.tiff" >/dev/null

RW_TMP="$(mktemp -d)"
RW_DMG="$RW_TMP/FlowMap-rw.dmg"
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGING" -fs HFS+ \
  -format UDRW -ov "$RW_DMG" >/dev/null

hdiutil detach "/Volumes/$VOLNAME" >/dev/null 2>&1 || true
hdiutil attach "$RW_DMG" -readwrite -noverify -noautoopen >/dev/null
sleep 2

# Window bounds are {left, top, right, bottom} in SCREEN coords and include the
# ~28 px title bar, so 660x468 gives the 660x440 content area the artwork is
# drawn for. `set position` takes each icon's CENTRE in view coords — the two
# values below are exactly where the artwork's drop targets are painted.
osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 160, 860, 628}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set text size of opts to 11
    set label position of opts to bottom
    set background picture of opts to file ".background:background.tiff"
    set position of item "FlowMap.app" of container window to {140, 237}
    set position of item "Applications" of container window to {519, 237}
    close
    open
    update without registering applications
    delay 2
  end tell
end tell
APPLESCRIPT

chmod -Rf go-w "/Volumes/$VOLNAME" 2>/dev/null || true
sync
hdiutil detach "/Volumes/$VOLNAME" >/dev/null

rm -f "$DMG_PATH"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" >/dev/null
rm -rf "$STAGING" "$RW_TMP"

APP_SIZE="$(du -sh "$APP_PATH" | cut -f1)"
DMG_SIZE="$(du -sh "$DMG_PATH" | cut -f1)"
echo ""
echo "==> DONE"
echo "    FlowMap.app : $APP_PATH  ($APP_SIZE)"
echo "    FlowMap.dmg : $DMG_PATH  ($DMG_SIZE)"
echo ""
echo "    First run (unsigned/unnotarized): right-click → Open, or"
echo "    xattr -cr /Applications/FlowMap.app"
