"""
Color System — Precomputed RGBA look-up tables for bid/ask heatmap rendering.
Gamma=0.35 linear color ramps + alpha t^1.5 curve.
Pure NumPy, no Qt imports.
"""

import numpy as np


def build_lut(red_dominant: bool = False):
    """Build a 256-entry uint8 RGBA look-up table.

    Uses gamma=0.35 on intensity BEFORE the linear color ramp.
    Alpha follows a steep t^1.5 curve (same for bid and ask).

    Args:
        red_dominant: If False (default), builds BID LUT (green-dominant).
                      If True, builds ASK LUT (red-dominant).

    Returns:
        np.ndarray of shape (256, 4), dtype uint8.
    """
    lut = np.zeros((256, 4), dtype=np.uint8)
    for i in range(256):
        t = i / 255.0

        # Gamma-adjusted intensity
        g = t ** 0.35

        # Alpha: gentle t^0.6 curve for wide dynamic range
        # t=0.05→42, t=0.10→64, t=0.30→124, t=0.50→168, t=0.80→223, t=1.0→255
        a = int(255 * (t ** 0.6))
        a = max(0, min(255, a))

        if red_dominant:
            # ASK: Red dominant, green/blue capped
            r = int(8 + 247 * g)   # Red dominant 8..255
            gr = int(0 + 30 * g)    # G capped at 30
            b = int(0 + 15 * g)     # B capped at 15
        else:
            # BID: Green dominant, red/blue capped
            r = int(0 + 30 * g)     # R capped at 30
            b = int(0 + 15 * g)     # B capped at 15
            gr = int(8 + 247 * g)   # Green dominant 8..255

        r = max(0, min(255, r))
        gr = max(0, min(255, gr))
        b = max(0, min(255, b))

        lut[i] = [r, gr, b, a]
    return lut


def build_bookmap_lut():
    """Build a 256-entry uint8 RGBA look-up table for Bookmap heatmap.

    Transitions from transparency to white, and then to red:
    0.0 -> (10, 10, 18, 0)
    0.2 -> (100, 100, 120, 24)
    0.3 -> (150, 150, 170, 120)
    0.6 -> (240, 240, 255, 220)
    0.75 -> (255, 255, 255, 255)
    0.88 -> (255, 180, 0, 255)
    1.0 -> (255, 0, 0, 255)
    """
    lut = np.zeros((256, 4), dtype=np.uint8)
    control_points = [
        (0.0,  (10, 10, 18, 0)),
        (0.2,  (100, 100, 120, 24)),
        (0.3,  (150, 150, 170, 120)),
        (0.6,  (240, 240, 255, 220)),
        (0.75, (255, 255, 255, 255)),
        (0.88, (255, 180, 0, 255)),
        (1.0,  (255, 0, 0, 255)),
    ]
    for i in range(256):
        t = i / 255.0
        if t <= control_points[0][0]:
            c = control_points[0][1]
        elif t >= control_points[-1][0]:
            c = control_points[-1][1]
        else:
            for j in range(len(control_points) - 1):
                t0, c0 = control_points[j]
                t1, c1 = control_points[j+1]
                if t0 <= t <= t1:
                    frac = (t - t0) / (t1 - t0)
                    c = tuple(int(c0[k] + (c1[k] - c0[k]) * frac) for k in range(4))
                    break
        lut[i] = c
    return lut


def build_bookmap_bid_lut():
    """Build a 256-entry uint8 RGBA look-up table for Bookmap Bid heatmap.
    Transitions through cool colors: transparent green/blue -> teal -> emerald green -> mint.
    """
    lut = np.zeros((256, 4), dtype=np.uint8)
    control_points = [
        (0.0,  (0, 0, 0, 0)),
        (0.15, (0, 40, 80, 20)),
        (0.3,  (0, 100, 100, 70)),
        (0.5,  (0, 160, 120, 130)),
        (0.7,  (16, 185, 129, 200)),
        (0.85, (52, 211, 153, 240)),
        (1.0,  (167, 243, 208, 255)),
    ]
    for i in range(256):
        t = i / 255.0
        if t <= control_points[0][0]:
            c = control_points[0][1]
        elif t >= control_points[-1][0]:
            c = control_points[-1][1]
        else:
            for j in range(len(control_points) - 1):
                t0, c0 = control_points[j]
                t1, c1 = control_points[j+1]
                if t0 <= t <= t1:
                    frac = (t - t0) / (t1 - t0)
                    c = tuple(int(c0[k] + (c1[k] - c0[k]) * frac) for k in range(4))
                    break
        lut[i] = c
    return lut


def build_bookmap_ask_lut():
    """Build a 256-entry uint8 RGBA look-up table for Bookmap Ask heatmap.
    Transitions through warm colors: transparent red -> red/orange -> amber -> gold -> warm white.
    """
    lut = np.zeros((256, 4), dtype=np.uint8)
    control_points = [
        (0.0,  (0, 0, 0, 0)),
        (0.15, (80, 20, 0, 20)),
        (0.3,  (160, 40, 0, 70)),
        (0.5,  (220, 80, 0, 130)),
        (0.7,  (245, 158, 11, 200)),
        (0.85, (252, 211, 77, 240)),
        (1.0,  (254, 243, 199, 255)),
    ]
    for i in range(256):
        t = i / 255.0
        if t <= control_points[0][0]:
            c = control_points[0][1]
        elif t >= control_points[-1][0]:
            c = control_points[-1][1]
        else:
            for j in range(len(control_points) - 1):
                t0, c0 = control_points[j]
                t1, c1 = control_points[j+1]
                if t0 <= t <= t1:
                    frac = (t - t0) / (t1 - t0)
                    c = tuple(int(c0[k] + (c1[k] - c0[k]) * frac) for k in range(4))
                    break
        lut[i] = c
    return lut


class ColorSystem:
    """Precomputed color look-up tables and background color.

    Background: pure black (0, 0, 0, 255) for authentic Bookmap dark theme.
    BID: green-dominant linear ramp with gamma 0.35.
    ASK: red-dominant linear ramp with gamma 0.35.
    Alpha: t^1.5 steep curve for sharp transparency falloff.
    """

    # Pure black background
    BG_COLOR = np.array([0, 0, 0, 255], dtype=np.uint8)
    BID_LUT: np.ndarray = build_lut(red_dominant=False)
    ASK_LUT: np.ndarray = build_lut(red_dominant=True)
    HEATMAP_LUT: np.ndarray = build_bookmap_lut()
    BOOKMAP_BID_LUT: np.ndarray = build_bookmap_bid_lut()
    BOOKMAP_ASK_LUT: np.ndarray = build_bookmap_ask_lut()


def apply_color_lut(normalized: np.ndarray, side_mask: np.ndarray, out: np.ndarray):
    """Fast vectorized colorization using precomputed LUTs.

    Args:
        normalized: float array [0.0, 1.0] of intensity values.
        side_mask: boolean array, True for bid side.
        out: pre-allocated (N, 4) uint8 array to write RGBA into.
    """
    indices = np.clip((normalized * 255).astype(np.int32), 0, 255)
    bid_idx = indices[side_mask]
    ask_idx = indices[~side_mask]
    out[side_mask] = ColorSystem.BID_LUT[bid_idx]
    out[~side_mask] = ColorSystem.ASK_LUT[ask_idx]
