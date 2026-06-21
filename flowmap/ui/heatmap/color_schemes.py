"""
Color schemes for the heatmap renderer.
Maps order book sizes and deltas to colors.

Bookmap aesthetic: subtle dark greens/reds with alpha-based depth,
proper gradients, trading-floor professional look.

Gamma-corrected intensity mapping for perceptual linearity.
Pre-computed LUTs for fast QImage-based rendering.
"""

from __future__ import annotations
from enum import Enum, auto
import numpy as np
from typing import Callable


# ═══════════════════════════════════════════════════════════════════
#  Public colour constants (RGB/RGBA tuples)
# ═══════════════════════════════════════════════════════════════════

# Background
BACKGROUND_COLOR = (10, 10, 18)          # very dark blue-black (#0a0a12)
GRID_COLOR = (26, 26, 37)               # #1a1a25 — barely visible
ROW_DIVIDER_COLOR = (20, 20, 30)

# Text / axis
PRICE_TEXT_COLOR = (160, 170, 190)       # muted blue-gray
CROSSHAIR_COLOR = (200, 200, 220, 120)   # subtle white
CROSSHAIR_LABEL_BG = (30, 30, 40, 220)

# BBO highlight lines
BBO_BID_COLOR = (100, 255, 120, 200)     # bid line
BBO_ASK_COLOR = (255, 100, 90, 200)      # ask line

# Zero-line & highlights
ZERO_LINE_COLOR = (60, 60, 70, 120)
BID_HIGHLIGHT = (40, 200, 80, 35)
ASK_HIGHLIGHT = (220, 60, 60, 35)


class ColorMap(Enum):
    BOOKMAP = auto()     # Bi-color bid/ask (green/red — Bookmap authentic)
    MONO = auto()        # Single color, intensity varies (white on black)
    INFERNO = auto()     # Matplotlib inferno-style
    VIRIDIS = auto()     # Matplotlib viridis-style
    SPECTRAL = auto()    # Blue-white-red for deltas


# ═══════════════════════════════════════════════════════════════════
#  Internal helpers
# ═══════════════════════════════════════════════════════════════════

def _lerp(a: tuple[int, ...], b: tuple[int, ...], t: float) -> tuple[int, ...]:
    """Linearly interpolate between two RGBA colour tuples."""
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def _gamma_correct(t: float, gamma: float = 2.0) -> float:
    """Apply gamma correction — default 2.0 for pronounced perceptual depth."""
    if t <= 0.0:
        return 0.0
    return t ** (1.0 / gamma)


def _piecewise_lerp(t: float, control_points: list[tuple[float, tuple[int, ...]]]) -> tuple[int, ...]:
    """
    Map a normalised intensity t ∈ [0, 1] through a set of control points
    using piecewise linear interpolation.
    """
    if t <= control_points[0][0]:
        return control_points[0][1]
    if t >= control_points[-1][0]:
        return control_points[-1][1]

    for i in range(len(control_points) - 1):
        t0, c0 = control_points[i]
        t1, c1 = control_points[i + 1]
        if t0 <= t <= t1:
            frac = (t - t0) / (t1 - t0)
            return _lerp(c0, c1, frac)

    return control_points[-1][1]


# ═══════════════════════════════════════════════════════════════════
#  Bookmap gradient control points  (t ∈ [0,1] → (R,G,B,A))
#  Alpha increases with intensity for depth perception:
#    low (0.0–0.3)  → translucent        (alpha 30–130)
#    mid (0.3–0.7)  → semi-opaque        (alpha 130–230)
#    high (0.7–1.0) → nearly opaque      (alpha 230–255)
# ═══════════════════════════════════════════════════════════════════

_BID_CONTROL: list[tuple[float, tuple[int, int, int, int]]] = [
    (0.0,  (18, 45, 20, 30)),       # almost invisible
    (0.1,  (20, 60, 25, 50)),
    (0.2,  (25, 90, 30, 90)),
    (0.3,  (30, 120, 40, 130)),
    (0.4,  (34, 150, 48, 170)),
    (0.5,  (40, 180, 55, 200)),
    (0.6,  (55, 200, 65, 220)),
    (0.7,  (80, 220, 80, 230)),
    (0.8,  (130, 235, 130, 245)),
    (0.9,  (180, 250, 180, 250)),
    (0.95, (205, 253, 205, 253)),
    (1.0,  (230, 255, 230, 255)),   # white with green tint
]

_ASK_CONTROL: list[tuple[float, tuple[int, int, int, int]]] = [
    (0.0,  (45, 15, 15, 30)),       # almost invisible
    (0.1,  (60, 20, 20, 50)),
    (0.2,  (100, 28, 25, 90)),
    (0.3,  (140, 35, 30, 130)),
    (0.4,  (170, 40, 30, 170)),
    (0.5,  (200, 45, 30, 200)),
    (0.6,  (220, 55, 40, 220)),
    (0.7,  (240, 70, 50, 230)),
    (0.8,  (248, 110, 90, 245)),
    (0.9,  (255, 150, 130, 250)),
    (0.95, (255, 190, 175, 253)),
    (1.0,  (255, 230, 225, 255)),   # white with red tint
]

# Delta / CVD control points — green for positive, red for negative
_DELTA_BID_CONTROL: list[tuple[float, tuple[int, int, int, int]]] = [
    (0.0,  (18, 45, 20, 30)),
    (0.2,  (25, 100, 35, 100)),
    (0.4,  (35, 160, 50, 180)),
    (0.6,  (60, 210, 75, 225)),
    (0.8,  (140, 240, 140, 245)),
    (1.0,  (220, 255, 220, 255)),
]

_DELTA_ASK_CONTROL: list[tuple[float, tuple[int, int, int, int]]] = [
    (0.0,  (45, 15, 15, 30)),
    (0.2,  (110, 28, 25, 100)),
    (0.4,  (175, 40, 30, 180)),
    (0.6,  (225, 55, 45, 225)),
    (0.8,  (250, 120, 100, 245)),
    (1.0,  (255, 220, 210, 255)),
]


# ═══════════════════════════════════════════════════════════════════
#  Colour functions: (normalised_intensity, gamma) → (R, G, B, A)
# ═══════════════════════════════════════════════════════════════════

def bookmap_bid(intensity: float, gamma: float = 2.0) -> tuple[int, int, int, int]:
    """
    Bookmap-authentic bid gradient:
    dark forest green → grass green → white-green.
    Alpha increases with intensity for depth perception.
    """
    t = _gamma_correct(min(1.0, max(0.0, intensity)), gamma)
    return _piecewise_lerp(t, _BID_CONTROL)


def bookmap_ask(intensity: float, gamma: float = 2.0) -> tuple[int, int, int, int]:
    """
    Bookmap-authentic ask gradient:
    dark burgundy → crimson red → white-red.
    Alpha increases with intensity for depth perception.
    """
    t = _gamma_correct(min(1.0, max(0.0, intensity)), gamma)
    return _piecewise_lerp(t, _ASK_CONTROL)


def bookmap_bid_delta(intensity: float, gamma: float = 2.0) -> tuple[int, int, int, int]:
    """Green gradient for positive CVD / delta (more bids than asks)."""
    t = _gamma_correct(min(1.0, max(0.0, intensity)), gamma)
    return _piecewise_lerp(t, _DELTA_BID_CONTROL)


def bookmap_ask_delta(intensity: float, gamma: float = 2.0) -> tuple[int, int, int, int]:
    """Red gradient for negative CVD / delta (more asks than bids)."""
    t = _gamma_correct(min(1.0, max(0.0, intensity)), gamma)
    return _piecewise_lerp(t, _DELTA_ASK_CONTROL)


def mono_color(intensity: float, gamma: float = 2.0) -> tuple[int, int, int, int]:
    """
    Single-colour white-on-black intensity.
    Alpha is proportional to intensity for depth.
    """
    t = _gamma_correct(min(1.0, max(0.0, intensity)), gamma)
    # Smooth alpha ramp: starts translucent, ends near-opaque
    a = int(30 + 225 * t)
    v = int(40 + 215 * t)   # value never reaches pure 255 (avoids bloom)
    return (v, v, v, a)


# ── Trade bubble colours ──────────────────────────────────────────

def get_trade_color(side, gamma: float = 2.0) -> tuple[int, int, int, int]:
    """
    Vibrant trade execution dots.
    - Buy  → bright pop green:  (80, 255, 100, 230)
    - Sell → bright pop red:    (255, 80, 80, 230)
    """
    _ = gamma  # reserved for future use (fade curve)
    if isinstance(side, str):
        is_buy = side.upper() == 'BUY'
    elif hasattr(side, 'name'):
        is_buy = side.name == 'BUY'
    else:
        is_buy = bool(side)

    if is_buy:
        return (80, 255, 100, 230)
    else:
        return (255, 80, 80, 230)


# ── Delta / CVD colour ────────────────────────────────────────────

def get_delta_color(normalized_delta: float, gamma: float = 2.0) -> tuple[int, int, int, int]:
    """
    Get a colour for a delta value (bid − ask imbalance).
    normalized_delta ∈ [-1.0, +1.0]
      +1.0 = all bids  (green)
      −1.0 = all asks  (red)
    """
    t = abs(normalized_delta)
    if normalized_delta > 0:
        return bookmap_bid_delta(t, gamma)
    else:
        return bookmap_ask_delta(t, gamma)


# ═══════════════════════════════════════════════════════════════════
#  Matplotlib-powered colormaps  (INFERNO / VIRIDIS / SPECTRAL)
# ═══════════════════════════════════════════════════════════════════

def _matplotlib_color(intensity: float, gamma: float, cmap_name: str) -> tuple[int, int, int, int]:
    """Map intensity through a named matplotlib colormap."""
    try:
        import matplotlib.cm as mcm
        t = _gamma_correct(min(1.0, max(0.0, intensity)), gamma)
        rgba = mcm.get_cmap(cmap_name)(t)
        r = int(rgba[0] * 255)
        g = int(rgba[1] * 255)
        b = int(rgba[2] * 255)
        a = int(min(255, 30 + 225 * t))
        return (r, g, b, a)
    except ImportError:
        # Fallback to mono if matplotlib not available
        return mono_color(intensity, gamma)


def _inferno(intensity: float, gamma: float = 2.0) -> tuple[int, int, int, int]:
    return _matplotlib_color(intensity, gamma, 'inferno')


def _viridis(intensity: float, gamma: float = 2.0) -> tuple[int, int, int, int]:
    return _matplotlib_color(intensity, gamma, 'viridis')


def _spectral(intensity: float, gamma: float = 2.0) -> tuple[int, int, int, int]:
    """Spectral: blue → green → yellow → red (diverging, good for deltas)."""
    try:
        import matplotlib.cm as mcm
        t = _gamma_correct(min(1.0, max(0.0, intensity)), gamma)
        rgba = mcm.get_cmap('Spectral')(1.0 - t)  # reverse so high = red
        r = int(rgba[0] * 255)
        g = int(rgba[1] * 255)
        b = int(rgba[2] * 255)
        a = int(min(255, 30 + 225 * t))
        return (r, g, b, a)
    except ImportError:
        return mono_color(intensity, gamma)


# ── Scheme → function mapping ─────────────────────────────────────

# Each colour map maps to a (bid_func, ask_func) pair.
# For single-gradient schemes (MONO, INFERNO, VIRIDIS, SPECTRAL)
# the same function is used for both sides.
COLOR_FUNCS: dict[ColorMap, tuple[Callable, Callable]] = {
    ColorMap.BOOKMAP:  (bookmap_bid, bookmap_ask),
    ColorMap.MONO:     (mono_color, mono_color),
    ColorMap.INFERNO:  (_inferno, _inferno),
    ColorMap.VIRIDIS:  (_viridis, _viridis),
    ColorMap.SPECTRAL: (_spectral, _spectral),
}


# ═══════════════════════════════════════════════════════════════════
#  Pre-computed colour lookup tables for fast rendering
# ═══════════════════════════════════════════════════════════════════

def make_lut(color_map: ColorMap,
             size: int = 256,
             gamma: float = 2.0,
             side: str = 'bid') -> np.ndarray:
    """
    Create a (size × 4) uint8 lookup table.

    Used by the QImage-based renderer for fast pixel mapping.
    Each row is [R, G, B, A] for a given normalised intensity.
    """
    func_bid, func_ask = COLOR_FUNCS.get(
        color_map,
        (bookmap_bid, bookmap_ask)  # safe fallback
    )
    func = func_ask if side == 'ask' else func_bid

    lut = np.zeros((size, 4), dtype=np.uint8)
    for i in range(size):
        intensity = i / (size - 1)
        r, g, b, a = func(intensity, gamma)
        lut[i] = (r, g, b, a)
    return lut
