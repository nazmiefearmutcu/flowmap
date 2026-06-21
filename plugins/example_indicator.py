"""
Example FlowMap plugin: Cumulative Delta + VWAP indicator.

This file demonstrates the Plugin API pattern.  Place it in
``~/flowmap/plugins/`` (or any directory scanned by
:func:`flowmap.plugins.loader.load_all_from_directory`),
and it will be auto-loaded at startup.

Each plugin **must** export a top-level ``register(api)`` function.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flowmap.plugins.plugin_api import PluginAPI


def register(api: PluginAPI) -> None:
    """Called by the plugin loader when this file is discovered.

    Parameters
    ----------
    api : PluginAPI
        The central API instance that connects to FlowMap.
    """
    # ── Create an addon — each addon is an independent indicator ──
    addon = api.create_addon(name="Example CVD+VWAP")

    # ── Custom state (stored in closures, not on the addon object) ──
    vwap_state = {
        "price_vol_sum": 0.0,
        "vol_sum": 0.0,
        "prev_vwap": 0.0,
        "latest_vwap": 0.0,
    }

    # We'll draw a cyan VWAP line and a magenta CVD reference line

    # ── on_trade callback ────────────────────────────────────────
    @addon.on_trade
    def handle_trade(trade):
        """React to every incoming trade.

        Compute a running VWAP (volume-weighted average price) and
        draw an indicator line whenever VWAP crosses a whole-number
        boundary.
        """
        # Update local VWAP
        vwap_state["price_vol_sum"] += trade.price * trade.size
        vwap_state["vol_sum"] += trade.size

        if vwap_state["vol_sum"] > 0:
            vwap_state["latest_vwap"] = (
                vwap_state["price_vol_sum"] / vwap_state["vol_sum"]
            )

        # Draw the VWAP line on every trade that changes it meaningfully
        if abs(vwap_state["latest_vwap"] - vwap_state["prev_vwap"]) > 0.01:
            vwap_state["prev_vwap"] = vwap_state["latest_vwap"]
            # Cyan VWAP line
            addon.add_indicator_line(
                name="VWAP",
                price=vwap_state["latest_vwap"],
                color="#00ffff",
            )

        # Also draw a yellow line at the current trade price
        # (simple "last price" indicator)
        addon.add_indicator_line(
            name="Last",
            price=trade.price,
            color="#ffdd00",
        )

    # ── on_bbo callback ──────────────────────────────────────────
    @addon.on_bbo
    def handle_bbo(bbo):
        """React to best-bid/offer changes.

        Draw a green line at the bid and a red line at the ask.
        Also add a text annotation showing the spread.
        """
        if bbo.bid > 0:
            addon.add_indicator_line(
                name="Bid",
                price=bbo.bid,
                color="#00ff88",
            )

        if bbo.ask > 0:
            addon.add_indicator_line(
                name="Ask",
                price=bbo.ask,
                color="#ff4466",
            )

        # Annotation with spread info
        if bbo.bid > 0 and bbo.ask > 0:
            mid = (bbo.bid + bbo.ask) / 2.0
            addon.add_annotation(
                price=mid,
                text=f"Spread: {bbo.spread:.4f}",
                color="#aaaaaa",
            )

    # ── on_level2 callback ───────────────────────────────────────
    @addon.on_level2
    def handle_level2(levels):
        """React to L2 depth updates.

        Compute a simple midpoint of visible liquidity and draw it.
        """
        if not levels:
            return

        # Find the "liquidity midpoint" — price where bid and ask
        # volume are most balanced
        best_balance = float("inf")
        best_price = 0.0
        for level in levels:
            if level.bid_size > 0 and level.ask_size > 0:
                imbalance = abs(level.bid_size - level.ask_size)
                if imbalance < best_balance:
                    best_balance = imbalance
                    best_price = level.price

        if best_price > 0:
            addon.add_indicator_line(
                name="Liquidity Mid",
                price=best_price,
                color="#ff88ff",
            )

    # ── Optional lifecycle callbacks ─────────────────────────────
    @addon.on_subscribe
    def handle_subscribe(symbol: str):
        """Called when the app starts receiving data for *symbol*."""
        print(f"[ExamplePlugin] Subscribed to {symbol}")

    @addon.on_unsubscribe
    def handle_unsubscribe(symbol: str):
        """Called when the app stops receiving data for *symbol*."""
        print(f"[ExamplePlugin] Unsubscribed from {symbol}")
