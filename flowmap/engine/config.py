"""Engine configuration dataclass for DensityEngine parameters."""

from dataclasses import dataclass, field


@dataclass
class EngineConfig:
    """Configuration for DensityEngine.

    All parameters have sensible defaults tuned for Bookmap-style rendering.
    """

    max_levels: int = 50
    history_width: int = 600
    decay: float = 0.92
    depth_levels: int = 15
    density_threshold: float = 0.01
    spacing_min: int = 2
    bid_ref: float = 20000.0
    ask_ref: float = 20000.0
    vertical_smoothing: float = 1.0
    centering_mode: str = "smooth_deadband"
    centering_ema_alpha: float = 0.05
    centering_deadband_pct: float = 0.35
    ticks_per_row: int = 1

