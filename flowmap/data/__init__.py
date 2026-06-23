"""
Market data providers — real-time & simulated sources.
"""

from __future__ import annotations

from .base import DataProvider
from .config import EXCHANGE_CONFIG, ExchangeCfg
from .crypto import CryptoProvider
from .manager import DataManager
from .simulator import MarketSimulator

# Optional: CrypcodileReplay & CrypcodileLive providers
try:
    from .crypcodile_replay import CrypcodileReplayProvider
    from .crypcodile_live import CrypcodileLiveProvider
    HAS_CRYPCODILE = True
except ImportError:
    CrypcodileReplayProvider = None
    CrypcodileLiveProvider = None
    HAS_CRYPCODILE = False

__all__ = [
    "DataProvider",
    "CryptoProvider",
    "DataManager",
    "MarketSimulator",
    "CrypcodileReplayProvider",
    "CrypcodileLiveProvider",
    "HAS_CRYPCODILE",
    "EXCHANGE_CONFIG",
    "ExchangeCfg",
]
