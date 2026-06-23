"""
Fixed-Reference Normalizer — Stable, predictable colors for Bookmap heatmap.

Uses a UNIFORM fixed reference value (ref=8000) for both sides:
  - Bid ref=8000  → handles bid orders (density 500-8000)
  - Ask ref=8000  → handles ask orders (density 500-8000)

Linear ratio (density/ref) clipped to [0, 1] for wide color spread:
  - density=500   → 500/8000  = 0.062 → alpha ~2 (transparent ghost)
  - density=2000  → 2000/8000 = 0.25  → alpha ~32 (subtle but visible)
  - density=4000  → 4000/8000 = 0.50  → alpha ~90 (bright)
  - density=8000  → 8000/8000 = 1.00  → alpha 255 (glowing, zones only)

No adaptation — reference never changes. Pure NumPy, no Qt imports.
"""

import numpy as np


class AdaptiveNormalizer:
    """Adaptive reference normalizer. Adapts smoothly to order sizes in view.

    Uses a running EMA of the 98th percentile of non-zero order book sizes
    to dynamically scale colors so that liquidity walls are bright/glowing,
    while noise is hidden.
    """

    def __init__(self, fixed_ref=3000.0):
        self._global_ref = max(float(fixed_ref), 1e-9)
        self._ema_alpha = 0.05  # Slow adaptation to avoid color flicker
        self._initialized = False

    def update(self, column_values: np.ndarray) -> None:
        """Smoothly adapt the reference to the 98th percentile of active sizes in the column."""
        if len(column_values) == 0:
            return
        p98 = np.percentile(column_values, 98)
        if p98 > 0.01:
            if not getattr(self, "_initialized", False):
                self._global_ref = p98
                self._initialized = True
            else:
                self._global_ref = (1.0 - self._ema_alpha) * self._global_ref + self._ema_alpha * p98
            self._global_ref = max(self._global_ref, 0.1)

    def normalize(self, values: np.ndarray) -> np.ndarray:
        """Ratio clipped to [0, 1] and scaled non-linearly for higher contrast.
        Replaces NaN/Inf with 0 to prevent propagation into the render buffer."""
        safe = np.nan_to_num(values, nan=0.0, posinf=self._global_ref, neginf=0.0)
        ratio = np.clip(safe / self._global_ref, 0.0, 1.0)
        return ratio ** 2.5

    def normalize_column(self, values: np.ndarray) -> np.ndarray:
        """Alias for normalize to support backward compatibility."""
        return self.normalize(values)

    @property
    def global_ref(self) -> float:
        return self._global_ref

    @global_ref.setter
    def global_ref(self, value: float) -> None:
        self._global_ref = max(float(value), 1e-9)
        self._initialized = False
