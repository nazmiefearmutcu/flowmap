"""FlowMap Application Configuration — single source of truth for all settings."""
from dataclasses import dataclass, field
from pathlib import Path
import json
import os

@dataclass
class AppConfig:
    """Master configuration for the entire FlowMap application."""
    # Engine
    max_levels: int = 50
    history_width: int = 600
    decay: float = 0.92
    depth_levels: int = 15
    bid_ref: float = 5000.0
    ask_ref: float = 5000.0
    vertical_smoothing: float = 1.0
    centering_mode: str = "ema"
    centering_ema_alpha: float = 0.05
    centering_deadband_pct: float = 0.35
    
    # Display
    row_height: int = 4
    price_axis_width: int = 62
    auto_follow: bool = True
    
    # Simulator
    base_price: float = 24500.0
    tick_size: float = 0.05
    min_size: float = 30.0
    max_size: float = 2000.0
    volume_per_tick: float = 0.25
    tick_interval_ms: int = 200
    
    # Data
    default_symbol: str = "BTC/USDT"
    sim_symbol: str = "SYNTH.NIFTY"
    
    @classmethod
    def from_json(cls, path: str) -> 'AppConfig':
        with open(path) as f:
            d = json.load(f)
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})
    
    def to_json(self, path: str) -> None:
        data = {k: getattr(self, k) for k in self.__dataclass_fields__}
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w') as f:
            json.dump(data, f, indent=2)

DEFAULT_CONFIG = AppConfig()
