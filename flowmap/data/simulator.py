"""
Market Data Simulator — generates realistic synthetic order book data
for demo mode, replicating NIFTY/BTC-style market dynamics with Bookmap-style
order accumulation, visible liquidity walls, iceberg orders, momentum runs,
and dramatic volume bursts.
"""

from __future__ import annotations
import math
import random
from typing import Optional

from PyQt6.QtCore import QObject, QTimer, pyqtSignal

from ..core import (
    Level2Snapshot, Level2Update, Trade, BBO,
    Side, now
)
from .base import DataProvider


class MarketSimulator(DataProvider):
    """
    Generates realistic synthetic market data with:
    - Tight mean-reverting price (OU process, theta=0.01)
    - Order book depth with exponential size decay from BBO (natural V-shape)
    - Momentum runs: 20-40 tick sustained directional moves
    - Liquidity accumulation: multiple persistent large orders at different depths
    - Iceberg orders: slowly replenishing orders at fixed price levels
    - Burst clustering: dramatic 5-15x volume spikes, brief (8-20 tick) duration
    - Lognormal size distribution for visible density variation (tiny to massive)
    - Occasional large sweeps that clear multiple price levels
    - Persistent accumulation zones (400-800 tick life) creating horizontal bands
    - Hard price clamping within ±3% of base price
    """

    def __init__(
        self,
        symbol: str = "SYNTH.NIFTY",
        base_price: float = 24500.0,
        tick_size: float = 0.05,
        min_size: float = 30.0,
        max_size: float = 2000.0,
        depth_levels: int = 100,
        spread_bps: float = 0.5,
        volatility: float = 0.02,
        volume_per_tick: float = 0.25,
        tick_interval_ms: int = 200,
        parent: QObject = None,
    ):
        super().__init__(parent)
        self.symbol = symbol
        self.base_price = base_price
        self.current_price = base_price
        self.tick_size = tick_size
        self.min_size = min_size
        self.max_size = max_size
        self.depth_levels = depth_levels
        self.spread_bps = spread_bps
        self.volatility = volatility
        self.volume_per_tick = volume_per_tick
        self._tick_interval_ms = tick_interval_ms

        # ── OU process parameters (tightened for Bookmap-style viz) ──
        self.theta = 0.01                        # mean reversion speed
        _safe_base = max(base_price, 1e-9)       # guard division by zero
        self.sigma = volatility * _safe_base * 0.004  # daily vol (reduced 60%)
        self.dt = 1.0 / 390                      # ~1 tick per minute
        self._safe_base = _safe_base             # cached for bias calc

        # ── Burst clustering state ──
        # DRAMATIC (5-15x) but BRIEF (8-20 ticks)
        self._burst_remaining: int = 0
        self._burst_multiplier: float = 1.0

        # ── Liquidity accumulation state ──
        # Maps (price, 'bid'|'ask') → {'remaining': int, 'multiplier': float}
        # Multiple simultaneous zones injected every 3-8 ticks
        self._accumulated_orders: dict[tuple[float, str], dict] = {}
        self._next_accumulation_tick: int = random.randint(5, 12)

        # ── Iceberg orders: orders that stay at same price, slowly replenishing ──
        # list of dicts: {price, side, base_size, remaining, replenish_rate}
        self._iceberg_orders: list[dict] = []
        self._next_iceberg_tick: int = random.randint(20, 50)

        # ── Momentum run state ──
        # 20-40 tick directional moves with 0.3-0.8 tick_size per step
        self._momentum_remaining: int = 0
        self._momentum_direction: float = 0.0
        self._momentum_step: float = 0.0

        # ── Trade clustering ──
        self._volume_profile: list[float] = self._generate_volume_profile()

        # ── Static accumulation zones (persistent liquidity walls) ──
        # Bookmap-style: large walls at key levels creating horizontal bands
        # MORE zones (10-15), LONGER life (300-800 ticks), LARGER sizes (up to 12x max_size)
        # Clustered: 2-3 groups of zones at nearby prices for hotspot effect
        zone_count = random.randint(10, 15)
        self._zones: list[dict] = []
        num_clusters = random.randint(2, 3)
        cluster_centers = []
        for _ in range(num_clusters):
            side_offset = random.randint(-15, 15)
            if side_offset == 0:
                side_offset = 1 if random.random() < 0.5 else -1
            cluster_centers.append(base_price + tick_size * side_offset * random.uniform(5, 25))

        zones_per_cluster = zone_count // num_clusters
        remainder = zone_count % num_clusters
        for ci, center in enumerate(cluster_centers):
            count = zones_per_cluster + (1 if ci < remainder else 0)
            for _ in range(count):
                offset_ticks = random.randint(-3, 3)
                price = round((center + offset_ticks * tick_size) / tick_size) * tick_size
                self._zones.append({
                    'price': price,
                    'size': max_size * random.uniform(5, 12),
                    'life': random.randint(300, 800),
                })

        # Internal state
        self._tick = 0
        self._prev_trade_price: Optional[float] = None

        # QTimer for autonomous ticking
        self._timer: Optional[QTimer] = None

    # ═══════════════════════════════════════════════════════════════
    #  Price model
    # ═══════════════════════════════════════════════════════════════

    def _generate_volume_profile(self) -> list[float]:
        """U-shaped volume profile typical of equity markets."""
        profile = []
        for i in range(390):
            t = i / 390.0
            v = 0.5 + 2.0 * (t - 0.5) ** 2 + random.uniform(-0.1, 0.1)
            profile.append(max(0.1, v))
        return profile

    def _ou_step(self) -> float:
        """Ornstein-Uhlenbeck price step with tight mean reversion."""
        drift = self.theta * (self.base_price - self.current_price)
        noise = self.sigma * math.sqrt(self.dt) * random.gauss(0, 1)
        return self.current_price + drift * self.dt + noise

    # ═══════════════════════════════════════════════════════════════
    #  Order book generation (exponential decay from BBO → V-shape)
    # ═══════════════════════════════════════════════════════════════

    def _size_at_distance(self, distance: float) -> float:
        """
        Size decays EXPONENTIALLY with distance from BBO price,
        creating a natural V-shape in the order book heatmap.
        Uses lognormal distribution for realistic size variation:
        some tiny orders, some massive — visible density variation.
        """
        base_size = self.volume_per_tick * self.max_size * 0.8
        size = base_size * math.exp(-abs(distance) * 0.08)
        # Lognormal: mu=0 gives median ~1.0, sigma=0.6 gives wide variation
        size *= random.lognormvariate(0.0, 0.3)
        size = max(self.min_size, min(self.max_size, size))
        size = min(size, 5000.0)
        return size

    def _apply_accumulation(self, price: float, side: str, size: float) -> float:
        """If a liquidity-accumulation order exists at this price, boost size."""
        key = (round(price, 6), side)
        if key in self._accumulated_orders:
            size *= self._accumulated_orders[key]['multiplier']
        return size

    def _apply_iceberg(self, price: float, side: str, size: float) -> float:
        """If an iceberg order exists at this price, contribute its visible portion."""
        rounded_price = round(price, 6)
        for iceberg in self._iceberg_orders:
            if (abs(rounded_price - round(iceberg['price'], 6)) < self.tick_size * 0.5
                    and iceberg['side'] == side
                    and iceberg['remaining'] > 0):
                visible = min(iceberg['remaining'], iceberg['base_size'] * 0.3)
                size += visible
                iceberg['remaining'] -= visible * 0.05  # slow drain from visible display
                break
        return size

    def _generate_bids(self) -> list[tuple[float, float]]:
        """Generate realistic bid levels with continuous 1-tick spacing."""
        bids = []
        price = self.current_price - self.tick_size * random.uniform(1, 2)
        price = round(price / self.tick_size) * self.tick_size

        # Random level gaps: occasional empty levels
        gap_count = random.randint(3, 6)
        gap_levels = set(random.sample(range(2, self.depth_levels), gap_count)) if self.depth_levels > 10 else set()

        for level in range(self.depth_levels):
            distance = self.current_price - price
            size = self._size_at_distance(distance)

            # Liquidity accumulation boost
            size = self._apply_accumulation(price, 'bid', size)

            # Iceberg contribution
            size = self._apply_iceberg(price, 'bid', size)

            # ── Static zone contribution (persistent liquidity walls) ──
            for zone in self._zones:
                if zone['life'] > 0 and abs(price - zone['price']) < self.tick_size * 0.1:
                    size += zone['size']
                    # Only decay the wall size when the price is close (being traded/filled)
                    if abs(self.current_price - zone['price']) < self.tick_size * 1.5:
                        zone['life'] -= 1
                        zone['size'] *= 0.98  # shrink size as it gets traded

            # Burst multiplier (dramatic but brief)
            size *= self._burst_multiplier

            # Jitter
            size *= random.uniform(0.85, 1.15)

            # BBO boost: ensure top-of-book levels are always visible
            if level == 0:
                size = max(size, 800.0)
            elif level == 1:
                size = max(size, 300.0)

            # Random level gaps: force selected levels to zero for natural look
            if level in gap_levels:
                size = 0.0

            # Cap total order size at 5000 to allow prominent liquidity walls
            size = min(size, 5000.0)

            if size > 0:
                bids.append((max(0.01, price), max(self.min_size, size)))

            # Continuous 1-tick spacing
            price -= self.tick_size
            price = round(price / self.tick_size) * self.tick_size

        # Collect any extra prices for active bids (zones, icebergs, accumulations) that were not covered
        extra_prices = set()
        for zone in self._zones:
            if zone['life'] > 0 and zone['price'] < self.current_price:
                extra_prices.add(round(zone['price'] / self.tick_size) * self.tick_size)
        for iceberg in self._iceberg_orders:
            if iceberg['remaining'] > 0 and iceberg['side'] == 'bid' and iceberg['price'] < self.current_price:
                extra_prices.add(round(iceberg['price'] / self.tick_size) * self.tick_size)
        for (acc_price, acc_side) in self._accumulated_orders:
            if acc_side == 'bid' and acc_price < self.current_price:
                extra_prices.add(round(acc_price / self.tick_size) * self.tick_size)

        existing_prices = {b[0] for b in bids}
        for ep in sorted(extra_prices, reverse=True):
            if ep not in existing_prices:
                distance = self.current_price - ep
                size = self._size_at_distance(distance)
                size = self._apply_accumulation(ep, 'bid', size)
                size = self._apply_iceberg(ep, 'bid', size)
                for zone in self._zones:
                    if zone['life'] > 0 and abs(ep - zone['price']) < self.tick_size * 0.1:
                        size += zone['size']
                        if abs(self.current_price - zone['price']) < self.tick_size * 1.5:
                            zone['life'] -= 1
                            zone['size'] *= 0.98
                size *= self._burst_multiplier
                size *= random.uniform(0.85, 1.15)
                size = min(size, 5000.0)
                if size > 0:
                    bids.append((ep, max(self.min_size, size)))

        return bids

    def _generate_asks(self) -> list[tuple[float, float]]:
        """Generate realistic ask levels with continuous 1-tick spacing."""
        asks = []
        price = self.current_price + self.tick_size * random.uniform(1, 2)
        price = round(price / self.tick_size) * self.tick_size

        # Random level gaps: occasional empty levels
        gap_count = random.randint(3, 6)
        gap_levels = set(random.sample(range(2, self.depth_levels), gap_count)) if self.depth_levels > 10 else set()

        for level in range(self.depth_levels):
            distance = price - self.current_price
            size = self._size_at_distance(distance)

            # Liquidity accumulation boost
            size = self._apply_accumulation(price, 'ask', size)

            # Iceberg contribution
            size = self._apply_iceberg(price, 'ask', size)

            # ── Static zone contribution (persistent liquidity walls) ──
            for zone in self._zones:
                if zone['life'] > 0 and abs(price - zone['price']) < self.tick_size * 0.1:
                    size += zone['size']
                    # Only decay the wall size when the price is close (being traded/filled)
                    if abs(self.current_price - zone['price']) < self.tick_size * 1.5:
                        zone['life'] -= 1
                        zone['size'] *= 0.98  # shrink size as it gets traded

            # Burst multiplier (dramatic but brief)
            size *= self._burst_multiplier

            # Jitter
            size *= random.uniform(0.85, 1.15)

            # BBO boost: ensure top-of-book levels are always visible
            if level == 0:
                size = max(size, 800.0)
            elif level == 1:
                size = max(size, 300.0)

            # Random level gaps: force selected levels to zero for natural look
            if level in gap_levels:
                size = 0.0

            # Cap total order size at 5000 to allow prominent liquidity walls
            size = min(size, 5000.0)

            if size > 0:
                asks.append((price, max(self.min_size, size)))

            # Continuous 1-tick spacing
            price += self.tick_size
            price = round(price / self.tick_size) * self.tick_size

        # Collect any extra prices for active asks (zones, icebergs, accumulations) that were not covered
        extra_prices = set()
        for zone in self._zones:
            if zone['life'] > 0 and zone['price'] > self.current_price:
                extra_prices.add(round(zone['price'] / self.tick_size) * self.tick_size)
        for iceberg in self._iceberg_orders:
            if iceberg['remaining'] > 0 and iceberg['side'] == 'ask' and iceberg['price'] > self.current_price:
                extra_prices.add(round(iceberg['price'] / self.tick_size) * self.tick_size)
        for (acc_price, acc_side) in self._accumulated_orders:
            if acc_side == 'ask' and acc_price > self.current_price:
                extra_prices.add(round(acc_price / self.tick_size) * self.tick_size)

        existing_prices = {a[0] for a in asks}
        for ep in sorted(extra_prices):
            if ep not in existing_prices:
                distance = ep - self.current_price
                size = self._size_at_distance(distance)
                size = self._apply_accumulation(ep, 'ask', size)
                size = self._apply_iceberg(ep, 'ask', size)
                for zone in self._zones:
                    if zone['life'] > 0 and abs(ep - zone['price']) < self.tick_size * 0.1:
                        size += zone['size']
                        if abs(self.current_price - zone['price']) < self.tick_size * 1.5:
                            zone['life'] -= 1
                            zone['size'] *= 0.98
                size *= self._burst_multiplier
                size *= random.uniform(0.85, 1.15)
                size = min(size, 5000.0)
                if size > 0:
                    asks.append((ep, max(self.min_size, size)))

        return asks

    # ═══════════════════════════════════════════════════════════════
    #  Trade generation
    # ═══════════════════════════════════════════════════════════════

    @staticmethod
    def _poisson(lmbda: float) -> int:
        """Generate a Poisson-distributed random integer (Knuth's algorithm)."""
        if lmbda <= 0:
            return 0
        L = math.exp(-lmbda)
        k = 0
        p = 1.0
        while p > L:
            k += 1
            p *= random.random()
        return k - 1

    def _generate_trades(self) -> list[Trade]:
        """Generate trades based on current volume profile and burst state.
        Uses lognormal size distribution for realistic trade prints."""
        trades = []

        vol_idx = min(self._tick, len(self._volume_profile) - 1)
        vol_factor = self._volume_profile[vol_idx]
        n_trades = max(1, self._poisson(vol_factor * 0.3))

        for _ in range(n_trades):
            slip = random.gauss(0, self.tick_size * 2)
            trade_price = self.current_price + slip
            trade_price = round(trade_price / self.tick_size) * self.tick_size

            # Lognormal trade size: some tiny, some massive
            size = self.min_size + random.lognormvariate(2.0, 1.0) * self.volume_per_tick

            # Large trade (occasional massive print, more dramatic)
            if random.random() < 0.03:
                size *= random.uniform(3, 10)

            # Burst multiplier
            size *= self._burst_multiplier

            # Aggressor bias: more buys in uptrend, more sells in downtrend
            bias = (self.current_price - self.base_price) / self._safe_base * 10
            buy_prob = 0.5 + max(-0.3, min(0.3, bias))
            side = Side.BUY if random.random() < buy_prob else Side.SELL

            trades.append(Trade(
                timestamp=now(),
                symbol=self.symbol,
                price=trade_price,
                size=round(size, 2),
                side=side,
                trade_id=f"sim_{self._tick}_{len(trades)}",
            ))

        return trades

    # ═══════════════════════════════════════════════════════════════
    #  Liquidity accumulation (multiple simultaneous zones)
    # ═══════════════════════════════════════════════════════════════

    def _inject_accumulation(self) -> None:
        """Inject 2-4 large standing orders simultaneously at DIFFERENT depth levels,
        clustered at nearby prices (within ±3 ticks) to create density hotspots.
        Multiplier: 15-50x, duration: 80-200 ticks."""
        n_orders = random.randint(2, 4)
        base_offset_ticks = random.randint(1, self.depth_levels // 2)
        side = random.choice(['bid', 'ask'])
        for i in range(n_orders):
            # Cluster: all orders within ±3 ticks of the base offset
            offset_ticks = base_offset_ticks + random.randint(-3, 3)
            offset_ticks = max(1, offset_ticks)

            if side == 'bid':
                price = round(
                    (self.current_price - offset_ticks * self.tick_size) / self.tick_size
                ) * self.tick_size
            else:
                price = round(
                    (self.current_price + offset_ticks * self.tick_size) / self.tick_size
                ) * self.tick_size

            multiplier = random.uniform(3, 6)
            duration = random.randint(80, 200)
            self._accumulated_orders[(round(price, 6), side)] = {
                'remaining': duration,
                'multiplier': multiplier,
            }

    def _update_accumulated_orders(self) -> None:
        """Decrement remaining ticks; remove expired accumulated orders."""
        for v in self._accumulated_orders.values():
            v['remaining'] -= 1
        expired = [k for k, v in self._accumulated_orders.items() if v['remaining'] <= 0]
        for key in expired:
            del self._accumulated_orders[key]

    # ═══════════════════════════════════════════════════════════════
    #  Iceberg orders (slowly replenishing at same price level)
    # ═══════════════════════════════════════════════════════════════

    def _inject_iceberg(self) -> None:
        """Create a new iceberg order at a random price level.
        Icebergs stay at the same price and slowly replenish,
        creating persistent liquidity bands in the heatmap."""
        side = random.choice(['bid', 'ask'])
        depth_range = self.depth_levels // 2

        if side == 'bid':
            offset_ticks = random.randint(2, depth_range)
            price = round(
                (self.current_price - offset_ticks * self.tick_size) / self.tick_size
            ) * self.tick_size
        else:
            offset_ticks = random.randint(2, depth_range)
            price = round(
                (self.current_price + offset_ticks * self.tick_size) / self.tick_size
            ) * self.tick_size

        base_size = self.max_size * random.uniform(3, 8)
        self._iceberg_orders.append({
            'price': price,
            'side': side,
            'base_size': base_size,
            'remaining': base_size,
            'replenish_rate': base_size * random.uniform(0.01, 0.03),
        })

        # Keep max 8 icebergs active at once (prevent bloat)
        if len(self._iceberg_orders) > 8:
            self._iceberg_orders.pop(0)

    def _update_icebergs(self) -> None:
        """Replenish iceberg orders each tick."""
        for iceberg in self._iceberg_orders:
            iceberg['remaining'] = min(
                iceberg['base_size'],
                iceberg['remaining'] + iceberg['replenish_rate']
            )

    # ═══════════════════════════════════════════════════════════════
    #  Burst clustering (dramatic but brief volume spikes)
    # ═══════════════════════════════════════════════════════════════

    def _update_burst_state(self) -> None:
        """Manage burst clustering: start/end volume bursts.
        Bursts are DRAMATIC (5-15x multiplier), moderate duration (12-30 ticks)."""
        if self._burst_remaining > 0:
            self._burst_remaining -= 1
            if self._burst_remaining <= 0:
                self._burst_multiplier = 1.0
        else:
            # 12% chance per tick of starting a burst
            if random.random() < 0.02:
                self._burst_remaining = random.randint(12, 30)
                self._burst_multiplier = random.uniform(2.0, 4.0)

    # ═══════════════════════════════════════════════════════════════
    #  Momentum runs (sustained directional price moves)
    # ═══════════════════════════════════════════════════════════════

    def _update_momentum(self) -> bool:
        """Manage momentum runs: sustained directional price moves.
        Runs last 20-40 ticks with 0.3-0.8 tick_size per step.
        Returns True if a momentum step was applied (OU should be skipped)."""
        if self._momentum_remaining > 0:
            self._momentum_remaining -= 1
            self.current_price += self._momentum_direction * self._momentum_step
            self.current_price = round(
                self.current_price / self.tick_size
            ) * self.tick_size
            return True
        else:
            # 2% chance per tick of starting a momentum run
            if random.random() < 0.02:
                self._momentum_remaining = random.randint(20, 40)
                self._momentum_direction = random.choice([-1.0, 1.0])
                self._momentum_step = self.tick_size * random.uniform(0.3, 0.8)
            return False

    # ═══════════════════════════════════════════════════════════════
    #  Large sweeps (clear multiple price levels)
    # ═══════════════════════════════════════════════════════════════

    def _execute_sweep(self) -> None:
        """Execute a large sweep that clears multiple price levels.
        Consumes accumulated orders and icebergs in the sweep path,
        moves price significantly, and triggers a volume burst spike."""
        direction = 1 if random.random() < 0.5 else -1
        levels = random.randint(2, 5)
        sweep_distance = levels * self.tick_size

        start_price = self.current_price
        end_price = start_price + direction * sweep_distance

        # Move price
        self.current_price = round(end_price / self.tick_size) * self.tick_size

        # Determine sweep range and which side of book is swept
        sweep_min = min(start_price, end_price)
        sweep_max = max(start_price, end_price)
        swept_side = 'ask' if direction > 0 else 'bid'

        # Clear accumulated orders hit by sweep
        to_remove = []
        for (price, side) in self._accumulated_orders:
            if side == swept_side and sweep_min <= price <= sweep_max:
                to_remove.append((price, side))
        for key in to_remove:
            del self._accumulated_orders[key]

        # Drain icebergs in sweep path (70% consumed)
        for iceberg in self._iceberg_orders:
            if (iceberg['side'] == swept_side
                    and sweep_min <= iceberg['price'] <= sweep_max):
                iceberg['remaining'] *= 0.3

        # Trigger a burst to create visible volume spike
        self._burst_remaining = max(self._burst_remaining, random.randint(4, 10))
        self._burst_multiplier = max(self._burst_multiplier, random.uniform(5, 12))

    # ═══════════════════════════════════════════════════════════════
    #  Main tick
    # ═══════════════════════════════════════════════════════════════

    def tick(self) -> dict:
        """
        Advance the simulation one tick.
        Returns a dict with 'snapshot', 'trades', and 'bbo'.
        """
        self._tick += 1

        # ── Momentum run (overrides OU mean reversion when active) ──
        in_momentum = self._update_momentum()

        # ── Step price (OU) — only when NOT in a momentum run ──
        _safe_tick = max(self.tick_size, 1e-12)  # guard division by zero
        if not in_momentum:
            self.current_price = self._ou_step()
            self.current_price = round(
                self.current_price / _safe_tick
            ) * self.tick_size

        # ── Hard-clamp price within ±3% of base_price ──
        lower_bound = self.base_price * 0.97
        upper_bound = self.base_price * 1.03
        if self.current_price < lower_bound:
            self.current_price = lower_bound + random.uniform(0, self.tick_size * 5)
            self.current_price = round(self.current_price / _safe_tick) * self.tick_size
        elif self.current_price > upper_bound:
            self.current_price = upper_bound - random.uniform(0, self.tick_size * 5)
            self.current_price = round(self.current_price / _safe_tick) * self.tick_size

        # ── Burst clustering ──
        self._update_burst_state()

        # ── Liquidity accumulation (multiple simultaneous zones, every 3-8 ticks) ──
        self._update_accumulated_orders()
        if self._tick >= self._next_accumulation_tick:
            self._inject_accumulation()
            self._next_accumulation_tick = self._tick + random.randint(3, 8)

        # ── Iceberg orders (replenish + inject new ones periodically) ──
        self._update_icebergs()
        if self._tick >= self._next_iceberg_tick:
            self._inject_iceberg()
            self._next_iceberg_tick = self._tick + random.randint(30, 80)

        # ── Occasional large sweep (clears multiple levels, moves price) ──
        if random.random() < 0.004:
            self._execute_sweep()

        current_time = now()

        # ── Generate order book ──
        bids = self._generate_bids()
        asks = self._generate_asks()

        # Clamp individual sizes to max 5000 to prevent heatmap saturation
        max_size_cap = 5000.0
        bids = [(p, min(s, max_size_cap)) for (p, s) in bids]
        asks = [(p, min(s, max_size_cap)) for (p, s) in asks]

        snapshot = Level2Snapshot(
            timestamp=current_time,
            symbol=self.symbol,
            bids=tuple(bids),
            asks=tuple(asks),
            bid_depth=self.depth_levels,
            ask_depth=self.depth_levels,
        )

        # ── BBO ──
        best_bid = bids[0][0] if bids else 0
        best_ask = asks[0][0] if asks else 0
        bbo = BBO(
            timestamp=current_time,
            symbol=self.symbol,
            bid=best_bid,
            ask=best_ask,
            bid_size=bids[0][1] if bids else 0,
            ask_size=asks[0][1] if asks else 0,
        )

        # ── Generate trades ──
        trades = self._generate_trades()

        # ── Generate simulated liquidations occasionally (2% chance per tick) ──
        if random.random() < 0.02 and bids and asks:
            side = Side.SELL if random.random() < 0.5 else Side.BUY
            # Liquidation price near best bid/ask
            offset = random.randint(1, 5) * self.tick_size
            price = best_bid - offset if side == Side.SELL else best_ask + offset
            price = round(price / self.tick_size) * self.tick_size
            size = random.uniform(200.0, 1500.0)
            trades.append(Trade(
                timestamp=current_time,
                symbol=self.symbol,
                price=price,
                size=size,
                side=side,
                trade_id=f"liq-{self._tick}",
                is_liquidation=True
            ))

        return {
            'snapshot': snapshot,
            'trades': trades,
            'bbo': bbo,
        }

    # ═══════════════════════════════════════════════════════════════
    #  DataProvider interface
    # ═══════════════════════════════════════════════════════════════

    @property
    def name(self) -> str:
        return "simulator"

    def connect(self) -> None:
        if self._connected:
            return
        self._connected = True
        self._symbols = [self.symbol]
        self.on_connected.emit()

        # Start the autonomous tick timer
        self._timer = QTimer(self)
        self._timer.setInterval(self._tick_interval_ms)
        self._timer.timeout.connect(self._emit_tick)
        self._timer.start()

    def disconnect(self) -> None:
        if not self._connected:
            return
        self._connected = False
        if self._timer is not None:
            self._timer.stop()
            self._timer = None
        self.on_disconnected.emit()

    def subscribe(self, symbol: str) -> None:
        if symbol not in self._symbols:
            self._symbols.append(symbol)
            self.symbol = symbol

    def unsubscribe(self, symbol: str) -> None:
        if symbol in self._symbols:
            self._symbols.remove(symbol)

    def _emit_tick(self) -> None:
        """Called by QTimer — runs one tick and emits signals."""
        data = self.tick()
        snap: Level2Snapshot = data['snapshot']
        trades: list[Trade] = data['trades']
        bbo: BBO = data['bbo']

        self.on_snapshot.emit(snap)
        for trade in trades:
            self.on_trade.emit(trade)
        self.on_bbo.emit(bbo)

    def reset(self, new_price: Optional[float] = None) -> None:
        """Reset simulator state."""
        self.current_price = new_price or self.base_price
        self._tick = 0
        self._volume_profile = self._generate_volume_profile()
        self._burst_remaining = 0
        self._burst_multiplier = 1.0
        self._accumulated_orders.clear()
        self._next_accumulation_tick = random.randint(10, 20)
        self._iceberg_orders.clear()
        self._next_iceberg_tick = random.randint(20, 50)
        self._momentum_remaining = 0
        self._momentum_direction = 0.0
        self._momentum_step = 0.0
        # Regenerate static accumulation zones with new random positions
        zone_count = random.randint(10, 15)
        self._zones = []
        num_clusters = random.randint(2, 3)
        cluster_centers = []
        for _ in range(num_clusters):
            side_offset = random.randint(-15, 15)
            if side_offset == 0:
                side_offset = 1 if random.random() < 0.5 else -1
            cluster_centers.append(self.base_price + self.tick_size * side_offset * random.uniform(5, 25))

        zones_per_cluster = zone_count // num_clusters
        remainder = zone_count % num_clusters
        for ci, center in enumerate(cluster_centers):
            count = zones_per_cluster + (1 if ci < remainder else 0)
            for _ in range(count):
                offset_ticks = random.randint(-3, 3)
                price = round((center + offset_ticks * self.tick_size) / self.tick_size) * self.tick_size
                self._zones.append({
                    'price': price,
                    'size': self.max_size * random.uniform(5, 12),
                    'life': random.randint(300, 800),
                })
