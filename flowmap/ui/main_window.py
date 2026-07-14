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
    QCheckBox, QComboBox, QTabWidget, QSlider, QTableWidget, QTableWidgetItem, QHeaderView
)
from PyQt6.QtGui import QAction

from ..core import Trade, BBO, Side
from ..core.order_book import OrderBook
from .heatmap_widget import HeatmapWidget
from .dom.dom_ladder import DomLadder
from .pulse import MarketPulse
from .source_manager import (
    SourceManager,
    DataSource,
    adaptive_drain_limit,
    parse_queue_item,
)
from .toolbar_manager import ToolbarManager
from ..ssl_bootstrap import bootstrap_ssl
from .theme import MAIN_STYLESHEET, Colors, Fonts, get_main_stylesheet
from .panels.features_dialog import FeaturesDetailDialog


def decide_column_paint(
    has_updates: bool,
    idle_frames: int,
    *,
    idle_every: int = 3,
) -> tuple[bool, int]:
    """Decide whether to advance a heatmap column this GUI tick.

    * Always paint when the queue delivered market data.
    * On idle, paint every ``idle_every`` ticks (~20 Hz at 16 ms GUI) so the
      time axis keeps scrolling without burning the history buffer at 60 Hz.

    Returns ``(should_paint, next_idle_frames)``.
    """
    if has_updates:
        return True, 0
    idle_frames = int(idle_frames) + 1
    if idle_frames >= max(1, int(idle_every)):
        return True, 0
    return False, idle_frames


class MainWindow(QMainWindow):

    def __init__(self, symbol: str = "binance-spot:SOLUSDT", data_dir: str | None = None, historical_hours: float = 2.0):
        super().__init__()
        # Ensure certifi CA is used when system cert store is empty (embedded
        # Crypcodile FlowmapWindow path never goes through run_flowmap.py).
        bootstrap_ssl()
        import os
        # Portable default: env → ~/data if present → cwd (never a machine-specific path)
        if not data_dir:
            data_dir = os.environ.get("FLOWMAP_DATA_DIR") or (
                os.path.expanduser("~/data")
                if os.path.isdir(os.path.expanduser("~/data"))
                else "."
            )
        self._data_dir = data_dir
        self.setWindowTitle("FlowMap")
        self.resize(1500, 950)
        self.move(100, 100)
        self.setMinimumSize(900, 600)

        # ── Core data objects ──
        self._order_book = OrderBook(symbol, depth=3000)
        self._sim_timer = QTimer(self)
        self._gui_timer = QTimer(self)
        self._gui_frame: int = 0
        self._historical_hours = historical_hours

        # ── Managers ──
        self._toolbar_mgr = ToolbarManager(self, None)  # source_mgr set below
        self._source = SourceManager(self, self._toolbar_mgr)
        self._source.symbol = symbol
        self._source.replay_data_dir = data_dir
        self._toolbar_mgr._source = self._source  # complete the two-way link

        # ── Dark theme (resolve Inter → system sans when missing) ──
        self.setStyleSheet(get_main_stylesheet())

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
        self.volume_profile = VolumeProfileOverlay(heatmap=self.heatmap)
        self.volume_profile.set_order_book(self._order_book)
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
        left_layout.setColumnStretch(1, 2)
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
        self.sidebar_tabs.setElideMode(Qt.TextElideMode.ElideNone)
        self.sidebar_tabs.setDocumentMode(True)
        tab_bar = self.sidebar_tabs.tabBar()
        if tab_bar is not None:
            tab_bar.setExpanding(True)
        _tab_sans = Fonts.resolved_sans()
        self.sidebar_tabs.setStyleSheet(f"""
            QTabWidget::pane {{
                border: none;
                background-color: #12131A;
            }}
            QTabBar::tab {{
                background-color: #0A0B10;
                color: #9499C3;
                border: 1px solid #1F222F;
                border-bottom: none;
                border-top-left-radius: 4px;
                border-top-right-radius: 4px;
                padding: 6px 10px;
                font-family: "{_tab_sans}", sans-serif;
                font-size: 9px;
                font-weight: bold;
                letter-spacing: 0.5px;
            }}
            QTabBar::tab:hover {{
                color: #FFFFFF;
                background-color: #161824;
            }}
            QTabBar::tab:selected {{
                color: #3B82F6;
                background-color: #12131A;
                border-bottom: 2px solid #3B82F6;
            }}
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

        # Sub-checkboxes for specific profiles
        self.show_cob_cb = QCheckBox("  Show COB (Book Depth)")
        self.show_cob_cb.setChecked(True)
        self.show_cob_cb.stateChanged.connect(self._on_show_cob_toggled)
        visuals_layout.addWidget(self.show_cob_cb)

        self.show_cvp_cb = QCheckBox("  Show CVP (Chart Vol)")
        self.show_cvp_cb.setChecked(True)
        self.show_cvp_cb.stateChanged.connect(self._on_show_cvp_toggled)
        visuals_layout.addWidget(self.show_cvp_cb)

        self.show_svp_cb = QCheckBox("  Show SVP (Session Vol)")
        self.show_svp_cb.setChecked(True)
        self.show_svp_cb.stateChanged.connect(self._on_show_svp_toggled)
        visuals_layout.addWidget(self.show_svp_cb)

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
        from PyQt6.QtWidgets import QScrollArea, QGroupBox
        settings_scroll = QScrollArea()
        settings_scroll.setWidgetResizable(True)
        settings_scroll.setFrameShape(QFrame.Shape.NoFrame)
        settings_scroll.setStyleSheet("background-color: transparent;")
        
        settings_scroll_widget = QWidget()
        settings_layout = QVBoxLayout(settings_scroll_widget)
        settings_layout.setContentsMargins(10, 10, 10, 10)
        settings_layout.setSpacing(12)

        # ── Visible Sidebars ──
        sidebars_group = QGroupBox("Visible Sidebars")
        sidebars_group.setStyleSheet("""
            QGroupBox {
                color: #9499C3;
                font-weight: bold;
                border: 1px solid #1F222F;
                border-radius: 4px;
                margin-top: 10px;
                padding-top: 12px;
                font-size: 10px;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                subcontrol-position: top left;
                left: 8px;
                padding: 0 3px;
            }
        """)
        sidebars_layout = QVBoxLayout(sidebars_group)
        sidebars_layout.setSpacing(8)
        
        self.show_sidebar_cb = QCheckBox("Main Sidebar Panel")
        self.show_sidebar_cb.setChecked(True)
        self.show_sidebar_cb.stateChanged.connect(self._on_toggle_sidebar_cb)
        sidebars_layout.addWidget(self.show_sidebar_cb)
        
        self.show_icebergs_cb = QCheckBox("Significant Icebergs")
        self.show_icebergs_cb.setChecked(True)
        self.show_icebergs_cb.stateChanged.connect(lambda state: self._iceberg_dock.setVisible(state == 2))
        sidebars_layout.addWidget(self.show_icebergs_cb)
        
        self.show_llt_cb = QCheckBox("Large Lot Tracker")
        self.show_llt_cb.setChecked(True)
        self.show_llt_cb.stateChanged.connect(lambda state: self._llt_dock.setVisible(state == 2))
        sidebars_layout.addWidget(self.show_llt_cb)
        
        self.show_dom_cb = QCheckBox("DOM Ladder")
        self.show_dom_cb.setChecked(False)
        self.show_dom_cb.stateChanged.connect(lambda state: self._dom_ladder_dock.setVisible(state == 2))
        sidebars_layout.addWidget(self.show_dom_cb)
        
        settings_layout.addWidget(sidebars_group)

        # ── Replay Settings ──
        replay_group = QGroupBox("Replay Settings")
        replay_group.setStyleSheet("""
            QGroupBox {
                color: #9499C3;
                font-weight: bold;
                border: 1px solid #1F222F;
                border-radius: 4px;
                margin-top: 10px;
                padding-top: 12px;
                font-size: 10px;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                subcontrol-position: top left;
                left: 8px;
                padding: 0 3px;
            }
        """)
        replay_group_layout = QVBoxLayout(replay_group)
        replay_group_layout.setSpacing(8)
        
        self.enable_replay_cb = QCheckBox("Enable Replay Mode")
        # Explicit AX name: nested QGroupBox + QScrollArea often drops the
        # checkbox from macOS accessibility without this (Ghost find = 0).
        self.enable_replay_cb.setObjectName("enableReplayMode")
        self.enable_replay_cb.setAccessibleName("Enable Replay Mode")
        self.enable_replay_cb.setAccessibleDescription(
            "Switch data source between live exchange feed and local Crypcodile replay"
        )
        is_replay = False
        if self._source and self._source.data_source == DataSource.CRYPCODILE_REPLAY:
            is_replay = True
        self.enable_replay_cb.setChecked(is_replay)
        self.enable_replay_cb.stateChanged.connect(self._on_replay_mode_toggled)
        replay_group_layout.addWidget(self.enable_replay_cb)
        # Ensure Replay Settings group itself is named for AX discovery.
        replay_group.setAccessibleName("Replay Settings")
        replay_group.setObjectName("replaySettingsGroup")
        
        self.replay_settings_container = QWidget()
        replay_settings_layout = QVBoxLayout(self.replay_settings_container)
        replay_settings_layout.setContentsMargins(0, 4, 0, 0)
        
        speed_row = QHBoxLayout()
        speed_lbl = QLabel("Speed:")
        speed_row.addWidget(speed_lbl)
        self.replay_speed_spin = QDoubleSpinBox()
        self.replay_speed_spin.setRange(0.1, 20.0)
        self.replay_speed_spin.setValue(20.0)
        self.replay_speed_spin.setSingleStep(0.1)
        self.replay_speed_spin.setDecimals(1)
        self.replay_speed_spin.setSuffix("x")
        self.replay_speed_spin.valueChanged.connect(self._on_replay_speed_changed)
        speed_row.addWidget(self.replay_speed_spin)
        replay_settings_layout.addLayout(speed_row)
        
        replay_group_layout.addWidget(self.replay_settings_container)
        settings_layout.addWidget(replay_group)
        
        self.replay_settings_container.setVisible(is_replay)

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

        # Decay was a dead control (FIND-P207-05 snapshot paint has no accumulation).
        # Keep attributes for any key-binding callers but hide the row so SETTINGS
        # does not advertise a non-functional slider (endless-loop UX audit).
        self.decay_slider, self.decay_label = add_slider_row(
            settings_layout, "Decay:", 70, 99, 92, self._on_decay_changed
        )
        self._on_decay_changed(92)
        self.decay_slider.setEnabled(False)
        self.decay_slider.setVisible(False)
        if self.decay_label is not None:
            self.decay_label.setVisible(False)
        # Hide the whole row's label widget if present as left sibling
        try:
            layout_item = settings_layout.itemAt(settings_layout.count() - 1)
            if layout_item is not None and layout_item.layout() is not None:
                row = layout_item.layout()
                for i in range(row.count()):
                    w = row.itemAt(i).widget()
                    if w is not None:
                        w.setVisible(False)
        except Exception:
            pass

        # Smoothness slider
        self.smooth_slider, self.smooth_label = add_slider_row(
            settings_layout, "Smooth:", 0, 30, 10, self._on_smoothness_changed
        )
        self._on_smoothness_changed(10)

        # Heatmap Sensitivity slider
        self.sensitivity_slider, self.sensitivity_label = add_slider_row(
            settings_layout, "Sensitivity:", 100, 10000, 3000, self._on_sensitivity_changed
        )
        self._on_sensitivity_changed(3000)

        # Volume Bubbles Size slider
        self.bubbles_slider, self.bubbles_scale_label = add_slider_row(
            settings_layout, "Bubbles Size:", 1, 50, 10, self._on_bubbles_scale_changed
        )
        self._on_bubbles_scale_changed(10)

        settings_layout.addStretch()
        
        # Add scroll widget to scroll area and scroll area to settings_tab
        settings_scroll.setWidget(settings_scroll_widget)
        tab_layout = QVBoxLayout(settings_tab)
        tab_layout.setContentsMargins(0, 0, 0, 0)
        tab_layout.addWidget(settings_scroll)
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

        # Significant Iceberg Tracker
        from PyQt6.QtWidgets import QTableWidget, QTableWidgetItem, QHeaderView
        self._iceberg_dock = QDockWidget("Significant Icebergs", self)
        self._iceberg_widget = QWidget()
        self._iceberg_layout = QVBoxLayout(self._iceberg_widget)
        
        # Filter controls
        filter_layout = QHBoxLayout()
        filter_layout.addWidget(QLabel("Min Size:"))
        self._min_iceberg_size_spin = QDoubleSpinBox()
        self._min_iceberg_size_spin.setRange(0.01, 100000.0)
        self._min_iceberg_size_spin.setValue(1.0)
        self._min_iceberg_size_spin.setSingleStep(0.5)
        self._min_iceberg_size_spin.setSuffix(" Qty")
        filter_layout.addWidget(self._min_iceberg_size_spin)
        
        clear_btn = QPushButton("Clear")
        clear_btn.clicked.connect(self._clear_iceberg_table)
        filter_layout.addWidget(clear_btn)
        
        self._iceberg_layout.addLayout(filter_layout)
        
        # Table
        self._iceberg_table = QTableWidget(0, 5)
        self._iceberg_table.setHorizontalHeaderLabels(["Time", "Side", "Price", "Size", "Hidden"])
        self._iceberg_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self._iceberg_table.verticalHeader().setVisible(False)
        self._iceberg_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self._iceberg_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self._iceberg_table.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._iceberg_table.verticalHeader().setDefaultSectionSize(22)
        
        self._iceberg_layout.addWidget(self._iceberg_table)
        self._iceberg_dock.setWidget(self._iceberg_widget)
        self.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, self._iceberg_dock)

        # Large Lot Tracker
        self._llt_dock = QDockWidget("Large Lot Tracker", self)
        self._llt_widget = QWidget()
        self._llt_layout = QVBoxLayout(self._llt_widget)
        
        # Filter controls
        llt_filter_layout = QHBoxLayout()
        llt_filter_layout.addWidget(QLabel("Min Size:"))
        self._min_llt_size_spin = QDoubleSpinBox()
        self._min_llt_size_spin.setRange(0.01, 100000.0)
        self._min_llt_size_spin.setValue(self.heatmap.llt_threshold)
        self._min_llt_size_spin.setSingleStep(1.0)
        self._min_llt_size_spin.setSuffix(" Qty")
        self._min_llt_size_spin.valueChanged.connect(self._on_llt_thresh_spin_changed)
        llt_filter_layout.addWidget(self._min_llt_size_spin)
        
        self._llt_layout.addLayout(llt_filter_layout)
        
        # Table
        self._llt_table = QTableWidget(0, 3)
        self._llt_table.setHorizontalHeaderLabels(["Side", "Price", "Size"])
        self._llt_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self._llt_table.verticalHeader().setVisible(False)
        self._llt_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self._llt_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self._llt_table.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._llt_table.verticalHeader().setDefaultSectionSize(22)
        
        self._llt_layout.addWidget(self._llt_table)
        self._llt_dock.setWidget(self._llt_widget)
        self.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, self._llt_dock)

        # Apply unified premium styles to both docks
        _sans = Fonts.resolved_sans()
        dock_style = f"""
            QWidget {{
                background-color: #0E1017;
                color: #E2E4E9;
                font-family: "{_sans}", sans-serif;
                font-size: 10px;
            }}
            QLabel {{
                color: #9499C3;
                font-weight: bold;
            }}
            QDoubleSpinBox {{
                background-color: #14151D;
                color: #E2E4E9;
                border: 1px solid #2C3043;
                border-radius: 4px;
                padding: 2px 6px;
            }}
            QDoubleSpinBox:focus {{
                border-color: #3B82F6;
            }}
            QPushButton {{
                background-color: #1F222F;
                color: #E2E4E9;
                border: 1px solid #2C3043;
                border-radius: 4px;
                padding: 3px 10px;
                font-weight: bold;
            }}
            QPushButton:hover {{
                background-color: #2C3043;
                border-color: #3B82F6;
            }}
            QTableWidget {{
                background-color: #0E1017;
                color: #B4B9C6;
                gridline-color: #1F222F;
                border: 1px solid #1F222F;
            }}
            QTableWidget::item:selected {{
                background-color: #1A1D2B;
                color: #FFFFFF;
            }}
            QHeaderView::section {{
                background-color: #181B26;
                color: #E3E6EE;
                padding: 4px;
                border: 1px solid #1F222F;
                font-weight: bold;
            }}
        """
        self._iceberg_widget.setStyleSheet(dock_style)
        self._llt_widget.setStyleSheet(dock_style)

        # View menu
        menu_bar = self.menuBar()
        view_menu = menu_bar.addMenu("&View")

        dom_action = QAction("DOM Ladder (DOM Pro)", self)
        dom_action.setCheckable(True)
        dom_action.setChecked(False)
        dom_action.toggled.connect(self._dom_ladder_dock.setVisible)
        self._dom_ladder_dock.visibilityChanged.connect(dom_action.setChecked)
        self._dom_ladder_dock.visibilityChanged.connect(self._on_dom_visibility_changed)
        view_menu.addAction(dom_action)

        iceberg_action = QAction("Significant Icebergs", self)
        iceberg_action.setCheckable(True)
        iceberg_action.setChecked(True)
        iceberg_action.toggled.connect(self._iceberg_dock.setVisible)
        self._iceberg_dock.visibilityChanged.connect(iceberg_action.setChecked)
        self._iceberg_dock.visibilityChanged.connect(self._on_iceberg_visibility_changed)
        view_menu.addAction(iceberg_action)

        llt_action = QAction("Large Lot Tracker", self)
        llt_action.setCheckable(True)
        llt_action.setChecked(True)
        llt_action.toggled.connect(self._llt_dock.setVisible)
        self._llt_dock.visibilityChanged.connect(llt_action.setChecked)
        self._llt_dock.visibilityChanged.connect(self._on_llt_visibility_changed)
        view_menu.addAction(llt_action)

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
        self.heatmap.iceberg_detected.connect(self._on_iceberg_detected)

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
        is_visible = (state == 2 or state == True)
        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            self.volume_profile.setVisible(is_visible)
        if hasattr(self, 'show_cob_cb'):
            self.show_cob_cb.setEnabled(is_visible)
            self.show_cvp_cb.setEnabled(is_visible)
            self.show_svp_cb.setEnabled(is_visible)

    def _on_show_cob_toggled(self, state: int) -> None:
        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            self.volume_profile.show_cob = (state == 2 or state == True)
            self.volume_profile.update()

    def _on_show_cvp_toggled(self, state: int) -> None:
        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            self.volume_profile.show_cvp = (state == 2 or state == True)
            self.volume_profile.update()

    def _on_show_svp_toggled(self, state: int) -> None:
        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            self.volume_profile.show_svp = (state == 2 or state == True)
            self.volume_profile.update()

    def _on_decay_changed(self, val: int) -> None:
        # Decay has no paint effect until accumulation is implemented (FIND-P207-05)
        decay = val / 100.0
        if hasattr(self, 'decay_label') and self.decay_label is not None:
            if hasattr(self, 'decay_slider') and self.decay_slider is not None and not self.decay_slider.isEnabled():
                self.decay_label.setText("n/a")
            else:
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
        if hasattr(self, '_min_llt_size_spin') and self._min_llt_size_spin is not None:
            self._min_llt_size_spin.blockSignals(True)
            self._min_llt_size_spin.setValue(val)
            self._min_llt_size_spin.blockSignals(False)
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

    def _on_sensitivity_changed(self, val: int) -> None:
        if hasattr(self, 'sensitivity_label') and self.sensitivity_label is not None:
            self.sensitivity_label.setText(str(val))
        if hasattr(self, 'heatmap') and self.heatmap is not None:
            self.heatmap._engine._bid_normalizer.global_ref = float(val)
            self.heatmap._engine._ask_normalizer.global_ref = float(val)
            self.heatmap.update()

    def _on_replay_mode_toggled(self, state: int) -> None:
        is_checked = (state == 2)
        self.replay_settings_container.setVisible(is_checked)
        if not self._source:
            return
        from flowmap.ui.source_manager import DataSource
        if is_checked:
            self._source.switch_to(DataSource.CRYPCODILE_REPLAY)
        else:
            self._source.switch_to(DataSource.CRYPCODILE_LIVE)

    def _on_replay_speed_changed(self, val: float) -> None:
        if self._source:
            self._source.replay_speed = val

    def _on_iceberg_visibility_changed(self, visible: bool) -> None:
        if hasattr(self, 'show_icebergs_cb') and self.show_icebergs_cb is not None:
            self.show_icebergs_cb.blockSignals(True)
            self.show_icebergs_cb.setChecked(visible)
            self.show_icebergs_cb.blockSignals(False)

    def _on_llt_visibility_changed(self, visible: bool) -> None:
        if hasattr(self, 'show_llt_cb') and self.show_llt_cb is not None:
            self.show_llt_cb.blockSignals(True)
            self.show_llt_cb.setChecked(visible)
            self.show_llt_cb.blockSignals(False)

    def _on_dom_visibility_changed(self, visible: bool) -> None:
        if hasattr(self, 'show_dom_cb') and self.show_dom_cb is not None:
            self.show_dom_cb.blockSignals(True)
            self.show_dom_cb.setChecked(visible)
            self.show_dom_cb.blockSignals(False)

    def _on_toggle_sidebar_cb(self, state: int) -> None:
        visible = (state == 2)
        self.sidebar.setVisible(visible)
        if hasattr(self, '_toolbar_mgr') and self._toolbar_mgr is not None:
            self._toolbar_mgr._sidebar_btn.blockSignals(True)
            self._toolbar_mgr._sidebar_btn.setChecked(visible)
            self._toolbar_mgr._sidebar_btn.blockSignals(False)

    # ── Data pipeline ───────────────────────────────────────────────

    def _sim_tick(self) -> None:
        pass

    def _on_bbo(self, bbo: BBO) -> None:
        pass

    def _on_trade(self, trade: Trade) -> None:
        self.heatmap.add_trade(
            trade.price, trade.size, trade.side,
            is_liquidation=trade.is_liquidation,
            timestamp=trade.timestamp,
        )
        self._pulse.add_trade(trade.price, trade.size, trade.side)
        if hasattr(self, 'volume_profile') and self.volume_profile is not None:
            self.volume_profile.add_trade(trade.price, trade.size)

    def _gui_tick(self) -> None:
        if not self._order_book or not self._source.running:
            return

        # Drain the thread-safe queue up to an adaptive limit and apply in batch
        import queue
        q = self._source.queue
        current_session = self._source.session_id

        snapshots = []
        updates = []
        trades = []
        bbos = []

        # Adaptive drain (FIND-P214 residual): deeper backlog → larger batch,
        # hard-capped so a single tick cannot starve the UI forever.
        try:
            qsize_est = q.qsize()
        except Exception:
            qsize_est = 1000
        limit = adaptive_drain_limit(qsize_est)
        processed = 0
        while processed < limit and not q.empty():
            try:
                item = q.get_nowait()
                processed += 1
                parsed = parse_queue_item(item, current_session)
                if parsed is None:
                    # Stale session or malformed — drop (FIND-P222-02)
                    try:
                        q.task_done()
                    except ValueError:
                        pass
                    continue
                msg_type, obj = parsed
                if msg_type == "snapshot":
                    snapshots.append(obj)
                    updates.clear()  # snapshot overrides past increments
                    bbos.clear()     # snapshot overrides past increments
                    # Trades before the snapshot are already reflected in the L2
                    # book state of S; re-applying them after apply_snapshot would
                    # double-absorb residual size (FIND-P215-01). Keep only trades
                    # that arrive after the last snapshot in this drain batch.
                    trades.clear()
                elif msg_type == "update":
                    updates.append(obj)
                elif msg_type == "trade":
                    trades.append(obj)
                elif msg_type == "bbo":
                    bbos.append(obj)
                try:
                    q.task_done()
                except ValueError:
                    pass
            except queue.Empty:
                break

        has_updates = bool(snapshots or updates or trades or bbos)

        if has_updates:
            # Temporarily disable individual callbacks to prevent redundant UI updates
            # Always restore via finally (FIND-P216-01)
            prev_on_trade = self._order_book.on_trade
            try:
                self._order_book.on_trade = None
                if snapshots:
                    self._order_book.apply_snapshot(snapshots[-1])
                if updates:
                    self._order_book.apply_updates(updates)
                if bbos:
                    self._order_book.apply_bbo(bbos[-1])
                if trades:
                    self._order_book.record_trades(trades)
            finally:
                self._order_book.on_trade = prev_on_trade

            if trades:
                self.heatmap.add_trades(trades)
                self._pulse.add_trades(trades)
                if hasattr(self, 'volume_profile') and self.volume_profile is not None:
                    self.volume_profile.add_trades(trades)

        levels = self._order_book.get_levels()
        if not levels:
            # No book yet — keep empty-state overlay; do not invent columns.
            return

        # Bookmap-style time axis: always paint on real market events.
        # When the WS is quiet, still advance columns but at most ~20 Hz so
        # idle time does not burn the history buffer at 60 identical frames/s.
        should_paint, self._idle_col_frames = decide_column_paint(
            has_updates, getattr(self, "_idle_col_frames", 0), idle_every=3
        )
        if not should_paint:
            return

        self._gui_frame += 1
        bbo = self._order_book.bbo
        cvd = self._order_book.get_volume_delta()
        self.heatmap.push_snapshot(levels, bbo, self._order_book.last_receive_timestamp, cvd=cvd)

        # Side panels: refresh on data bursts; throttle when only time-advancing.
        refresh_side = has_updates or (self._gui_frame % 6 == 0)
        if refresh_side:
            self._update_llt_table(levels)
            if hasattr(self, 'volume_profile') and self.volume_profile is not None:
                self.volume_profile.update()
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
            # Queue backlog observability (detect silent stall vs healthy flow)
            q_str = ""
            try:
                qn = src.queue.qsize()
                if qn > 0:
                    q_str = f"  |  Q:{qn}"
            except Exception:
                pass
                
            self._status.showMessage(
                f"[{source_name}] {self._order_book.symbol}  |  "
                f"Bid: {bbo.bid:.2f}  Ask: {bbo.ask:.2f}  |  "
                f"Spread: {bbo.spread:.4f}  |  "
                f"Vol: {vol:.0f}  |  CVD: {cvd:+.0f}{latency_str}{q_str}")
        else:
            if src.data_source == DataSource.CRYPCODILE_LIVE:
                conn_str = "Ready" if src.provider is not None else "Not Ready"
            else:
                conn_str = "Ready" if src.provider is not None else "No data dir"
            self._status.showMessage(
                f"[{source_name}] {self._order_book.symbol}  |  {conn_str}  |  "
                f"F=follow  Space=start/stop  wheel=zoom  Ctrl+wheel=pan  +/−=zoom  R=reset")

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
            # Decay control disabled until accumulation is implemented (FIND-P207-05)
            if hasattr(self, 'decay_slider') and self.decay_slider is not None and self.decay_slider.isEnabled():
                current = self.decay_slider.value()
                decays = [80, 85, 90, 95]
                try:
                    idx = decays.index(current)
                    next_val = decays[(idx + 1) % len(decays)]
                except ValueError:
                    next_val = 88
                self.decay_slider.setValue(next_val)
            else:
                self._status.showMessage("Decay: not implemented (instant snapshot)")
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


    def _on_iceberg_detected(self, data: dict) -> None:
        min_size = self._min_iceberg_size_spin.value()
        size = data['size']
        if size < min_size:
            return
            
        import datetime
        from PyQt6.QtGui import QColor
        t_str = datetime.datetime.fromtimestamp(data['timestamp']).strftime('%H:%M:%S')
        side_str = "BUY" if data['side'] == Side.BUY or data['side'] == 1 or str(data['side']).lower() == "buy" else "SELL"
        price = data['price']
        hidden = data['hidden_vol']
        
        # Insert row at the top
        self._iceberg_table.insertRow(0)
        
        item_time = QTableWidgetItem(t_str)
        item_side = QTableWidgetItem(side_str)
        if side_str == "BUY":
            item_side.setForeground(QColor(Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue()))
        else:
            item_side.setForeground(QColor(Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue()))
            
        item_price = QTableWidgetItem(f"{price:.2f}")
        item_size = QTableWidgetItem(f"{size:.2f}")
        item_hidden = QTableWidgetItem(f"{hidden:.2f}")
        
        # Set text alignments
        for item in [item_time, item_side, item_price, item_size, item_hidden]:
            item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            
        self._iceberg_table.setItem(0, 0, item_time)
        self._iceberg_table.setItem(0, 1, item_side)
        self._iceberg_table.setItem(0, 2, item_price)
        self._iceberg_table.setItem(0, 3, item_size)
        self._iceberg_table.setItem(0, 4, item_hidden)
        
        # Limit rows to 100 to avoid memory growth
        if self._iceberg_table.rowCount() > 100:
            self._iceberg_table.removeRow(self._iceberg_table.rowCount() - 1)

    def _clear_iceberg_table(self) -> None:
        # Block a11y queries during model teardown — avoids
        # QAccessibleTable::cellAt invalid index spam on clear.
        self._iceberg_table.setUpdatesEnabled(False)
        self._iceberg_table.blockSignals(True)
        try:
            self._iceberg_table.clearContents()
            self._iceberg_table.setRowCount(0)
        finally:
            self._iceberg_table.blockSignals(False)
            self._iceberg_table.setUpdatesEnabled(True)
        # Also drop on-chart iceberg/stop markers so Clear is not half-done.
        if hasattr(self, "heatmap") and self.heatmap is not None:
            try:
                self.heatmap._iceberg_markers.clear()
                self.heatmap._iceberg_accum_data.clear()
                self.heatmap._stop_markers.clear()
                self.heatmap._cache_dirty = True
                self.heatmap.update()
            except Exception:
                pass

    def _on_llt_thresh_spin_changed(self, val: float) -> None:
        self.heatmap.llt_threshold = val
        self.heatmap.update()

    def _update_llt_table(self, levels: list) -> None:
        if not hasattr(self, '_llt_table') or self._llt_table is None:
            return
            
        thresh = self.heatmap.llt_threshold
        large_lots = []
        for lvl in levels:
            price = getattr(lvl, "price", 0.0)
            bid_sz = getattr(lvl, "bid_size", 0.0)
            ask_sz = getattr(lvl, "ask_size", 0.0)
            
            if bid_sz >= thresh:
                large_lots.append(("BID", price, bid_sz))
            if ask_sz >= thresh:
                large_lots.append(("ASK", price, ask_sz))
                
        # Sort large lots by price descending
        large_lots.sort(key=lambda x: x[1], reverse=True)
        
        # Limit rows for performance
        large_lots = large_lots[:50]
        
        # Populate without flooding QAccessibleTable during row churn
        self._llt_table.setUpdatesEnabled(False)
        self._llt_table.blockSignals(True)
        try:
            self._llt_table.setRowCount(len(large_lots))
            from PyQt6.QtGui import QColor
            for row_idx, (side_str, price, size) in enumerate(large_lots):
                item_side = QTableWidgetItem(side_str)
                if side_str == "BID":
                    item_side.setForeground(QColor(Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue()))
                else:
                    item_side.setForeground(QColor(Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue()))
                    
                item_price = QTableWidgetItem(f"{price:.2f}")
                item_size = QTableWidgetItem(f"{size:.2f}")
                
                for item in [item_side, item_price, item_size]:
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                    
                self._llt_table.setItem(row_idx, 0, item_side)
                self._llt_table.setItem(row_idx, 1, item_price)
                self._llt_table.setItem(row_idx, 2, item_size)
        finally:
            self._llt_table.blockSignals(False)
            self._llt_table.setUpdatesEnabled(True)

    def closeEvent(self, event) -> None:
        self._source.stop_current()
        self._gui_timer.stop()
        event.accept()
