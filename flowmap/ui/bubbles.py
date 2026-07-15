"""
Volume Bubbles — Bookmap-style trade bubble overlay.

Aggregates trades at the same price level within a short time/tick window
and renders bi-color circles (green for buys, red for sells).
Scales dynamically with row height and ticks per row.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Optional

from PyQt6.QtCore import Qt, QPointF, QRectF
from PyQt6.QtGui import QPainter, QColor, QBrush, QPen

from ..core import Side
from .theme import Colors


class Bubble:
    """A single aggregated trade bubble with price, buy/sell volumes, and age."""

    __slots__ = ('price', 'buy_size', 'sell_size', 'timestamp', 'tick_index')

    def __init__(self, price: float, buy_size: float, sell_size: float, timestamp: float, tick_index: int) -> None:
        self.price = price
        self.buy_size = buy_size
        self.sell_size = sell_size
        self.timestamp = timestamp
        self.tick_index = tick_index

    def age(self, now: float | None = None) -> float:
        """Seconds since this bubble was last updated/created (event-domain when ``now`` provided)."""
        ref = time.time() if now is None else now
        return ref - self.timestamp

    def is_alive(self, max_age: float = 2.5, now: float | None = None) -> bool:
        return self.age(now) < max_age

    def alpha(self, max_age: float = 2.5, now: float | None = None) -> int:
        """Current alpha value (0-255) based on age."""
        age = self.age(now)
        if age >= max_age:
            return 0
        # Cubic ease-out fade: stays bright then fades fast at end
        t = age / max_age
        fade = 1.0 - t * t * t
        return max(0, min(255, int(255 * fade)))

    def current_radius(
        self,
        min_rad: float,
        max_rad: float,
        max_age: float = 2.5,
        row_height: int = 4,
        scale_mult: float = 1.0,
        ticks_per_row: int = 1,
        now: float | None = None,
    ) -> float:
        """Current radius — scaled by row height, ticks per row, and user scale multiplier."""
        age = self.age(now)
        import math
        
        # Calculate dynamic max radius based on current size (total buy + sell volume)
        total_size = self.buy_size + self.sell_size
        raw_rad = min_rad + math.log2(1.0 + total_size) * (max_rad - min_rad) / 8.0
        bubble_max_rad = max(min_rad, min(max_rad, raw_rad))
        
        # Apply scaling factors
        # 1. row_height scale: scale down if row_height is small, scale up if row_height is large
        row_scale = math.sqrt(row_height / 4.0)
        
        # 2. ticks_per_row scale: if ticks_per_row is large (zoomed out price scale), scale down bubbles
        # to prevent them from taking up the entire screen vertically.
        zoom_scale = 1.0 / math.sqrt(ticks_per_row)
        
        # 3. user multiplier scale
        bubble_max_rad = bubble_max_rad * row_scale * zoom_scale * scale_mult
        
        # Clamp between a minimum readable radius (e.g. 1.5) and a maximum screen radius (e.g. 120.0)
        bubble_max_rad = max(1.5, min(120.0, bubble_max_rad))

        # Quick grow-in over 150ms then hold
        t = min(1.0, age / 0.15)
        return bubble_max_rad * (1.0 - (1.0 - t) * (1.0 - t))


class VolumeBubbles:
    """
    Manages a collection of trade bubbles for the Volume Bubbles overlay.
    Aggregates trades at the same price level within a short tick range.
    """

    def __init__(self, max_bubbles: int = 10000, max_age: float = 2.5) -> None:
        self._bubbles: deque[Bubble] = deque(maxlen=max_bubbles)
        self._max_age = max_age
        self.min_radius: float = 2.5
        self.max_radius: float = 18.0
        self.size_multiplier: float = 1.0  # Controls the bubble size multiplier from toolbar/sidebar
        # Event-domain clock advanced by trade timestamps (FIND-NUM-02)
        self._event_clock: float = 0.0

    def add_trade(
        self,
        price: float,
        size: float,
        side: Side,
        tick_index: int,
        timestamp: float | None = None,
    ) -> None:
        """Record a trade. Aggregates with existing bubbles at the same price and nearby tick index.

        Prefer market/event ``timestamp`` when available so age follows event time (FIND-NUM-02).
        """
        now_ts = float(timestamp) if timestamp is not None and timestamp > 0 else time.time()
        if now_ts > self._event_clock:
            self._event_clock = now_ts
        # Look for a bubble at the same price and within a small tick index distance (e.g. 2 ticks)
        # to aggregate trades that occur in rapid succession
        merged = False
        for b in reversed(self._bubbles):
            if abs(b.price - price) < 0.000001 and abs(b.tick_index - tick_index) <= 2:
                # Add to sizes
                from flowmap.core import is_buy_side
                if is_buy_side(side):
                    b.buy_size += size
                else:
                    b.sell_size += size
                # Smoothly update timestamp to keep it alive a bit longer, but capped
                b.timestamp = max(b.timestamp, now_ts - 0.2)
                # Keep the latest tick index
                b.tick_index = max(b.tick_index, tick_index)
                merged = True
                break
        
        if not merged:
            # Create a new bubble (treat BID as buy aggressor, ASK as sell)
            from flowmap.core import is_buy_side, is_sell_side
            buy_size = size if is_buy_side(side) else 0.0
            sell_size = size if is_sell_side(side) else (0.0 if is_buy_side(side) else size)
            self._bubbles.append(Bubble(price, buy_size, sell_size, now_ts, tick_index))

    def draw(
        self,
        painter: QPainter,
        widget_width: int,
        widget_height: int,
        heatmap_width: int,
        price_to_y,
        frame_count: int,
        bw: int,
        row_height: int = 4,
        ticks_per_row: int = 1,
    ) -> None:
        """Draw all alive bubbles onto the widget."""
        # Find start and end tick indexes for the visible window
        start_tick = frame_count - bw + 1
        end_tick = frame_count

        import bisect
        bubbles_list = list(self._bubbles)
        if not bubbles_list:
            return

        start_idx = bisect.bisect_left(bubbles_list, start_tick, key=lambda b: b.tick_index)
        end_idx = bisect.bisect_right(bubbles_list, end_tick, key=lambda b: b.tick_index)
        visible_bubbles = bubbles_list[start_idx:end_idx]

        clock = self._event_clock if self._event_clock > 0 else time.time()
        for bubble in visible_bubbles:
            # Persistent visual opacity on chart timeline
            alpha = 180

            # Pass row_height, size_multiplier, and ticks_per_row for dynamic scaling
            radius = bubble.current_radius(
                self.min_radius, self.max_radius, self._max_age,
                row_height, self.size_multiplier, ticks_per_row,
                now=clock,
            )
            if radius < 0.5:
                continue

            # Position: use unified price→Y mapping
            y = price_to_y(bubble.price)

            # X position: scroll with the heatmap's X coordinate
            col = bw - 1 - frame_count + bubble.tick_index
            if col >= bw:
                col = bw - 1
            if col < 0:
                continue
            x = col * heatmap_width / bw

            # Define bounding rect for the ellipse
            rect = QRectF(x - radius, y - radius, radius * 2, radius * 2)

            total_size = bubble.buy_size + bubble.sell_size
            if total_size <= 0:
                continue

            buy_ratio = bubble.buy_size / total_size
            sell_ratio = bubble.sell_size / total_size

            # Colors from theme
            green_r, green_g, green_b = Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue()
            red_r, red_g, red_b = Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue()

            # Render buy/sell pie chart or solid colors
            if buy_ratio >= 0.99:
                # Pure Buy - Green
                fill_color = QColor(green_r, green_g, green_b, int(alpha * 0.5))
                border_color = QColor(green_r, green_g, green_b, alpha)
                painter.setPen(QPen(border_color, 1.2))
                painter.setBrush(QBrush(fill_color))
                painter.drawEllipse(rect)
            elif sell_ratio >= 0.99:
                # Pure Sell - Red
                fill_color = QColor(red_r, red_g, red_b, int(alpha * 0.5))
                border_color = QColor(red_r, red_g, red_b, alpha)
                painter.setPen(QPen(border_color, 1.2))
                painter.setBrush(QBrush(fill_color))
                painter.drawEllipse(rect)
            else:
                # Split/Bi-color bubble (green buy side, red sell side)
                # startAngle and spanAngle are in 1/16ths of a degree
                buy_angle = int(buy_ratio * 360 * 16)
                sell_angle = 5760 - buy_angle

                # Green brush & pen
                green_fill = QColor(green_r, green_g, green_b, int(alpha * 0.5))
                green_border = QColor(green_r, green_g, green_b, alpha)

                # Red brush & pen
                red_fill = QColor(red_r, red_g, red_b, int(alpha * 0.5))
                red_border = QColor(red_r, red_g, red_b, alpha)

                # Draw the green pie sector (starting at 12 o'clock / 90 degrees)
                painter.setBrush(QBrush(green_fill))
                painter.setPen(QPen(green_border, 1.2))
                painter.drawPie(rect, 90 * 16, buy_angle)

                # Draw the red pie sector (the remaining part)
                painter.setBrush(QBrush(red_fill))
                painter.setPen(QPen(red_border, 1.2))
                painter.drawPie(rect, 90 * 16 + buy_angle, sell_angle)

    def clear(self) -> None:
        """Remove all bubbles."""
        self._bubbles.clear()

    def adjust_tick_indices(self, delta: int) -> None:
        """Adjust the tick index of all bubbles to align with frame index changes."""
        for bubble in self._bubbles:
            bubble.tick_index -= delta

    @property
    def count(self) -> int:
        return len(self._bubbles)
