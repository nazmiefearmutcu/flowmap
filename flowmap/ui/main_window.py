"""
FlowMap Main Window — Density-based Bookmap-style UI.
Layout: PriceChart (top 22%) + HeatmapWidget (bottom 78%).
Zero-flicker: WA_OpaquePaintEvent on all widgets, single drawImage per frame.

Data sources: Simulator | Crypcodile Replay | CCXT Live

Source management delegated to SourceManager.
Toolbar management delegated to ToolbarManager.
"""
from __future__ import annotations

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QStatusBar, QDockWidget,
)
from PyQt6.QtGui import QAction

from ..core import Trade, BBO
from ..core.order_book import OrderBook
from .heatmap_widget import HeatmapWidget
from .price_chart import PriceChart
from .dom.dom_ladder import DomLadder
from .pulse import MarketPulse
from .source_manager import SourceManager, DataSource
from .toolbar_manager import ToolbarManager
from .theme import MAIN_STYLESHEET


class MainWindow(QMainWindow):

    def __init__(self):
        super().__init__()
        self.setWindowTitle("FlowMap")
        self.resize(1400, 900)
        self.setMinimumSize(800, 500)

        # ── Core data objects ──
        self._order_book = OrderBook("BTC/USDT", depth=15)
        self._sim_timer = QTimer(self)
        self._gui_timer = QTimer(self)
        self._gui_frame: int = 0

        # ── Managers ──
        self._toolbar_mgr = ToolbarManager(self, None)  # source_mgr set below
        self._source = SourceManager(self, self._toolbar_mgr)
        self._toolbar_mgr._source = self._source  # complete the two-way link

        # ── Dark theme ──
        self.setStyleSheet(MAIN_STYLESHEET)

        self._setup_ui()
        self._setup_docks()
        self._setup_timers()
        self._wire_callbacks()
        self._toolbar_mgr.update_visibility(DataSource.SIMULATOR)

    # ─────────────────────────────────────────────────────────────────
    #  UI setup — layout: price_chart, heatmap, toolbar, statusbar
    # ─────────────────────────────────────────────────────────────────

    def _setup_ui(self) -> None:
        central = QWidget()
        central.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        central.setStyleSheet("background: #000000;")
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self.price_chart = PriceChart()
        self.price_chart.setMinimumHeight(100)
        layout.addWidget(self.price_chart, 2)

        # Bottom container widget to house Heatmap and Volume Profile side-by-side
        bottom_container = QWidget()
        bottom_container.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        bottom_container.setStyleSheet("background: #000000;")
        bottom_layout = QHBoxLayout(bottom_container)
        bottom_layout.setContentsMargins(0, 0, 0, 0)
        bottom_layout.setSpacing(0)

        self.heatmap = HeatmapWidget()
        bottom_layout.addWidget(self.heatmap, 8)

        from .overlays.volume_profile import VolumeProfileOverlay
        self.volume_profile = VolumeProfileOverlay()
        bottom_layout.addWidget(self.volume_profile, 1)

        layout.addWidget(bottom_container, 8)

        # Toolbar — fully delegated to ToolbarManager
        self.addToolBar(self._toolbar_mgr.create_toolbar())

        # Status bar
        self._status = QStatusBar()
        self.setStatusBar(self._status)
        self._update_status_message()

        self.heatmap.price_hovered.connect(
            lambda p: self._status.showMessage(f"Price: {p:.2f}"))
        self.heatmap.row_height_changed.connect(self._on_row_height_changed)

    def _setup_docks(self) -> None:
        # DOM Ladder (right, hidden)
        self._dom_ladder = DomLadder()
        self._dom_ladder_dock = QDockWidget("DOM Ladder", self)
        self._dom_ladder_dock.setWidget(self._dom_ladder)
        self._dom_ladder_dock.setAllowedAreas(
            Qt.DockWidgetArea.RightDockWidgetArea | Qt.DockWidgetArea.LeftDockWidgetArea)
        self._dom_ladder_dock.setMinimumWidth(300)
        self.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, self._dom_ladder_dock)
        self._dom_ladder_dock.hide()

        # Market Pulse (bottom, visible)
        self._pulse = MarketPulse()
        self._pulse_dock = QDockWidget("Market Pulse (CVD)", self)
        self._pulse_dock.setWidget(self._pulse)
        self._pulse_dock.setAllowedAreas(
            Qt.DockWidgetArea.BottomDockWidgetArea | Qt.DockWidgetArea.TopDockWidgetArea)
        self._pulse_dock.setMinimumHeight(100)
        self.addDockWidget(Qt.DockWidgetArea.BottomDockWidgetArea, self._pulse_dock)

        # View menu
        menu_bar = self.menuBar()
        view_menu = menu_bar.addMenu("&View")

        dom_action = QAction("DOM Ladder", self)
        dom_action.setCheckable(True)
        dom_action.setChecked(False)
        dom_action.toggled.connect(self._dom_ladder_dock.setVisible)
        self._dom_ladder_dock.visibilityChanged.connect(dom_action.setChecked)
        view_menu.addAction(dom_action)

        pulse_action = QAction("Market Pulse (CVD)", self)
        pulse_action.setCheckable(True)
        pulse_action.setChecked(True)
        pulse_action.toggled.connect(self._pulse_dock.setVisible)
        self._pulse_dock.visibilityChanged.connect(pulse_action.setChecked)
        view_menu.addAction(pulse_action)

    def _setup_timers(self) -> None:
        self._sim_timer.timeout.connect(self._sim_tick)
        self._gui_timer.timeout.connect(self._gui_tick)
        self._gui_timer.start(16)

    def _wire_callbacks(self) -> None:
        self._order_book.on_bbo = self._on_bbo
        self._order_book.on_trade = self._on_trade

    # ── Data pipeline ───────────────────────────────────────────────

    def _sim_tick(self) -> None:
        r = self._source.sim_tick()
        self._order_book.apply_snapshot(r["snapshot"])
        for t in r["trades"]:
            self._order_book.record_trade(t)

    def _on_bbo(self, bbo: BBO) -> None:
        pass

    def _on_trade(self, trade: Trade) -> None:
        self.heatmap.add_trade(trade.price, trade.size, trade.side, is_liquidation=trade.is_liquidation)
        self._pulse.add_trade(trade.price, trade.size, trade.side)
        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            self.volume_profile.add_trade(trade.price, trade.size)

    def _gui_tick(self) -> None:
        if not self._order_book or not self._source.running:
            return

        self._gui_frame += 1
        
        # Drain the thread-safe queue and apply updates in batch
        import queue
        q = self._source.queue
        
        snapshots = []
        updates = []
        trades = []
        
        while not q.empty():
            try:
                msg_type, obj = q.get_nowait()
                if msg_type == "snapshot":
                    snapshots.append(obj)
                    updates.clear()  # snapshot overrides past increments
                elif msg_type == "update":
                    updates.append(obj)
                elif msg_type == "trade":
                    trades.append(obj)
                q.task_done()
            except queue.Empty:
                break

        if snapshots:
            self._order_book.apply_snapshot(snapshots[-1])
        if updates:
            self._order_book.apply_updates(updates)
        for trade in trades:
            self._order_book.record_trade(trade)

        levels = self._order_book.get_levels()
        bbo = self._order_book.bbo

        self.heatmap.push_snapshot(levels, bbo, self._order_book.last_receive_timestamp)

        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            from types import SimpleNamespace
            prices = self.heatmap.get_visible_prices()
            profile_levels = [SimpleNamespace(price=p) for p in prices]
            self.volume_profile.set_row_height(self.heatmap.row_height)
            self.volume_profile.set_levels(profile_levels)

        if hasattr(self, '_dom_ladder') and self._dom_ladder is not None:
            self._dom_ladder.set_levels(levels)
            if bbo is not None:
                self._dom_ladder.set_bbo(bbo)

        if bbo is not None and bbo.bid > 0 and bbo.ask > 0:
            mid = (bbo.bid + bbo.ask) / 2.0
            self.price_chart.push_price(mid)

        if self._gui_frame % 30 == 0:
            self._update_status_message()

    def _update_status_message(self) -> None:
        bbo = self._order_book.bbo if self._order_book else None
        source_name = {
            DataSource.SIMULATOR: "SIM",
            DataSource.CRYPCODILE_REPLAY: "REPLAY",
            DataSource.CCXT_LIVE: "LIVE",
        }.get(self._source.data_source, "???")

        src = self._source
        if src.running and bbo and bbo.bid > 0 and bbo.ask > 0:
            vol = self._order_book.total_volume
            cvd = self._order_book.get_volume_delta()
            
            # Check if there is latency info
            latency_str = ""
            if src.data_source == DataSource.CCXT_LIVE and getattr(self.heatmap, 'last_latency_ms', None) is not None:
                latency_str = f"  |  Latency: {self.heatmap.last_latency_ms:.1f}ms"
                
            self._status.showMessage(
                f"[{source_name}] {self._order_book.symbol}  |  "
                f"Bid: {bbo.bid:.2f}  Ask: {bbo.ask:.2f}  |  "
                f"Spread: {bbo.spread:.4f}  |  "
                f"Vol: {vol:.0f}  |  CVD: {cvd:+.0f}{latency_str}")
        else:
            if src.data_source == DataSource.CCXT_LIVE:
                conn = (src.provider is not None
                        and getattr(src.provider, 'is_connected', False))
                conn_str = "Connected" if conn else "Disconnected"
            elif src.data_source == DataSource.CRYPCODILE_REPLAY:
                conn_str = "Ready" if src.provider is not None else "No data dir"
            else:
                conn_str = "Ready"
            self._status.showMessage(
                f"[{source_name}] {self._order_book.symbol}  |  {conn_str}  |  "
                f"F=follow  Space=toggle  +/−=zoom  R=reset  D=decay")

    # ── Keyboard shortcuts ─────────────────────────────────────────

    def keyPressEvent(self, event):
        k = event.key()
        if k == Qt.Key.Key_Space:
            self._source.toggle_simulation()
        elif k == Qt.Key.Key_F:
            self.heatmap.set_auto_follow(not self.heatmap.auto_follow)
            self._status.showMessage(
                f"Auto-follow: {'ON' if self.heatmap.auto_follow else 'OFF'}")
        elif k in (Qt.Key.Key_Plus, Qt.Key.Key_Equal):
            self.heatmap.zoom_in()
        elif k == Qt.Key.Key_Minus:
            self.heatmap.zoom_out()
        elif k == Qt.Key.Key_R:
            self.heatmap.reset_view()
            self._status.showMessage("View Reset: auto-follow ON, default zoom")
        elif k == Qt.Key.Key_D:
            current = self._toolbar_mgr.decay_slider.value()
            decays = [80, 85, 90, 95]
            try:
                idx = decays.index(current)
                next_val = decays[(idx + 1) % len(decays)]
            except ValueError:
                next_val = 88
            self._toolbar_mgr.decay_slider.setValue(next_val)
        else:
            super().keyPressEvent(event)

    def _on_row_height_changed(self, h: int) -> None:
        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            self.volume_profile.set_row_height(h)
            from types import SimpleNamespace
            prices = self.heatmap.get_visible_prices()
            profile_levels = [SimpleNamespace(price=p) for p in prices]
            self.volume_profile.set_levels(profile_levels)

    def closeEvent(self, event) -> None:
        self._source.stop_current()
        self._gui_timer.stop()
        event.accept()
