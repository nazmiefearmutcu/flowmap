"""
Order Book — L2 limit order book with incremental updates.
Uses sortedcontainers for O(log n) price level operations.
"""

from __future__ import annotations
import time
from typing import Optional, Callable
from sortedcontainers import SortedDict
from . import (
    Level2Snapshot, Level2Update, Trade, BBO,
    Side, BookLevel, now
)


class OrderBook:
    """
    Real-time L2 order book with:
    - Incremental updates via L2 snapshots + deltas
    - Trade recording per price level
    - BBO tracking
    - Event callbacks on state changes
    """

    def __init__(self, symbol: str, depth: int = 20):
        self.symbol = symbol
        self.depth = depth

        # Price → size mappings
        self._bids: SortedDict = SortedDict()  # price → size (descending)
        self._asks: SortedDict = SortedDict()  # price → size (ascending)

        # Trade accumulation per price level
        self._trade_volume: dict[float, float] = {}
        self._trade_count: dict[float, int] = {}
        self._last_trade_side: dict[float, Side | None] = {}

        # Historical max sizes for normalization
        self._max_bid_size: float = 0.0
        self._max_ask_size: float = 0.0

        # BBO
        self._best_bid: float = 0.0
        self._best_ask: float = 0.0
        self._best_bid_size: float = 0.0
        self._best_ask_size: float = 0.0

        # Callbacks
        self.on_update: Optional[Callable] = None
        self.on_trade: Optional[Callable] = None
        self.on_bbo: Optional[Callable] = None

        # Total traded volume for the session
        self.total_volume: float = 0.0
        self.total_buy_volume: float = 0.0
        self.total_sell_volume: float = 0.0
        self.trade_count: int = 0

        self._last_update_time: float = now()
        self.last_receive_timestamp: float = 0.0

    # ── Snapshot / Update ──────────────────────────────────────

    def apply_snapshot(self, snap: Level2Snapshot) -> None:
        """Replace the entire order book with a snapshot."""
        self._bids.clear()
        self._asks.clear()

        for price, size in snap.bids:
            if size > 0:
                self._bids[price] = size
                self._max_bid_size = max(self._max_bid_size, size)

        for price, size in snap.asks:
            if size > 0:
                self._asks[price] = size
                self._max_ask_size = max(self._max_ask_size, size)

        self._recalc_bbo()
        self._last_update_time = snap.timestamp
        self.last_receive_timestamp = getattr(snap, 'receive_timestamp', 0.0)
        self._prune_book()

    def apply_update(self, update: Level2Update) -> None:
        """Apply an incremental L2 update."""
        book = self._bids if update.side == Side.BID else self._asks
        max_size_ref = '_max_bid_size' if update.side == Side.BID else '_max_ask_size'

        if update.size <= 0:
            # Remove level
            book.pop(update.price, None)
        else:
            book[update.price] = update.size
            current_max = getattr(self, max_size_ref)
            if update.size > current_max:
                setattr(self, max_size_ref, update.size)

        self._recalc_bbo()
        self._last_update_time = update.timestamp
        self.last_receive_timestamp = getattr(update, 'receive_timestamp', 0.0)

        self._prune_book()

        if self.on_update:
            self.on_update(update)

    def apply_updates(self, updates: list[Level2Update]) -> None:
        """Apply a batch of incremental updates and recalculate BBO once."""
        if not updates:
            return

        for update in updates:
            book = self._bids if update.side == Side.BID else self._asks
            max_size_ref = '_max_bid_size' if update.side == Side.BID else '_max_ask_size'

            if update.size <= 0:
                book.pop(update.price, None)
            else:
                book[update.price] = update.size
                current_max = getattr(self, max_size_ref)
                if update.size > current_max:
                    setattr(self, max_size_ref, update.size)

        self._recalc_bbo()
        self._last_update_time = updates[-1].timestamp
        self.last_receive_timestamp = getattr(updates[-1], 'receive_timestamp', 0.0)

        self._prune_book()

        if self.on_update:
            for update in updates:
                self.on_update(update)

    def apply_bbo(self, bbo: BBO) -> None:
        """Apply a direct BBO update."""
        if bbo.bid > 0:
            self._best_bid = bbo.bid
            self._best_bid_size = bbo.bid_size
            self._bids[bbo.bid] = bbo.bid_size
            self._max_bid_size = max(self._max_bid_size, bbo.bid_size)
            
            # Prune bids higher than the new best bid
            stale_bids = [p for p in self._bids.keys() if p > bbo.bid]
            for p in stale_bids:
                self._bids.pop(p, None)

        if bbo.ask > 0:
            self._best_ask = bbo.ask
            self._best_ask_size = bbo.ask_size
            self._asks[bbo.ask] = bbo.ask_size
            self._max_ask_size = max(self._max_ask_size, bbo.ask_size)
            
            # Prune asks lower than the new best ask
            stale_asks = [p for p in self._asks.keys() if p < bbo.ask]
            for p in stale_asks:
                self._asks.pop(p, None)

        self._last_update_time = bbo.timestamp
        self.last_receive_timestamp = getattr(bbo, 'receive_timestamp', 0.0)

        self._prune_book()

        if self.on_bbo:
            self.on_bbo(bbo)

    def record_trade(self, trade: Trade) -> None:
        """Record a trade at a price level and absorb matching resting orders."""
        price = trade.price
        self._trade_volume[price] = self._trade_volume.get(price, 0.0) + trade.size
        self._trade_count[price] = self._trade_count.get(price, 0) + 1
        self._last_trade_side[price] = trade.side

        self.total_volume += trade.size
        self.trade_count += 1

        if trade.side == Side.BUY:
            self.total_buy_volume += trade.size
            # Buy trades execute against asks (sellers) - deduct from resting asks
            target_price = None
            if price in self._asks:
                target_price = price
            else:
                for k in self._asks.keys():
                    if abs(k - price) < 0.00005:
                        target_price = k
                        break
            if target_price is not None:
                self._asks[target_price] = max(0.0, self._asks[target_price] - trade.size)
                if self._asks[target_price] <= 0.000001:
                    self._asks.pop(target_price)
        else:
            self.total_sell_volume += trade.size
            # Sell trades execute against bids (buyers) - deduct from resting bids
            target_price = None
            if price in self._bids:
                target_price = price
            else:
                for k in self._bids.keys():
                    if abs(k - price) < 0.00005:
                        target_price = k
                        break
            if target_price is not None:
                self._bids[target_price] = max(0.0, self._bids[target_price] - trade.size)
                if self._bids[target_price] <= 0.000001:
                    self._bids.pop(target_price)

        self._recalc_bbo()
        self.last_receive_timestamp = getattr(trade, 'receive_timestamp', 0.0)

        if self.on_trade:
            self.on_trade(trade)

    def record_trades(self, trades: list[Trade]) -> None:
        """Record a batch of trades and recalculate BBO once at the end."""
        if not trades:
            return

        for trade in trades:
            price = trade.price
            self._trade_volume[price] = self._trade_volume.get(price, 0.0) + trade.size
            self._trade_count[price] = self._trade_count.get(price, 0) + 1
            self._last_trade_side[price] = trade.side

            self.total_volume += trade.size
            self.trade_count += 1

            if trade.side == Side.BUY:
                self.total_buy_volume += trade.size
                # Buy trades execute against asks (sellers) - deduct from resting asks
                target_price = None
                if price in self._asks:
                    target_price = price
                else:
                    for k in self._asks.keys():
                        if abs(k - price) < 0.00005:
                            target_price = k
                            break
                if target_price is not None:
                    self._asks[target_price] = max(0.0, self._asks[target_price] - trade.size)
                    if self._asks[target_price] <= 0.000001:
                        self._asks.pop(target_price)
            else:
                self.total_sell_volume += trade.size
                # Sell trades execute against bids (buyers) - deduct from resting bids
                target_price = None
                if price in self._bids:
                    target_price = price
                else:
                    for k in self._bids.keys():
                        if abs(k - price) < 0.00005:
                            target_price = k
                            break
                if target_price is not None:
                    self._bids[target_price] = max(0.0, self._bids[target_price] - trade.size)
                    if self._bids[target_price] <= 0.000001:
                        self._bids.pop(target_price)

        self._recalc_bbo()
        self.last_receive_timestamp = getattr(trades[-1], 'receive_timestamp', 0.0)

        if self.on_trade:
            for trade in trades:
                self.on_trade(trade)

    # ── Query ──────────────────────────────────────────────────

    def get_levels(self, depth: int | None = None) -> list[BookLevel]:
        """
        Get all price levels with aggregated data for the heatmap renderer.
        Returns levels centered around the best bid/ask.
        """
        all_prices: set[float] = set()

        if depth is not None:
            # Take top N bids (highest prices) and top N asks (lowest prices)
            bid_prices = list(reversed(list(self._bids.keys())[-depth:]))
            ask_prices = list(self._asks.keys()[:depth])
            all_prices.update(bid_prices)
            all_prices.update(ask_prices)
        else:
            # Return all stored levels (which are already pruned to ±15%)
            all_prices.update(self._bids.keys())
            all_prices.update(self._asks.keys())

        if not all_prices:
            return []

        levels: list[BookLevel] = []
        for price in sorted(all_prices):
            bid_sz = self._bids.get(price, 0.0)
            ask_sz = self._asks.get(price, 0.0)
            trade_vol = self._trade_volume.get(price, 0.0)
            trade_cnt = self._trade_count.get(price, 0)
            last_side = self._last_trade_side.get(price, None)

            # Max size for normalization at this level
            max_sz = max(
                self._max_bid_size if bid_sz > 0 else 0,
                self._max_ask_size if ask_sz > 0 else 0
            )

            levels.append(BookLevel(
                price=price,
                bid_size=bid_sz,
                ask_size=ask_sz,
                trade_volume=trade_vol,
                trade_count=trade_cnt,
                last_trade_side=last_side,
                delta=bid_sz - ask_sz,
                max_size=max_sz,
            ))

        return levels

    @property
    def bbo(self) -> BBO:
        return BBO(
            timestamp=self._last_update_time,
            symbol=self.symbol,
            bid=self._best_bid,
            ask=self._best_ask,
            bid_size=self._best_bid_size,
            ask_size=self._best_ask_size,
            receive_timestamp=self.last_receive_timestamp,
        )

    @property
    def mid_price(self) -> float:
        if self._best_bid > 0 and self._best_ask > 0:
            return (self._best_bid + self._best_ask) / 2.0
        return 0.0

    @property
    def spread(self) -> float:
        if self._best_bid > 0 and self._best_ask > 0:
            return self._best_ask - self._best_bid
        return 0.0

    @property
    def imbalance(self) -> float:
        """Overall order book imbalance. Positive = more bid liquidity."""
        total_bid = sum(self._bids.values()) if self._bids else 0
        total_ask = sum(self._asks.values()) if self._asks else 0
        total = total_bid + total_ask
        if total == 0:
            return 0.0
        return (total_bid - total_ask) / total

    def get_volume_delta(self) -> float:
        """Net volume delta (buy - sell) for the session."""
        return self.total_buy_volume - self.total_sell_volume

    # ── Internal ───────────────────────────────────────────────

    def _recalc_bbo(self) -> None:
        """Recalculate best bid and ask."""
        old_bbo = BBO(self._last_update_time, self.symbol,
                      self._best_bid, self._best_ask,
                      self._best_bid_size, self._best_ask_size)

        if self._bids:
            self._best_bid = self._bids.keys()[-1]
            self._best_bid_size = self._bids[self._best_bid]
        else:
            self._best_bid = 0.0
            self._best_bid_size = 0.0

        if self._asks:
            self._best_ask = self._asks.keys()[0]
            self._best_ask_size = self._asks[self._best_ask]
        else:
            self._best_ask = 0.0
            self._best_ask_size = 0.0

        # Prune crossed stale levels
        # If best_bid >= best_ask, we have a crossed book.
        # Prune any bids >= best_ask and asks <= best_bid.
        crossed = False
        if self._best_bid > 0 and self._best_ask > 0 and self._best_bid >= self._best_ask:
            # We prune bids that are >= best_ask
            to_remove_bids = [p for p in self._bids.keys() if p >= self._best_ask]
            for p in to_remove_bids:
                self._bids.pop(p, None)
            
            # We prune asks that are <= best_bid
            to_remove_asks = [p for p in self._asks.keys() if p <= self._best_bid]
            for p in to_remove_asks:
                self._asks.pop(p, None)
                
            crossed = True

        if crossed:
            if self._bids:
                self._best_bid = self._bids.keys()[-1]
                self._best_bid_size = self._bids[self._best_bid]
            else:
                self._best_bid = 0.0
                self._best_bid_size = 0.0

            if self._asks:
                self._best_ask = self._asks.keys()[0]
                self._best_ask_size = self._asks[self._best_ask]
            else:
                self._best_ask = 0.0
                self._best_ask_size = 0.0

        new_bbo = BBO(self._last_update_time, self.symbol,
                      self._best_bid, self._best_ask,
                      self._best_bid_size, self._best_ask_size)

        if (old_bbo.bid != new_bbo.bid or old_bbo.ask != new_bbo.ask
                or old_bbo.bid_size != new_bbo.bid_size
                or old_bbo.ask_size != new_bbo.ask_size):
            if self.on_bbo:
                self.on_bbo(new_bbo)

    def reset(self) -> None:
        """Reset all state (for new symbol)."""
        self._bids.clear()
        self._asks.clear()
        self._trade_volume.clear()
        self._trade_count.clear()
        self._last_trade_side.clear()
        self._max_bid_size = 0.0
        self._max_ask_size = 0.0
        self._best_bid = 0.0
        self._best_ask = 0.0
        self._best_bid_size = 0.0
        self._best_ask_size = 0.0
        self.total_volume = 0.0
        self.total_buy_volume = 0.0
        self.total_sell_volume = 0.0
        self.trade_count = 0

    def _prune_book(self) -> None:
        """Prune bids/asks to prevent memory growth while keeping levels within ±15% of BBO mid price."""
        mid = (self._best_bid + self._best_ask) / 2.0 if (self._best_bid > 0 and self._best_ask > 0) else None
        if mid is not None:
            min_keep_price = mid * 0.85
            max_keep_price = mid * 1.15
            
            # Remove bids below min_keep_price
            while self._bids and self._bids.keys()[0] < min_keep_price:
                self._bids.popitem(0)
                
            # Remove asks above max_keep_price
            while self._asks and self._asks.keys()[-1] > max_keep_price:
                self._asks.popitem(-1)
        else:
            # Fallback to count-based pruning
            max_keep = self.depth * 5
            if len(self._bids) > max_keep:
                num_to_remove = len(self._bids) - max_keep
                keys_to_remove = list(self._bids.keys()[:num_to_remove])
                for k in keys_to_remove:
                    self._bids.pop(k, None)
            if len(self._asks) > max_keep:
                num_to_remove = len(self._asks) - max_keep
                keys_to_remove = list(self._asks.keys()[-num_to_remove:])
                for k in keys_to_remove:
                    self._asks.pop(k, None)

    def __repr__(self) -> str:
        return (f"OrderBook({self.symbol}, bids={len(self._bids)}, "
                f"asks={len(self._asks)}, bbo={self._best_bid:.2f}×{self._best_ask:.2f})")
