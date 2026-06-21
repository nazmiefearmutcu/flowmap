"""
FlowMap Density Engine — Pure NumPy heatmap rendering engine.
No Qt imports. Produces RGBA uint8 buffers for the Bookmap-style heatmap.
"""

from .color_system import ColorSystem
from .normalizer import AdaptiveNormalizer
from .config import EngineConfig
from .density_engine import DensityEngine

__all__ = ["DensityEngine", "ColorSystem", "AdaptiveNormalizer", "EngineConfig"]
