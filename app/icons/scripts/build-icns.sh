#!/usr/bin/env bash
#
# build-icns.sh — rasterize the hand-authored FlowMap SVG into a macOS .icns
# plus the PNG exports used by Tauri and the browser favicon.
#
# Rasterizer preference: rsvg-convert (librsvg, crisp) -> resvg -> qlmanage.
# sips cannot read SVG directly, so it is only used as a last-resort PNG resizer
# from a single high-res render.
#
set -euo pipefail

ICONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG="$ICONS_DIR/flowmap.svg"
SET="$ICONS_DIR/FlowMap.iconset"
ICNS="$ICONS_DIR/FlowMap.icns"

[ -f "$SVG" ] || { echo "error: source SVG not found: $SVG" >&2; exit 1; }

# --- pick a rasterizer -------------------------------------------------------
RASTER=""
if command -v rsvg-convert >/dev/null 2>&1; then
  RASTER="rsvg"
elif command -v resvg >/dev/null 2>&1; then
  RASTER="resvg"
elif command -v qlmanage >/dev/null 2>&1; then
  RASTER="qlmanage"
else
  echo "error: no SVG rasterizer found (need rsvg-convert, resvg or qlmanage)." >&2
  echo "       install one, e.g.: brew install librsvg" >&2
  exit 1
fi
echo "rasterizer: $RASTER"

# render SVG -> PNG at an exact square size:  render <size> <out.png>
render() {
  local size="$1" out="$2"
  case "$RASTER" in
    rsvg)  rsvg-convert -w "$size" -h "$size" -o "$out" "$SVG" ;;
    resvg) resvg -w "$size" -h "$size" "$SVG" "$out" ;;
    qlmanage)
      local tmp; tmp="$(mktemp -d)"
      qlmanage -t -s "$size" -o "$tmp" "$SVG" >/dev/null 2>&1
      mv "$tmp/$(basename "$SVG").png" "$out"
      rm -rf "$tmp"
      # qlmanage may letterbox; normalise to an exact square
      sips -z "$size" "$size" "$out" >/dev/null 2>&1
      ;;
  esac
}

# --- build the iconset -------------------------------------------------------
rm -rf "$SET"
mkdir -p "$SET"

# Apple iconset layout: <logical>x<logical>[@2x] -> pixel size
#   16   16@2x=32   32   32@2x=64   128   128@2x=256   256   256@2x=512   512   512@2x=1024
render 16   "$SET/icon_16x16.png"
render 32   "$SET/icon_16x16@2x.png"
render 32   "$SET/icon_32x32.png"
render 64   "$SET/icon_32x32@2x.png"
render 128  "$SET/icon_128x128.png"
render 256  "$SET/icon_128x128@2x.png"
render 256  "$SET/icon_256x256.png"
render 512  "$SET/icon_256x256@2x.png"
render 512  "$SET/icon_512x512.png"
render 1024 "$SET/icon_512x512@2x.png"

# --- pack the .icns ----------------------------------------------------------
iconutil -c icns "$SET" -o "$ICNS"

# --- standalone PNG exports (Tauri / favicon / review) -----------------------
render 1024 "$ICONS_DIR/icon-1024.png"
render 512  "$ICONS_DIR/icon-512.png"
render 32   "$ICONS_DIR/icon-32.png"

echo "---"
echo "wrote: $ICNS"
file "$ICNS"
ls -lh "$ICNS" "$ICONS_DIR/icon-1024.png" "$ICONS_DIR/icon-512.png" "$ICONS_DIR/icon-32.png"
