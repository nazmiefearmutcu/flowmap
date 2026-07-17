"""Feed abstraction shared by all data sources (M1 T6 sim, T9 crypto, ...).

A feed is an async stream of canonical events:

- :class:`BookState` — full L2 snapshot (price/size arrays per side). This is
  a feed-layer type only; the grid consumes it via ``Grid.on_book`` and the
  wire never carries it.
- :class:`~flowmap_server.proto.events.Trade` and
  :class:`~flowmap_server.proto.events.Marker` are reused from proto.events
  (NOT duplicated) so downstream code speaks one dialect.

The :class:`Feed` protocol is deliberately minimal: an ``events()`` async
iterator plus ``market`` / ``symbol`` / ``capability`` attributes. ``events()``
is declared as a plain ``def`` returning ``AsyncIterator`` — that is the shape
an ``async def`` generator method presents to callers.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol, runtime_checkable

import msgspec
import numpy as np

from flowmap_server.proto.events import BBO, Marker, Trade

__all__ = ["BookState", "Feed", "FeedEvent"]


class BookState(msgspec.Struct):
    """Full order-book snapshot observed at ``ts_ns``.

    ``bid_px``/``bid_sz`` and ``ask_px``/``ask_sz`` are parallel float64
    arrays; levels need not be contiguous or sorted (the grid scatters by
    price). Producers must emit finite values only.
    """

    ts_ns: int
    bid_px: np.ndarray
    bid_sz: np.ndarray
    ask_px: np.ndarray
    ask_sz: np.ndarray


FeedEvent = BookState | Trade | Marker | BBO


@runtime_checkable
class Feed(Protocol):
    """Minimal contract every feed (sim, crypto, equity) implements."""

    market: str
    symbol: str
    capability: dict[str, object]

    def events(self) -> AsyncIterator[FeedEvent]: ...
