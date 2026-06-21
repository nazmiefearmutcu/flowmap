"""
Volume Bubbles — Bookmap-style trade bubble overlay.

Bubbles appear at the trade price as circles with:
- Size ∝ trade volume (log-scaled for readability)
- Green = buy (aggressor on ask), Red = sell (aggressor on bid)
- Fade over ~2.5 seconds with smooth alpha decay
- draw() method for direct QPainter rendering
"""

from __future__ import annotations

import time
from collections import deque
from typing import Optional

from PyQt6.QtCore import Qt, QPointF
from PyQt6.QtGui import QPainter, QColor, QBrush, QPen

from ..core import Side
from .theme import Colors


class Bubble:
    """A single trade bubble with position, appearance, and age."""

    __slots__ = ('price', 'size', 'side', 'timestamp', 'max_radius', 'tick_index')

    def __init__(self, price: float, size: float, side: Side, timestamp: float, tick_index: int) -> None:
        self.price = price
        self.size = size
        self.side = side
        self.timestamp = timestamp
        self.tick_index = tick_index
        # Max radius clamped to [2, 16] pixels, log2-scaled
        import math
        self.max_radius: float = max(2.0, min(16.0, 3.0 + math.log2(1.0 + size) * 1.5))

    @property
    def age(self) -> float:
        """Seconds since this bubble was created."""
        return time.time() - self.timestamp

    def is_alive(self, max_age: float = 2.5) -> bool:
        return self.age < max_age

    def alpha(self, max_age: float = 2.5) -> int:
        """Current alpha value (0-255) based on age."""
        age = self.age
        if age >= max_age:
            return 0
        # Cubic ease-out fade: stays bright then fades fast at end
        t = age / max_age
        fade = 1.0 - t * t * t
        return max(0, min(255, int(255 * fade)))

    def current_radius(self, min_rad: float, max_rad: float, max_age: float = 2.5) -> float:
        """Current radius — grows slightly then holds."""
        age = self.age
        if age >= max_age:
            return 0.0
        import math
        # Calculate dynamic max radius based on current size
        raw_rad = min_rad + math.log2(1.0 + self.size) * (max_rad - min_rad) / 8.0
        bubble_max_rad = max(min_rad, min(max_rad, raw_rad))
        
        # Quick grow-in over 150ms then hold
        t = min(1.0, age / 0.15)
        return bubble_max_rad * (1.0 - (1.0 - t) * (1.0 - t))


class VolumeBubbles:
    """
    Manages a collection of trade bubbles for the Volume Bubbles overlay.

    Bubbles are stored in a fixed-size deque. Each bubble fades over
    ~2.5 seconds. Dead bubbles are cleaned on draw.
    """

    def __init__(self, max_bubbles: int = 200, max_age: float = 2.5) -> None:
        self._bubbles: deque[Bubble] = deque(maxlen=max_bubbles)
        self._max_age = max_age
        self.min_radius: float = 2.0
        self.max_radius: float = 16.0

    def add_trade(self, price: float, size: float, side: Side, tick_index: int) -> None:
        """Record a trade as a new bubble."""
        self._bubbles.append(Bubble(price, size, side, time.time(), tick_index))

    def draw(
        self,
        painter: QPainter,
        widget_width: int,
        widget_height: int,
        heatmap_width: int,
        price_to_y,
        frame_count: int,
        bw: int,
    ) -> None:
        """
        Draw all alive bubbles onto the widget.

        Parameters
        ----------
        painter : QPainter
            Active painter (antialiasing should be enabled by caller).
        widget_width : int
            Total widget width in pixels.
        widget_height : int
            Total widget height in pixels.
        heatmap_width : int
            Width of the heatmap area (excluding price axis).
        price_to_y : callable
            Function mapping a price (float) → screen Y (int).
        frame_count : int
            Current frame/tick index of the widget.
        bw : int
            Width of the density engine buffer.
        """
        now_ts = time.time()

        # Remove dead bubbles from the front (oldest first, roughly ordered)
        while self._bubbles and not self._bubbles[0].is_alive(self._max_age):
            self._bubbles.popleft()

        for bubble in self._bubbles:
            age = bubble.age
            if age >= self._max_age:
                continue

            alpha = bubble.alpha(self._max_age)
            if alpha < 8:
                continue  # nearly invisible, skip

            radius = bubble.current_radius(self.min_radius, self.max_radius, self._max_age)
            if radius < 0.5:
                continue

            # Color: green for buys, red for sells
            if bubble.side == Side.BUY:
                fill_color = QColor(Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue(), int(alpha * 0.45))
                border_color = QColor(Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue(), alpha)
            else:
                fill_color = QColor(Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue(), int(alpha * 0.45))
                border_color = QColor(Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue(), alpha)

            # Position: use unified price→Y mapping
            y = price_to_y(bubble.price)

            # X position: scroll with the heatmap's X coordinate
            col = bw - frame_count + bubble.tick_index
            if not (0 <= col < bw):
                continue
            x = col * heatmap_width / bw

            # Draw filled circle with border
            painter.setPen(QPen(border_color, 1.2))
            painter.setBrush(QBrush(fill_color))
            painter.drawEllipse(
                QPointF(x, y),
                radius,
                radius,
            )

    def clear(self) -> None:
        """Remove all bubbles."""
        self._bubbles.clear()

    @property
    def count(self) -> int:
        """Number of bubbles currently stored (including dead ones)."""
        return len(self._bubbles)

    @property
    def alive_count(self) -> int:
        """Number of currently visible (alive) bubbles."""
        return sum(1 for b in self._bubbles if b.is_alive(self._max_age))
