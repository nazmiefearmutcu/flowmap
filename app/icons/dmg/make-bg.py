#!/usr/bin/env python3
"""Render the DMG background from the design plate.

`plate.png` / `plate@2x.png` hold the artwork with every piece of *dynamic* text
removed — wordmark, candles, arrow, drop-target and grid only. This script draws
the text back on:

  * the subtitle, which carries the version and the CPU architecture, and
  * the two instruction lines under the drop targets.

Keeping the text out of the plate is what lets one design serve both the Apple
Silicon and the Intel disk image: baking "APPLE SILICON" into the artwork made
the Intel DMG claim the wrong CPU, and baking the version made every release
ship a stale number.

Typography was measured off the original design so the output is
pixel-compatible with it: Menlo, 24 px at @2x for the instruction lines and
20 px for the subtitle, baselines at y=768.5 / 822.5 / 155.5 (@2x), instruction
lines centred on the canvas, subtitle left-aligned at x=69 (@2x) with ~2.8 px of
tracking.

Usage:
    python3 make-bg.py 1.3.0                 # → bg-aarch64.png (+@2x)
    python3 make-bg.py 1.3.0 --arch x86_64   # → bg-x86_64.png  (+@2x)
    python3 make-bg.py 1.3.0 --all           # both

Requires Pillow. Run it when the version changes and commit the result — the
build script consumes the committed PNGs so `build-dmg.sh` needs no Python.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - dev-time dependency only
    sys.exit("Pillow is required: python3 -m pip install --user pillow")

HERE = Path(__file__).resolve().parent

MENLO = "/System/Library/Fonts/Menlo.ttc"
MENLO_REGULAR, MENLO_BOLD = 0, 1

# Colours sampled from the delivered design.
DIM = (95, 138, 108)        # subtitle + secondary instruction line
BODY = (143, 181, 154)      # primary instruction line
BRIGHT = (234, 255, 240)    # the emphasised "Applications"

# @2x geometry (halved for the 1x rendition).
SUB_SIZE, SUB_BASELINE, SUB_X, SUB_TRACK = 20, 155.5, 69, 2.8
LINE_SIZE = 24
LINE1_BASELINE, LINE2_BASELINE = 768.5, 822.5

ARCH_LABEL = {"aarch64": "APPLE SILICON", "x86_64": "INTEL"}

# The instruction copy. English only — this is a public, English-language app.
LINE1_PREFIX, LINE1_EMPH, LINE1_SUFFIX = "Drag FlowMap to the ", "Applications", " folder"
LINE2 = "Unsigned build — on first launch: right-click → Open"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(MENLO, size, index=MENLO_BOLD if bold else MENLO_REGULAR)


def draw_tracked(draw: ImageDraw.ImageDraw, xy, text, fnt, fill, tracking: float) -> None:
    """Draw `text` with extra letter spacing, baseline-anchored at `xy`."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill, anchor="ls")
        x += fnt.getlength(ch) + tracking


def render(version: str, arch: str, scale: int) -> Image.Image:
    plate = HERE / ("plate@2x.png" if scale == 2 else "plate.png")
    im = Image.open(plate).convert("RGB")
    d = ImageDraw.Draw(im)
    k = scale / 2  # geometry above is @2x

    subtitle = f"ORDER-FLOW VISUALIZER · {version} · {ARCH_LABEL[arch]}"
    draw_tracked(
        d, (SUB_X * k, SUB_BASELINE * k), subtitle,
        font(max(1, round(SUB_SIZE * k))), DIM, SUB_TRACK * k,
    )

    reg, bold = font(round(LINE_SIZE * k)), font(round(LINE_SIZE * k), bold=True)
    # Centre the whole of line 1 as one run, then lay its three segments down in
    # order so the emphasised word keeps the monospace rhythm.
    widths = [reg.getlength(LINE1_PREFIX), bold.getlength(LINE1_EMPH), reg.getlength(LINE1_SUFFIX)]
    x = im.width / 2 - sum(widths) / 2
    for text, fnt, fill, w in zip(
        (LINE1_PREFIX, LINE1_EMPH, LINE1_SUFFIX), (reg, bold, reg), (BODY, BRIGHT, BODY), widths
    ):
        d.text((x, LINE1_BASELINE * k), text, font=fnt, fill=fill, anchor="ls")
        x += w

    d.text((im.width / 2, LINE2_BASELINE * k), LINE2, font=reg, fill=DIM, anchor="ms")
    return im


def main() -> None:
    ap = argparse.ArgumentParser(description="Render the FlowMap DMG background.")
    ap.add_argument("version", help="version string shown in the subtitle, e.g. 1.3.0")
    ap.add_argument("--arch", choices=sorted(ARCH_LABEL), default="aarch64")
    ap.add_argument("--all", action="store_true", help="render every architecture")
    args = ap.parse_args()

    for arch in (sorted(ARCH_LABEL) if args.all else [args.arch]):
        for scale, suffix in ((1, ""), (2, "@2x")):
            out = HERE / f"bg-{arch}{suffix}.png"
            render(args.version, arch, scale).save(out)
            print(f"wrote {out.name}")

    # The version is *pixels* once rendered, so nothing downstream can read it
    # back off the PNG. Stamp it beside the art instead: build-dmg.sh compares
    # this against tauri.conf.json and refuses to ship a disk image whose window
    # advertises a different version than the app it contains.
    if args.all:
        stamp = HERE / "RENDERED_VERSION"
        stamp.write_text(args.version + "\n")
        print(f"wrote {stamp.name} ({args.version})")


if __name__ == "__main__":
    main()
