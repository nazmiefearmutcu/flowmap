"""
ToolbarManager — widget creation, visibility, slider callbacks, and button state.

Encapsulates ALL toolbar logic so MainWindow stays lean.
"""
from __future__ import annotations
from typing import Optional, TYPE_CHECKING

from PyQt6.QtCore import QObject, Qt
from PyQt6.QtWidgets import (
    QLabel, QPushButton, QSlider, QComboBox, QLineEdit, QToolBar, QStatusBar,
)

from .source_manager import DataSource, SourceManager, HAS_CRYPCODILE_REPLAY

if TYPE_CHECKING:
    from .main_window import MainWindow


class ToolbarManager(QObject):
    """Manages toolbar widget creation, visibility, slider callbacks, and button state.

    Owns the layout-aware logic for showing/hiding controls per data source mode
    and handles slider value change events.
    """

    def __init__(self, window: 'MainWindow', source_mgr: SourceManager):
        super().__init__(parent=window)
        self._window = window
        self._source = source_mgr

        # Widget references — populated by create_toolbar()
        self._source_combo: Optional[QComboBox] = None
        self._symbol_edit: Optional[QLineEdit] = None
        self._replay_speed_label_title: Optional[QLabel] = None
        self._replay_speed_slider: Optional[QSlider] = None
        self._replay_speed_label: Optional[QLabel] = None
        self._speed_label_title: Optional[QLabel] = None
        self._speed_slider: Optional[QSlider] = None
        self._speed_label: Optional[QLabel] = None
        self._decay_slider: Optional[QSlider] = None
        self._decay_label: Optional[QLabel] = None
        self._zoom_slider: Optional[QSlider] = None
        self._start_btn: Optional[QPushButton] = None
        self._connect_btn: Optional[QPushButton] = None
        self._source_indicator: Optional[QLabel] = None

    # ─────────────────────────────────────────────────────────────────
    #  Toolbar creation — called once from MainWindow._setup_ui
    # ─────────────────────────────────────────────────────────────────

    def create_toolbar(self) -> QToolBar:
        """Build the full toolbar with all widgets and signal wiring.
        Returns the QToolBar ready to be added to the main window."""

        tb = QToolBar()
        tb.setMovable(False)

        src = self._source

        # ── Data source selector ──
        tb.addWidget(QLabel("Source:"))
        self._source_combo = QComboBox()
        self._source_combo.addItem("Simulator", DataSource.SIMULATOR)
        if HAS_CRYPCODILE_REPLAY:
            self._source_combo.addItem("Crypcodile Replay", DataSource.CRYPCODILE_REPLAY)
        else:
            self._source_combo.addItem("Crypcodile Replay (N/A)", None)
        self._source_combo.addItem("CCXT Live", DataSource.CCXT_LIVE)
        self._source_combo.currentIndexChanged.connect(src.on_source_combo_changed)
        tb.addWidget(self._source_combo)

        tb.addSeparator()

        # ── Symbol selector ──
        tb.addWidget(QLabel("Symbol:"))
        self._symbol_edit = QLineEdit()
        self._symbol_edit.setText(src.symbol)
        self._symbol_edit.setFixedWidth(120)
        self._symbol_edit.setPlaceholderText("BTC/USDT")
        self._symbol_edit.editingFinished.connect(src.on_symbol_changed)
        tb.addWidget(self._symbol_edit)

        tb.addSeparator()

        # ── Replay speed slider (hidden by default) ──
        self._replay_speed_label_title = QLabel("Replay:")
        tb.addWidget(self._replay_speed_label_title)
        self._replay_speed_slider = QSlider(Qt.Orientation.Horizontal)
        self._replay_speed_slider.setRange(5, 100)
        self._replay_speed_slider.setValue(10)
        self._replay_speed_slider.setFixedWidth(100)
        self._replay_speed_slider.valueChanged.connect(self.on_replay_speed)
        self._replay_speed_slider.setToolTip("Replay speed (0.5x – 10.0x)")
        tb.addWidget(self._replay_speed_slider)
        self._replay_speed_label = QLabel("1.0×")
        tb.addWidget(self._replay_speed_label)

        tb.addSeparator()

        # ── Sim speed slider ──
        self._speed_label_title = QLabel("Speed:")
        tb.addWidget(self._speed_label_title)
        self._speed_slider = QSlider(Qt.Orientation.Horizontal)
        self._speed_slider.setRange(1, 30)
        self._speed_slider.setValue(8)
        self._speed_slider.setFixedWidth(120)
        self._speed_slider.valueChanged.connect(self.on_speed)
        tb.addWidget(self._speed_slider)
        self._speed_label = QLabel("2.0×")
        tb.addWidget(self._speed_label)

        tb.addSeparator()

        # ── Decay slider ──
        tb.addWidget(QLabel("Decay:"))
        self._decay_slider = QSlider(Qt.Orientation.Horizontal)
        self._decay_slider.setRange(70, 99)
        self._decay_slider.setValue(92)
        self._decay_slider.setFixedWidth(100)
        self._decay_slider.valueChanged.connect(self.on_decay)
        tb.addWidget(self._decay_slider)
        self._decay_label = QLabel("0.92")
        tb.addWidget(self._decay_label)

        tb.addSeparator()

        # ── Vertical Smoothing slider ──
        tb.addWidget(QLabel("Smooth:"))
        self._smooth_slider = QSlider(Qt.Orientation.Horizontal)
        self._smooth_slider.setRange(0, 30)
        self._smooth_slider.setValue(10)
        self._smooth_slider.setFixedWidth(100)
        self._smooth_slider.valueChanged.connect(self.on_smoothing)
        tb.addWidget(self._smooth_slider)
        self._smooth_label = QLabel("1.0")
        tb.addWidget(self._smooth_label)

        tb.addSeparator()

        # ── Zoom slider ──
        tb.addWidget(QLabel("Zoom:"))
        self._zoom_slider = QSlider(Qt.Orientation.Horizontal)
        self._zoom_slider.setRange(2, 24)
        self._zoom_slider.setValue(4)
        self._zoom_slider.setFixedWidth(100)
        self._zoom_slider.valueChanged.connect(self._window.heatmap.set_row_height)
        tb.addWidget(self._zoom_slider)

        tb.addSeparator()

        # ── Start / Stop button ──
        self._start_btn = QPushButton("\u25b6 Start")
        self._start_btn.setObjectName("startBtn")
        self._start_btn.clicked.connect(src.toggle_simulation)
        tb.addWidget(self._start_btn)

        # ── Connect / Disconnect button (live mode; hidden by default) ──
        self._connect_btn = QPushButton("Connect")
        self._connect_btn.setObjectName("connectBtn")
        self._connect_btn.clicked.connect(src.on_connect_clicked)
        tb.addWidget(self._connect_btn)

        tb.addSeparator()

        # ── Source indicator badge ──
        self._source_indicator = QLabel("SIM")
        self._source_indicator.setStyleSheet(
            "color: #60ff60; font-weight: bold; padding: 2px 6px;"
            "background: #0a1a0a; border-radius: 3px;")
        tb.addWidget(self._source_indicator)

        return tb

    # ─────────────────────────────────────────────────────────────────
    #  Convenience accessors for MainWindow (keyPressEvent / closeEvent)
    # ─────────────────────────────────────────────────────────────────

    @property
    def decay_slider(self) -> Optional[QSlider]:
        return self._decay_slider

    @property
    def status_bar(self) -> Optional[QStatusBar]:
        return self._window._status

    # ─────────────────────────────────────────────────────────────────
    #  Visibility management
    # ─────────────────────────────────────────────────────────────────

    def update_visibility(self, source: DataSource, connected: bool = False) -> None:
        """Show/hide toolbar widgets based on current data source."""
        is_sim = source == DataSource.SIMULATOR
        is_replay = source == DataSource.CRYPCODILE_REPLAY
        is_live = source == DataSource.CCXT_LIVE

        if self._speed_label_title:
            self._speed_label_title.setVisible(is_sim)
        if self._speed_slider:
            self._speed_slider.setVisible(is_sim)
        if self._speed_label:
            self._speed_label.setVisible(is_sim)

        if self._replay_speed_label_title:
            self._replay_speed_label_title.setVisible(is_replay)
        if self._replay_speed_slider:
            self._replay_speed_slider.setVisible(is_replay)
        if self._replay_speed_label:
            self._replay_speed_label.setVisible(is_replay)

        if self._connect_btn:
            self._connect_btn.setVisible(is_live)

        if self._start_btn:
            self._start_btn.setVisible(is_sim or is_replay)

        if self._symbol_edit:
            self._symbol_edit.setReadOnly(is_sim)
            self._symbol_edit.setVisible(True)

        self._update_source_indicator(source, connected)

    def _update_source_indicator(self, source: DataSource, connected: bool) -> None:
        if not self._source_indicator:
            return
        if source == DataSource.SIMULATOR:
            self._source_indicator.setText("SIM")
            self._source_indicator.setStyleSheet(
                "color: #60ff60; font-weight: bold; padding: 2px 6px;"
                "background: #0a1a0a; border-radius: 3px;")
        elif source == DataSource.CRYPCODILE_REPLAY:
            self._source_indicator.setText("REPLAY")
            self._source_indicator.setStyleSheet(
                "color: #ffcc60; font-weight: bold; padding: 2px 6px;"
                "background: #1a1a0a; border-radius: 3px;")
        elif source == DataSource.CCXT_LIVE:
            if connected:
                self._source_indicator.setText("LIVE ●")
                self._source_indicator.setStyleSheet(
                    "color: #ff6060; font-weight: bold; padding: 2px 6px;"
                    "background: #1a0a0a; border-radius: 3px;")
            else:
                self._source_indicator.setText("LIVE ○")
                self._source_indicator.setStyleSheet(
                    "color: #ff8888; font-weight: bold; padding: 2px 6px;"
                    "background: #1a0a0a; border-radius: 3px;")

    # ─────────────────────────────────────────────────────────────────
    #  Button state management
    # ─────────────────────────────────────────────────────────────────

    def set_start_stop_state(self, running: bool) -> None:
        if not self._start_btn:
            return
        if running:
            self._start_btn.setText("\u25a0 Stop")
            self._start_btn.style().unpolish(self._start_btn)
            self._start_btn.setObjectName("stopBtn")
            self._start_btn.style().polish(self._start_btn)
        else:
            self._start_btn.setText("\u25b6 Start")
            self._start_btn.style().unpolish(self._start_btn)
            self._start_btn.setObjectName("startBtn")
            self._start_btn.style().polish(self._start_btn)

    def set_connected_state(self, connected: bool) -> None:
        if not self._connect_btn:
            return
        if connected:
            self._connect_btn.setText("Disconnect")
            self._connect_btn.style().unpolish(self._connect_btn)
            self._connect_btn.setObjectName("disconnectBtn")
            self._connect_btn.style().polish(self._connect_btn)
        else:
            self._connect_btn.setText("Connect")
            self._connect_btn.style().unpolish(self._connect_btn)
            self._connect_btn.setObjectName("connectBtn")
            self._connect_btn.style().polish(self._connect_btn)

    # ─────────────────────────────────────────────────────────────────
    #  Slider callbacks
    # ─────────────────────────────────────────────────────────────────

    def on_replay_speed(self, val: int) -> None:
        self._source.replay_speed = val / 10.0
        if self._replay_speed_label:
            self._replay_speed_label.setText(f"{self._source.replay_speed:.1f}×")

    def on_speed(self, val: int) -> None:
        self._source.sim_speed = max(val / 4.0, 0.01)
        if self._speed_label:
            self._speed_label.setText(f"{self._source.sim_speed:.1f}×")
        if (self._source.running
                and self._source.data_source == DataSource.SIMULATOR):
            _safe_speed = max(self._source.sim_speed, 0.01)
            self._window._sim_timer.setInterval(int(1000 / (60 * _safe_speed)))

    def on_decay(self, val: int) -> None:
        decay = val / 100.0
        if self._decay_label:
            self._decay_label.setText(f"{decay:.2f}")
        self._window.heatmap.set_decay(decay)

    def on_smoothing(self, val: int) -> None:
        smoothing = val / 10.0
        if self._smooth_label:
            self._smooth_label.setText(f"{smoothing:.1f}")
        self._window.heatmap.set_vertical_smoothing(smoothing)
