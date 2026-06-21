"""
Core data types for FlowMap — market data primitives.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum, auto
import time as time_module


class Side(Enum):
    BID = auto()
    ASK = auto()
    BUY = auto()
    SELL = auto()


class OrderType(Enum):
    LIMIT = auto()
    MARKET = auto()
    STOP = auto()
    ICEBERG = auto()


@dataclass(slots=True, frozen=True)
class Level2Snapshot:
    """A snapshot of the order book at a point in time."""
    timestamp: float  # unix timestamp in seconds
    symbol: str
    bids: tuple[tuple[float, float], ...]  # (price, size) tuples
    asks: tuple[tuple[float, float], ...]
    bid_depth: int = 10
    ask_depth: int = 10
    receive_timestamp: float = 0.0


@dataclass(slots=True, frozen=True)
class Level2Update:
    """An incremental update to the order book."""
    timestamp: float
    symbol: str
    side: Side
    price: float
    size: float  # 0 = remove the level
    receive_timestamp: float = 0.0


@dataclass(slots=True, frozen=True)
class Trade:
    """An executed trade."""
    timestamp: float
    symbol: str
    price: float
    size: float
    side: Side  # BUY or SELL (aggressor side)
    trade_id: Optional[str] = None
    is_liquidation: bool = field(default=False, kw_only=True)
    receive_timestamp: float = field(default=0.0, kw_only=True)


@dataclass(slots=True, frozen=True)
class BBO:
    """Best Bid & Offer."""
    timestamp: float
    symbol: str
    bid: float
    ask: float
    bid_size: float
    ask_size: float
    spread: float = 0.0
    receive_timestamp: float = 0.0

    def __post_init__(self):
        if self.spread == 0.0 and self.bid > 0 and self.ask > 0:
            object.__setattr__(self, 'spread', self.ask - self.bid)


@dataclass(slots=True, frozen=True)
class Quote:
    """Top-level quote update."""
    timestamp: float
    symbol: str
    bid: float
    ask: float
    last: float
    volume: float
    change: float = 0.0
    change_pct: float = 0.0


@dataclass(slots=True, frozen=True)
class BookLevel:
    """
    A single price level in the order book with aggregated data.
    Used by the heatmap renderer.
    """
    price: float
    bid_size: float = 0.0
    ask_size: float = 0.0
    trade_volume: float = 0.0  # Cumulative trade volume at this level
    trade_count: int = 0
    last_trade_side: Optional[Side] = None
    delta: float = 0.0  # Bid - Ask imbalance
    max_size: float = 0.0  # Historical max (for normalization)

    @property
    def total_size(self) -> float:
        return self.bid_size + self.ask_size

    @property
    def imbalance(self) -> float:
        """Positive = bid-heavy, negative = ask-heavy."""
        total = self.bid_size + self.ask_size
        if total == 0:
            return 0.0
        return (self.bid_size - self.ask_size) / total


def now() -> float:
    """High-precision monotonic timestamp."""
    return time_module.time()


from flowmap.core.order_book import OrderBook
from flowmap.core.config import AppConfig, DEFAULT_CONFIG
from flowmap.core.events import EventBus, Event, EventType, bus
