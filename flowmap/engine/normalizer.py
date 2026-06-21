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
    """Fixed-reference normalizer. No adaptation — stable, predictable colors.

    Recommended: AdaptiveNormalizer(fixed_ref=8000.0) for both bid AND ask sides.
    This matches the accumulated density range (~500-8000) after 40+ ticks with
    volume_per_tick=0.25, giving a wider transparency spread (norm 0.062-1.0).
    """

    def __init__(self, fixed_ref=3000.0):
        self._global_ref = max(float(fixed_ref), 1e-9)

    def update(self, column_values: np.ndarray) -> None:
        """No-op: reference is FIXED and never changes."""
        pass

    def normalize(self, values: np.ndarray) -> np.ndarray:
        """Linear ratio clipped to [0, 1] for wide color spread.
        Replaces NaN/Inf with 0 to prevent propagation into the render buffer."""
        safe = np.nan_to_num(values, nan=0.0, posinf=self._global_ref, neginf=0.0)
        return np.clip(safe / self._global_ref, 0.0, 1.0)

    def normalize_column(self, values: np.ndarray) -> np.ndarray:
        """Alias for normalize to support backward compatibility."""
        return self.normalize(values)

    @property
    def global_ref(self) -> float:
        return self._global_ref

    @global_ref.setter
    def global_ref(self, value: float) -> None:
        self._global_ref = max(float(value), 1e-9)
