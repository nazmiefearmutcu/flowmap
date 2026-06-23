"""
FlowMap Main Window — Density-based Bookmap-style UI.
Layout: PriceChart (top 22%) + HeatmapWidget (bottom 78%).
Zero-flicker: WA_OpaquePaintEvent on all widgets, single drawImage per frame.

Data sources: Crypcodile Replay
"""
from __future__ import annotations

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QGridLayout, QStatusBar, QDockWidget,
    QSplitter, QFrame, QPushButton, QLabel, QDoubleSpinBox, QSizePolicy,
    QCheckBox, QComboBox, QTabWidget, QSlider
)
from PyQt6.QtGui import QAction

from ..core import Trade, BBO
from ..core.order_book import OrderBook
from .heatmap_widget import HeatmapWidget
from .dom.dom_ladder import DomLadder
from .pulse import MarketPulse
from .source_manager import SourceManager, DataSource
from .toolbar_manager import ToolbarManager
from .theme import MAIN_STYLESHEET, Colors, Fonts
from .panels.features_dialog import FeaturesDetailDialog


class MainWindow(QMainWindow):

    def __init__(self):
        super().__init__()
        self.setWindowTitle("FlowMap")
        self.resize(1500, 950)
        self.move(100, 100)
        self.setMinimumSize(900, 600)

        # ── Core data objects ──
        self._order_book = OrderBook("binance-spot:SOLUSDT", depth=3000)
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
        
        # Start immediately with Crypcodile Replay and auto-play
        self._source.switch_to(self._source.data_source)
        QTimer.singleShot(500, self._source.toggle_simulation)

    # ─────────────────────────────────────────────────────────────────
    #  UI setup — layout: price_chart, heatmap, toolbar, statusbar, sidebar
    # ─────────────────────────────────────────────────────────────────

    def _setup_ui(self) -> None:
        central = QWidget()
        central.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        central.setStyleSheet("background: #000000;")
        self.setCentralWidget(central)
        
        # Outer vertical layout: Splitter only (no top tabs)
        outer_layout = QVBoxLayout(central)
        outer_layout.setContentsMargins(0, 0, 0, 0)
        outer_layout.setSpacing(0)

        # ── Main Horizontal Splitter ──
        self.main_splitter = QSplitter(Qt.Orientation.Horizontal)
        self.main_splitter.setHandleWidth(1)
        self.main_splitter.setStyleSheet("QSplitter::handle { background-color: #1F222F; }")
        outer_layout.addWidget(self.main_splitter)

        # ── Left Visualizer Container ──
        left_container = QWidget()
        left_layout = QGridLayout(left_container)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(0)

        # HeatmapWidget in Row 0, Column 0
        self.heatmap = HeatmapWidget()
        left_layout.addWidget(self.heatmap, 0, 0)

        # Volume Profile Overlay in Row 0, Column 1
        from .overlays.volume_profile import VolumeProfileOverlay
        self.volume_profile = VolumeProfileOverlay()
        left_layout.addWidget(self.volume_profile, 0, 1)

        # Market Pulse (CVD) in Row 1, Column 0
        from .pulse import MarketPulse
        self._pulse = MarketPulse(heatmap=self.heatmap)
        left_layout.addWidget(self._pulse, 1, 0)

        # Spacer for CVD to align with Volume Profile on the right in Row 1, Column 1
        self.pulse_right_spacer = QWidget()
        self.pulse_right_spacer.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        self.pulse_right_spacer.setStyleSheet("background: #0C0D14; border-top: 1px solid #1F222F;")
        left_layout.addWidget(self.pulse_right_spacer, 1, 1)

        # Set column stretch factors for perfect visual grid alignment
        left_layout.setColumnStretch(0, 8)
        left_layout.setColumnStretch(1, 1)
        left_layout.setRowStretch(0, 5)
        left_layout.setRowStretch(1, 1)

        self.main_splitter.addWidget(left_container)

        # ── Right Sidebar Panel ──
        self.sidebar = QFrame()
        self.sidebar.setObjectName("sidebarPanel")
        self.sidebar.setFrameShape(QFrame.Shape.NoFrame)
        self.sidebar.setMinimumWidth(320)
        self.sidebar.setStyleSheet("""
            QFrame#sidebarPanel {
                background-color: #12131A;
                border-left: 1px solid #1F222F;
            }
            QLabel {
                color: #9499C3;
                font-size: 11px;
                font-weight: bold;
                background: transparent;
                border: none;
            }
            QCheckBox {
                color: #E2E4E9;
                font-size: 11px;
                spacing: 8px;
                background: transparent;
                border: none;
            }
            QCheckBox::indicator {
                width: 14px;
                height: 14px;
                background-color: #14151D;
                border: 1px solid #2C3043;
                border-radius: 3px;
            }
            QCheckBox::indicator:checked {
                background-color: #3B82F6;
                border-color: #3B82F6;
            }
            QDoubleSpinBox {
                background-color: #14151D;
                color: #E2E4E9;
                border: 1px solid #2C3043;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 11px;
            }
            QDoubleSpinBox:focus {
                border-color: #3B82F6;
            }
            QComboBox {
                background-color: #14151D;
                color: #E2E4E9;
                border: 1px solid #2C3043;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 11px;
            }
            QComboBox:focus {
                border-color: #3B82F6;
            }
            QSlider::groove:horizontal {
                border: 1px solid #1F222F;
                height: 4px;
                background: #14151D;
                border-radius: 2px;
            }
            QSlider::sub-page:horizontal {
                background: #3B82F6;
                border-radius: 2px;
            }
            QSlider::handle:horizontal {
                background: #FFFFFF;
                border: 1px solid #2C3043;
                width: 12px;
                height: 12px;
                margin-top: -4px;
                margin-bottom: -4px;
                border-radius: 6px;
            }
            QSlider::handle:horizontal:hover {
                background: #3B82F6;
                border-color: #3B82F6;
            }
        """)

        sidebar_layout = QVBoxLayout(self.sidebar)
        sidebar_layout.setContentsMargins(10, 10, 10, 10)
        sidebar_layout.setSpacing(10)

        # ── Sidebar Tab Widget ──
        self.sidebar_tabs = QTabWidget()
        self.sidebar_tabs.setStyleSheet("""
            QTabWidget::pane {
                border: none;
                background-color: #12131A;
            }
            QTabBar::tab {
                background-color: #0A0B10;
                color: #9499C3;
                border: 1px solid #1F222F;
                border-bottom: none;
                border-top-left-radius: 4px;
                border-top-right-radius: 4px;
                padding: 8px 16px;
                font-family: "Inter", sans-serif;
                font-size: 10px;
                font-weight: bold;
                letter-spacing: 0.5px;
            }
            QTabBar::tab:hover {
                color: #FFFFFF;
                background-color: #161824;
            }
            QTabBar::tab:selected {
                color: #3B82F6;
                background-color: #12131A;
                border-bottom: 2px solid #3B82F6;
            }
        """)
        sidebar_layout.addWidget(self.sidebar_tabs)

        # ── VISUALS TAB ──
        visuals_tab = QWidget()
        visuals_layout = QVBoxLayout(visuals_tab)
        visuals_layout.setContentsMargins(10, 16, 10, 16)
        visuals_layout.setSpacing(12)

        self.show_heatmap_cb = QCheckBox("Show Order Heatmap")
        self.show_heatmap_cb.setChecked(True)
        self.show_heatmap_cb.stateChanged.connect(self._on_show_heatmap_toggled)
        visuals_layout.addWidget(self.show_heatmap_cb)

        self.show_bbo_cb = QCheckBox("Show BBO Lines")
        self.show_bbo_cb.setChecked(True)
        self.show_bbo_cb.stateChanged.connect(self._on_show_bbo_toggled)
        visuals_layout.addWidget(self.show_bbo_cb)

        self.show_trades_cb = QCheckBox("Show Trades")
        self.show_trades_cb.setChecked(True)
        self.show_trades_cb.stateChanged.connect(self._on_show_trades_toggled)
        visuals_layout.addWidget(self.show_trades_cb)

        self.show_vp_cb = QCheckBox("Show Volume Profile")
        self.show_vp_cb.setChecked(True)
        self.show_vp_cb.stateChanged.connect(self._on_show_vp_toggled)
        visuals_layout.addWidget(self.show_vp_cb)

        visuals_layout.addStretch()
        self.sidebar_tabs.addTab(visuals_tab, "VISUALS")

        # ── INDICATORS TAB ──
        indicators_tab = QWidget()
        indicators_layout = QVBoxLayout(indicators_tab)
        indicators_layout.setContentsMargins(10, 16, 10, 16)
        indicators_layout.setSpacing(12)

        self.llt_checkbox = QCheckBox("Large Lot Tracker (LLT)")
        self.llt_checkbox.setChecked(True)
        self.llt_checkbox.stateChanged.connect(self._on_llt_toggled)
        indicators_layout.addWidget(self.llt_checkbox)

        llt_thresh_layout = QHBoxLayout()
        llt_thresh_lbl = QLabel("LLT Threshold:")
        llt_thresh_layout.addWidget(llt_thresh_lbl)
        self.llt_thresh_spinner = QDoubleSpinBox()
        self.llt_thresh_spinner.setRange(1.0, 50000.0)
        self.llt_thresh_spinner.setValue(self.heatmap.llt_threshold)
        self.llt_thresh_spinner.setSuffix(" Qty")
        self.llt_thresh_spinner.valueChanged.connect(self._on_llt_thresh_changed)
        llt_thresh_layout.addWidget(self.llt_thresh_spinner)
        indicators_layout.addLayout(llt_thresh_layout)

        self.iceberg_checkbox = QCheckBox("Iceberg Tracker")
        self.iceberg_checkbox.setChecked(True)
        self.iceberg_checkbox.stateChanged.connect(self._on_iceberg_toggled)
        indicators_layout.addWidget(self.iceberg_checkbox)

        self.stops_checkbox = QCheckBox("Stops Tracker")
        self.stops_checkbox.setChecked(True)
        self.stops_checkbox.stateChanged.connect(self._on_stops_toggled)
        indicators_layout.addWidget(self.stops_checkbox)

        stops_thresh_layout = QHBoxLayout()
        stops_thresh_lbl = QLabel("Stops Threshold:")
        stops_thresh_layout.addWidget(stops_thresh_lbl)
        self.stops_thresh_spinner = QDoubleSpinBox()
        self.stops_thresh_spinner.setRange(1.0, 50000.0)
        self.stops_thresh_spinner.setValue(self.heatmap.stop_threshold)
        self.stops_thresh_spinner.setSuffix(" Qty")
        self.stops_thresh_spinner.valueChanged.connect(self._on_stops_thresh_changed)
        stops_thresh_layout.addWidget(self.stops_thresh_spinner)
        indicators_layout.addLayout(stops_thresh_layout)

        self.pulse_checkbox = QCheckBox("Market Pulse Overlay")
        self.pulse_checkbox.setChecked(True)
        self.pulse_checkbox.stateChanged.connect(self._on_pulse_toggled)
        indicators_layout.addWidget(self.pulse_checkbox)

        indicators_layout.addStretch()
        self.sidebar_tabs.addTab(indicators_tab, "INDICATORS")

        # ── SETTINGS TAB ──
        settings_tab = QWidget()
        settings_layout = QVBoxLayout(settings_tab)
        settings_layout.setContentsMargins(10, 16, 10, 16)
        settings_layout.setSpacing(12)

        # Centering Mode Combobox
        centering_layout = QHBoxLayout()
        centering_lbl = QLabel("Centering Mode:")
        centering_layout.addWidget(centering_lbl)
        self.centering_mode_combo = QComboBox()
        self.centering_mode_combo.addItems(["Immediate", "Deadband", "EMA", "Smooth Deadband"])
        self.centering_mode_combo.setCurrentIndex(3)  # default Smooth Deadband
        self.centering_mode_combo.currentIndexChanged.connect(self._on_centering_mode_changed)
        centering_layout.addWidget(self.centering_mode_combo)
        settings_layout.addLayout(centering_layout)

        # Min order size filter
        filter_layout = QHBoxLayout()
        filter_lbl = QLabel("Min Order Size Filter:")
        filter_layout.addWidget(filter_lbl)
        self.min_size_spinner = QDoubleSpinBox()
        self.min_size_spinner.setRange(0.0, 100000.0)
        self.min_size_spinner.setValue(0.0)
        self.min_size_spinner.setSingleStep(1.0)
        self.min_size_spinner.setDecimals(1)
        self.min_size_spinner.setSuffix(" Qty")
        self.min_size_spinner.valueChanged.connect(self._on_min_size_changed)
        filter_layout.addWidget(self.min_size_spinner)
        settings_layout.addLayout(filter_layout)

        # Sliders helper function inside _setup_ui to stay clean
        def add_slider_row(parent_layout, label_text, min_val, max_val, init_val, callback):
            row_layout = QHBoxLayout()
            lbl = QLabel(label_text)
            row_layout.addWidget(lbl)
            
            slider = QSlider(Qt.Orientation.Horizontal)
            slider.setRange(min_val, max_val)
            slider.setValue(init_val)
            slider.valueChanged.connect(callback)
            
            val_lbl = QLabel("")
            row_layout.addWidget(slider)
            row_layout.addWidget(val_lbl)
            parent_layout.addLayout(row_layout)
            return slider, val_lbl

        # Decay slider
        self.decay_slider, self.decay_label = add_slider_row(
            settings_layout, "Decay:", 70, 99, 92, self._on_decay_changed
        )
        self._on_decay_changed(92)

        # Smoothness slider
        self.smooth_slider, self.smooth_label = add_slider_row(
            settings_layout, "Smooth:", 0, 30, 10, self._on_smoothness_changed
        )
        self._on_smoothness_changed(10)

        # Vertical Zoom slider (row height)
        self.zoom_slider, self.zoom_label = add_slider_row(
            settings_layout, "Vertical Zoom:", 2, 24, 4, self._on_zoom_changed
        )
        self._on_zoom_changed(4)

        # Horizontal Zoom slider (timeframe width index mapping)
        self.tf_slider, self.tf_label = add_slider_row(
            settings_layout, "Horizontal Zoom:", 0, 12, 3, self._on_timeframe_changed
        )
        self._on_timeframe_changed(3)

        # Volume Bubbles Size slider
        self.bubbles_slider, self.bubbles_scale_label = add_slider_row(
            settings_layout, "Bubbles Size:", 1, 50, 10, self._on_bubbles_scale_changed
        )
        self._on_bubbles_scale_changed(10)

        settings_layout.addStretch()
        self.sidebar_tabs.addTab(settings_tab, "SETTINGS")

        self.main_splitter.addWidget(self.sidebar)
        self.main_splitter.setSizes([1180, 320])

        # Set ratio: left visualizer takes most space, sidebar is fixed width
        self.main_splitter.setStretchFactor(0, 8)
        self.main_splitter.setStretchFactor(1, 1)

        # Toolbar — fully delegated to ToolbarManager
        self.addToolBar(self._toolbar_mgr.create_toolbar())

        # Status bar
        self._status = QStatusBar()
        self.setStatusBar(self._status)
        self._update_status_message()

        self.heatmap.price_hovered.connect(
            lambda p: self._status.showMessage(f"Price: {p:.2f}"))
        self.heatmap.row_height_changed.connect(self._on_row_height_changed)
        self.heatmap.column_width_changed.connect(self._on_column_width_changed)
        self.heatmap.view_changed.connect(self._on_heatmap_view_changed)

    def _setup_docks(self) -> None:
        # DOM Ladder (right, hidden)
        self._dom_ladder = DomLadder()
        self._dom_ladder_dock = QDockWidget("DOM Ladder (DOM Pro)", self)
        self._dom_ladder_dock.setWidget(self._dom_ladder)
        self._dom_ladder_dock.setAllowedAreas(
            Qt.DockWidgetArea.RightDockWidgetArea | Qt.DockWidgetArea.LeftDockWidgetArea)
        self._dom_ladder_dock.setMinimumWidth(300)
        self.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, self._dom_ladder_dock)
        self._dom_ladder_dock.hide()

        # View menu
        menu_bar = self.menuBar()
        view_menu = menu_bar.addMenu("&View")

        dom_action = QAction("DOM Ladder (DOM Pro)", self)
        dom_action.setCheckable(True)
        dom_action.setChecked(False)
        dom_action.toggled.connect(self._dom_ladder_dock.setVisible)
        self._dom_ladder_dock.visibilityChanged.connect(dom_action.setChecked)
        view_menu.addAction(dom_action)

        pulse_action = QAction("Market Pulse (CVD)", self)
        pulse_action.setCheckable(True)
        pulse_action.setChecked(True)
        pulse_action.toggled.connect(self.set_cvd_visible)
        view_menu.addAction(pulse_action)

    def _setup_timers(self) -> None:
        self._sim_timer.timeout.connect(self._sim_tick)
        self._gui_timer.timeout.connect(self._gui_tick)
        self._gui_timer.start(16)

    def _wire_callbacks(self) -> None:
        self._order_book.on_bbo = self._on_bbo
        self._order_book.on_trade = self._on_trade

    # ── Sidebar Callbacks ────────────────────────────────────────────

    def _on_show_heatmap_toggled(self, state: int) -> None:
        self.heatmap.show_heatmap = (state == 2 or state == True)
        self.heatmap.update()

    def _on_show_bbo_toggled(self, state: int) -> None:
        self.heatmap.show_bbo = (state == 2 or state == True)
        self.heatmap.update()

    def _on_show_trades_toggled(self, state: int) -> None:
        self.heatmap.show_trades = (state == 2 or state == True)
        self.heatmap.update()

    def _on_show_vp_toggled(self, state: int) -> None:
        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            self.volume_profile.setVisible(state == 2 or state == True)

    def _on_decay_changed(self, val: int) -> None:
        decay = val / 100.0
        if hasattr(self, 'decay_label') and self.decay_label is not None:
            self.decay_label.setText(f"{decay:.2f}")
        self.heatmap.set_decay(decay)

    def _on_smoothness_changed(self, val: int) -> None:
        smoothing = val / 10.0
        if hasattr(self, 'smooth_label') and self.smooth_label is not None:
            self.smooth_label.setText(f"{smoothing:.1f}")
        self.heatmap.set_vertical_smoothing(smoothing)

    def _on_zoom_changed(self, val: int) -> None:
        self.heatmap.set_row_height(val)
        if hasattr(self, 'zoom_label') and self.zoom_label is not None:
            self.zoom_label.setText(f"{val}px")

    def _on_timeframe_changed(self, val: int) -> None:
        levels = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0]
        w = levels[max(0, min(len(levels) - 1, val))]
        if hasattr(self, 'tf_label') and self.tf_label is not None:
            self.tf_label.setText(f"{w:.2f}x" if w < 1.0 else f"{int(w)}x" if w == int(w) else f"{w}x")
        self.heatmap.set_column_width(w)

    def _on_bubbles_scale_changed(self, val: int) -> None:
        scale = val / 10.0
        if hasattr(self, 'bubbles_scale_label') and self.bubbles_scale_label is not None:
            self.bubbles_scale_label.setText(f"{scale:.1f}x")
        self.heatmap.bubbles_size_multiplier = scale
        self.heatmap.update()

    def _on_centering_mode_changed(self, index: int) -> None:
        modes = ["immediate", "deadband", "ema", "smooth_deadband"]
        if 0 <= index < len(modes):
            self.heatmap._engine.centering_mode = modes[index]

    def _on_min_size_changed(self, val: float) -> None:
        """Tradermap Pro order size filter changed."""
        self.heatmap.set_min_order_size(val)

    def _on_llt_toggled(self, state: int) -> None:
        self.heatmap.llt_enabled = (state == 2 or state == True)
        self.heatmap.update()
        
    def _on_llt_thresh_changed(self, val: float) -> None:
        self.heatmap.llt_threshold = val
        self.heatmap.update()
        
    def _on_iceberg_toggled(self, state: int) -> None:
        self.heatmap.iceberg_enabled = (state == 2 or state == True)
        self.heatmap.update()
        
    def _on_stops_toggled(self, state: int) -> None:
        self.heatmap.stops_enabled = (state == 2 or state == True)
        self.heatmap.update()
        
    def _on_stops_thresh_changed(self, val: float) -> None:
        self.heatmap.stop_threshold = val
        self.heatmap.update()
        
    def _on_pulse_toggled(self, state: int) -> None:
        self.heatmap.pulse_enabled = (state == 2 or state == True)
        self.heatmap.update()

    def set_cvd_visible(self, visible: bool) -> None:
        self._pulse.setVisible(visible)
        self.pulse_right_spacer.setVisible(visible)

    # ── Data pipeline ───────────────────────────────────────────────

    def _sim_tick(self) -> None:
        pass

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

        # Drain the thread-safe queue up to a limit and apply updates in batch
        import queue
        q = self._source.queue
        
        snapshots = []
        updates = []
        trades = []
        bbos = []
        
        limit = 1000
        processed = 0
        while processed < limit and not q.empty():
            try:
                msg_type, obj = q.get_nowait()
                processed += 1
                if msg_type == "snapshot":
                    snapshots.append(obj)
                    updates.clear()  # snapshot overrides past increments
                    bbos.clear()     # snapshot overrides past increments
                elif msg_type == "update":
                    updates.append(obj)
                elif msg_type == "trade":
                    trades.append(obj)
                elif msg_type == "bbo":
                    bbos.append(obj)
                q.task_done()
            except queue.Empty:
                break

        has_updates = bool(snapshots or updates or trades or bbos)
        if not has_updates:
            return

        self._gui_frame += 1

        # Temporarily disable individual callbacks to prevent redundant UI updates and overhead
        self._order_book.on_trade = None

        if snapshots:
            self._order_book.apply_snapshot(snapshots[-1])
        if updates:
            self._order_book.apply_updates(updates)
        if bbos:
            self._order_book.apply_bbo(bbos[-1])
        if trades:
            self._order_book.record_trades(trades)

        # Restore callbacks
        self._order_book.on_trade = self._on_trade

        if trades:
            self.heatmap.add_trades(trades)
            self._pulse.add_trades(trades)
            if hasattr(self, 'volume_profile') and self.volume_profile is not None:
                self.volume_profile.add_trades(trades)

        levels = self._order_book.get_levels()
        bbo = self._order_book.bbo

        cvd = self._order_book.get_volume_delta()
        self.heatmap.push_snapshot(levels, bbo, self._order_book.last_receive_timestamp, cvd=cvd)

        if hasattr(self, '_dom_ladder') and self._dom_ladder is not None:
            self._dom_ladder.set_levels(levels)
            if bbo is not None:
                self._dom_ladder.set_bbo(bbo)

        if self._gui_frame % 30 == 0:
            self._update_status_message()

    def _update_status_message(self) -> None:
        bbo = self._order_book.bbo if self._order_book else None
        source_name = {
            DataSource.CRYPCODILE_REPLAY: "REPLAY",
            DataSource.CRYPCODILE_LIVE: "LIVE",
        }.get(self._source.data_source, "???")

        src = self._source
        if src.running and bbo and bbo.bid > 0 and bbo.ask > 0:
            vol = self._order_book.total_volume
            cvd = self._order_book.get_volume_delta()
            
            # Check if there is latency info
            latency_str = ""
            if getattr(self.heatmap, 'last_latency_ms', None) is not None:
                latency_str = f"  |  Latency: {self.heatmap.last_latency_ms:.1f}ms"
                
            self._status.showMessage(
                f"[{source_name}] {self._order_book.symbol}  |  "
                f"Bid: {bbo.bid:.2f}  Ask: {bbo.ask:.2f}  |  "
                f"Spread: {bbo.spread:.4f}  |  "
                f"Vol: {vol:.0f}  |  CVD: {cvd:+.0f}{latency_str}")
        else:
            if src.data_source == DataSource.CRYPCODILE_LIVE:
                conn_str = "Ready" if src.provider is not None else "Not Ready"
            else:
                conn_str = "Ready" if src.provider is not None else "No data dir"
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
            if hasattr(self, 'decay_slider') and self.decay_slider is not None:
                current = self.decay_slider.value()
                decays = [80, 85, 90, 95]
                try:
                    idx = decays.index(current)
                    next_val = decays[(idx + 1) % len(decays)]
                except ValueError:
                    next_val = 88
                self.decay_slider.setValue(next_val)
        else:
            super().keyPressEvent(event)

    def _on_row_height_changed(self, h: int) -> None:
        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            self.volume_profile.set_row_height(h)
            from types import SimpleNamespace
            prices = self.heatmap.get_visible_prices()
            profile_levels = [SimpleNamespace(price=p) for p in prices]
            self.volume_profile.set_levels(profile_levels)
        self._update_zoom_slider(h)

    def _on_column_width_changed(self, w: float) -> None:
        self._update_timeframe_slider(w)

    def _on_heatmap_view_changed(self) -> None:
        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            from types import SimpleNamespace
            prices = self.heatmap.get_visible_prices()
            profile_levels = [SimpleNamespace(price=p) for p in prices]
            self.volume_profile.set_row_height(self.heatmap.row_height)
            self.volume_profile.set_levels(profile_levels)
        if hasattr(self, '_pulse') and self._pulse is not None:
            self._pulse.update()

    def _update_zoom_slider(self, val: int) -> None:
        if hasattr(self, 'zoom_slider') and self.zoom_slider is not None:
            self.zoom_slider.blockSignals(True)
            self.zoom_slider.setValue(val)
            self.zoom_slider.blockSignals(False)
        if hasattr(self, 'zoom_label') and self.zoom_label is not None:
            self.zoom_label.setText(f"{val}px")

    def _update_timeframe_slider(self, val: float) -> None:
        levels = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0]
        try:
            closest_val = min(levels, key=lambda x: abs(x - val))
            idx = levels.index(closest_val)
        except ValueError:
            idx = 3
        if hasattr(self, 'tf_slider') and self.tf_slider is not None:
            self.tf_slider.blockSignals(True)
            self.tf_slider.setValue(idx)
            self.tf_slider.blockSignals(False)
        w = levels[idx]
        if hasattr(self, 'tf_label') and self.tf_label is not None:
            self.tf_label.setText(f"{w:.2f}x" if w < 1.0 else f"{int(w)}x" if w == int(w) else f"{w}x")


    def closeEvent(self, event) -> None:
        self._source.stop_current()
        self._gui_timer.stop()
        event.accept()
