"""
Plugin API for FlowMap — the public interface for custom indicator plugins.

Inspired by Bookmap's Python API pattern. Plugins receive real-time
market data and can inject visual elements (indicator lines, annotations)
into the FlowMap rendering pipeline.

Usage::

    from flowmap.plugins import PluginAPI

    api = PluginAPI(order_book=my_order_book)
    addon = api.create_addon(name="My Indicator")

    @addon.on_trade
    def handle_trade(trade):
        # custom logic
        addon.add_indicator_line("my_line", trade.price, "#ff0")

    api.register_with_app(main_window)
"""

from __future__ import annotations

import time
from typing import (
    Any,
    Callable,
    Optional,
    Protocol,
    Union,
    TYPE_CHECKING,
)

from ..core import (
    BBO,
    BookLevel,
    Side,
    Trade,
    Level2Update,
    Level2Snapshot,
    now,
)

if TYPE_CHECKING:
    from ..core.order_book import OrderBook

# ── Type aliases for the callbacks ──────────────────────────────

TradeHandler = Callable[[Trade], None]
BBOHandler = Callable[[BBO], None]
Level2Handler = Callable[[list[BookLevel]], None]
SubscribeHandler = Callable[[str], None]
UnsubscribeHandler = Callable[[str], None]


# ── Descriptor for callback slots ──────────────────────────────

class _CallbackSlot:
    """Descriptor that enables both decorator and direct-assignment
    syntax for addon callbacks::

        @addon.on_trade
        def handler(trade): ...      # decorator form

        addon.on_trade = handler     # direct assignment

    The getter returns a *binding* object that:
    * Acts as a decorator when called with a single callable argument.
    * Is falsy when no handler is set, truthy otherwise.
    """

    def __set_name__(self, owner: type, name: str) -> None:
        self._storage = f"_cb_{name}"

    def __get__(self, obj: Any, objtype: type | None = None) -> Any:
        if obj is None:
            return self
        handler = getattr(obj, self._storage, None)
        return _CallbackBinding(obj, self._storage, handler)

    def __set__(self, obj: Any, value: Any) -> None:
        setattr(obj, self._storage, value)


class _CallbackBinding:
    """Tiny helper returned by ``_CallbackSlot.__get__``.

    When called with a single callable it stores that callable
    (decorator mode).  When called with anything else it delegates
    to the stored handler (or is a no-op).  Falsy when unset.
    """

    __slots__ = ("_obj", "_storage", "_handler")

    def __init__(self, obj: Any, storage: str, handler: Any) -> None:
        self._obj = obj
        self._storage = storage
        self._handler = handler

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        # Decorator pattern: addon.on_trade(def handler) → store it
        if len(args) == 1 and callable(args[0]) and not kwargs:
            handler = args[0]
            setattr(self._obj, self._storage, handler)
            return handler
        # Invocation pattern: callback(trade) → delegate
        if self._handler is not None:
            return self._handler(*args, **kwargs)
        return None

    def __bool__(self) -> bool:
        return self._handler is not None


class IndicatorLine:
    """A line drawn on the heatmap by a plugin indicator."""

    __slots__ = ("name", "price", "color", "timestamp")

    def __init__(self, name: str, price: float, color: str, timestamp: float) -> None:
        self.name = name
        self.price = price
        self.color = color
        self.timestamp = timestamp

    def __repr__(self) -> str:
        return (
            f"IndicatorLine(name={self.name!r}, price={self.price:.2f}, "
            f"color={self.color!r})"
        )


class Annotation:
    """A text annotation placed at a price level on the heatmap."""

    __slots__ = ("price", "text", "color", "timestamp")

    def __init__(self, price: float, text: str, color: str, timestamp: float) -> None:
        self.price = price
        self.text = text
        self.color = color
        self.timestamp = timestamp

    def __repr__(self) -> str:
        return (
            f"Annotation(price={self.price:.2f}, text={self.text!r}, "
            f"color={self.color!r})"
        )


class AddonState:
    """
    State and callbacks for a single plugin addon.

    A plugin receives this object (via :meth:`PluginAPI.create_addon`)
    and attaches handler callbacks to it.  The FlowMap main loop then
    invokes those callbacks when new market data arrives.
    """

    __slots__ = (
        "_api",
        "name",
        "_indicator_lines",
        "_annotations",
        # Internal state for optional built-in calculators
        "_vwap_price_vol_sum",
        "_vwap_vol_sum",
        "_buy_volume",
        "_sell_volume",
        # Callback storage (used by _CallbackSlot descriptors)
        "_cb_on_trade",
        "_cb_on_bbo",
        "_cb_on_level2",
        "_cb_on_subscribe",
        "_cb_on_unsubscribe",
    )

    # Callback slots — use descriptors so decorator syntax works
    on_trade = _CallbackSlot()
    on_bbo = _CallbackSlot()
    on_level2 = _CallbackSlot()
    on_subscribe = _CallbackSlot()
    on_unsubscribe = _CallbackSlot()

    def __init__(self, api: PluginAPI, name: str = "") -> None:
        self._api = api
        self.name = name

        # Accumulated plugin output (cleared each frame by the app)
        self._indicator_lines: list[IndicatorLine] = []
        self._annotations: list[Annotation] = []

        # Internal running sums for convenience properties
        self._vwap_price_vol_sum: float = 0.0
        self._vwap_vol_sum: float = 0.0
        self._buy_volume: float = 0.0
        self._sell_volume: float = 0.0

    # ── Public API for plugins ──────────────────────────────────

    def add_indicator_line(
        self, name: str, price: float, color: str = "#ffff00"
    ) -> None:
        """Queue an indicator line to be drawn on the heatmap.

        Parameters
        ----------
        name : str
            Display name for the line (shown in legend).
        price : float
            Price level to draw the line at.
        color : str
            CSS-style hex colour (e.g. ``\"#ff0\"`` or ``\"#00ff88\"``).
        """
        self._indicator_lines.append(
            IndicatorLine(name, price, color, now())
        )

    def add_annotation(
        self, price: float, text: str, color: str = "#ffffff"
    ) -> None:
        """Queue a text annotation to be drawn on the heatmap.

        Parameters
        ----------
        price : float
            Price level to place the annotation at.
        text : str
            The annotation text.
        color : str
            CSS-style hex colour.
        """
        self._annotations.append(
            Annotation(price, text, color, now())
        )

    def get_order_book(self) -> Optional[OrderBook]:
        """Return a reference to the shared :class:`OrderBook` instance."""
        return self._api.get_order_book()

    # ── Convenience properties ──────────────────────────────────

    @property
    def current_bbo(self) -> Optional[BBO]:
        """Latest best bid & offer from the shared order book."""
        ob = self.get_order_book()
        if ob is not None:
            return ob.bbo
        return None

    @property
    def current_levels(self) -> list[BookLevel]:
        """Current L2 price levels from the shared order book."""
        ob = self.get_order_book()
        if ob is not None:
            return ob.get_levels()
        return []

    @property
    def current_vwap(self) -> float:
        """Volume-weighted average price computed from trades seen
        by **this** addon since creation."""
        if self._vwap_vol_sum > 0:
            return self._vwap_price_vol_sum / self._vwap_vol_sum
        return 0.0

    @property
    def current_cvd(self) -> float:
        """Cumulative volume delta (buy volume − sell volume) for
        trades seen by **this** addon since creation."""
        return self._buy_volume - self._sell_volume

    # ── Internal helpers called by PluginAPI ────────────────────

    def _record_internal_trade(self, trade: Trade) -> None:
        """Update running VWAP and CVD sums for convenience properties."""
        self._vwap_price_vol_sum += trade.price * trade.size
        self._vwap_vol_sum += trade.size
        if trade.side == Side.BUY:
            self._buy_volume += trade.size
        elif trade.side == Side.SELL:
            self._sell_volume += trade.size

    def _reset_output(self) -> None:
        """Clear indicator lines and annotations (called each frame)."""
        self._indicator_lines.clear()
        self._annotations.clear()


class PluginAPI:
    """
    Central API hub that connects FlowMap with custom indicator plugins.

    Typical lifecycle::

        1. ``api = PluginAPI(order_book=ob)``
        2. ``addon = api.create_addon(name=\"Foo\")``
        3. Plugin sets ``addon.on_trade``, ``addon.on_bbo``, …
        4. ``api.register_with_app(main_window)`` — wires callbacks
        5. The app calls ``api.notify_trade(trade)`` each tick
        6. Each addon's callback fires (with error isolation)
        7. The app reads ``api.collect_indicator_lines()`` for rendering
    """

    def __init__(self, order_book: Optional[OrderBook] = None) -> None:
        self._order_book: Optional[OrderBook] = order_book
        self._addons: list[AddonState] = []

    # ── Addon lifecycle ─────────────────────────────────────────

    def create_addon(self, name: str = "") -> AddonState:
        """Create a new addon that a plugin can attach callbacks to.

        Parameters
        ----------
        name : str
            Optional human-readable name for debugging.
        """
        addon = AddonState(self, name)
        self._addons.append(addon)
        return addon

    def remove_addon(self, addon: AddonState) -> None:
        """Remove a previously registered addon."""
        if addon in self._addons:
            self._addons.remove(addon)

    # ── Order book access ───────────────────────────────────────

    def set_order_book(self, ob: OrderBook) -> None:
        """Set (or replace) the shared order book reference."""
        self._order_book = ob

    def get_order_book(self) -> Optional[OrderBook]:
        """Return the shared order book instance (if any)."""
        return self._order_book

    # ── Data notification (called by the app) ───────────────────

    def notify_trade(self, trade: Trade) -> None:
        """Feed a :class:`Trade` to every registered addon.

        Each addon's ``on_trade`` callback is called inside a
        try/except so a broken plugin never crashes the app.
        """
        if not self._addons:
            return
        for addon in self._addons:
            if addon.on_trade:
                try:
                    addon._record_internal_trade(trade)
                    addon.on_trade(trade)
                except Exception:
                    _log_plugin_error(addon, "on_trade")

    def notify_bbo(self, bbo: BBO) -> None:
        """Feed a :class:`BBO` update to every registered addon."""
        if not self._addons:
            return
        for addon in self._addons:
            if addon.on_bbo:
                try:
                    addon.on_bbo(bbo)
                except Exception:
                    _log_plugin_error(addon, "on_bbo")

    def notify_level2(self, levels: list[BookLevel]) -> None:
        """Feed updated L2 price levels to every registered addon."""
        if not self._addons:
            return
        for addon in self._addons:
            if addon.on_level2:
                try:
                    addon.on_level2(levels)
                except Exception:
                    _log_plugin_error(addon, "on_level2")

    def notify_subscribe(self, symbol: str) -> None:
        """Notify addons that the app subscribed to *symbol*."""
        if not self._addons:
            return
        for addon in self._addons:
            if addon.on_subscribe:
                try:
                    addon.on_subscribe(symbol)
                except Exception:
                    _log_plugin_error(addon, "on_subscribe")

    def notify_unsubscribe(self, symbol: str) -> None:
        """Notify addons that the app unsubscribed from *symbol*."""
        if not self._addons:
            return
        for addon in self._addons:
            if addon.on_unsubscribe:
                try:
                    addon.on_unsubscribe(symbol)
                except Exception:
                    _log_plugin_error(addon, "on_unsubscribe")

    # ── Output collection (for the renderer) ────────────────────

    def collect_indicator_lines(self) -> list[IndicatorLine]:
        """Return all indicator lines queued by plugins this frame,
        then clear each addon's output buffer."""
        lines: list[IndicatorLine] = []
        for addon in self._addons:
            lines.extend(addon._indicator_lines)
            addon._indicator_lines.clear()
        return lines

    def collect_annotations(self) -> list[Annotation]:
        """Return all annotations queued by plugins this frame,
        then clear each addon's output buffer."""
        annotations: list[Annotation] = []
        for addon in self._addons:
            annotations.extend(addon._annotations)
            addon._annotations.clear()
        return annotations

    # ── App integration helper ──────────────────────────────────

    def register_with_app(self, main_window: Any) -> None:
        """Connect this API to an already-instantiated MainWindow.

        This method:
        * Grabs the existing order book from the window.
        * Wires the API's notify methods into the order book's
          callbacks so data flows automatically.

        Parameters
        ----------
        main_window : MainWindow
            The FlowMap application's main window instance.
        """
        from ..ui.main_window import MainWindow  # noqa: F811

        # Try to get the order book if we don't have one
        if self._order_book is None:
            ob = getattr(main_window, "_order_book", None)
            if ob is not None:
                self._order_book = ob

        # Grab existing callbacks so we don't clobber them
        ob = self._order_book
        if ob is not None:
            _orig_on_trade = ob.on_trade
            _orig_on_bbo = ob.on_bbo

            def _wrapped_on_trade(trade: Trade) -> None:
                if _orig_on_trade:
                    _orig_on_trade(trade)
                self.notify_trade(trade)

            def _wrapped_on_bbo(bbo: BBO) -> None:
                if _orig_on_bbo:
                    _orig_on_bbo(bbo)
                self.notify_bbo(bbo)

            ob.on_trade = _wrapped_on_trade
            ob.on_bbo = _wrapped_on_bbo

    def __repr__(self) -> str:
        return (
            f"PluginAPI(addons={len(self._addons)}, "
            f"order_book={'set' if self._order_book else 'None'})"
        )


# ── Internal helpers ────────────────────────────────────────────

_plugin_errors: dict[str, int] = {}


def _log_plugin_error(addon: AddonState, callback_name: str) -> None:
    """Log a plugin error without crashing the app.

    Errors are rate-limited to one message per callback per addon
    per print (to avoid spamming stderr).
    """
    import sys
    import traceback

    key = f"{id(addon)}.{callback_name}"
    _plugin_errors[key] = _plugin_errors.get(key, 0) + 1
    count = _plugin_errors[key]

    # Print every 10th occurrence to avoid log flooding
    if count == 1 or count % 10 == 0:
        name = addon.name or f"addon@{id(addon):x}"
        print(
            f"[FlowMap Plugin Error] {name}.{callback_name}() "
            f"(occurrence #{count}):",
            file=sys.stderr,
        )
        traceback.print_exc(file=sys.stderr)
