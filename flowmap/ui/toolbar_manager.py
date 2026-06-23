from __future__ import annotations
from typing import Optional, TYPE_CHECKING

from PyQt6.QtCore import QObject, Qt
from PyQt6.QtWidgets import (
    QLabel, QPushButton, QLineEdit, QToolBar, QDoubleSpinBox, QComboBox,
)

from .source_manager import DataSource, SourceManager

if TYPE_CHECKING:
    from .main_window import MainWindow


class ToolbarManager(QObject):
    """Manages a clean toolbar containing only symbol input, replay speed spinbox,
    start/stop toggle, and sidebar toggle.
    """

    def __init__(self, window: MainWindow, source_mgr: SourceManager):
        super().__init__(parent=window)
        self._window = window
        self._source = source_mgr

        # Widget references
        self._source_combo: Optional[QComboBox] = None
        self._symbol_edit: Optional[QLineEdit] = None
        self._replay_speed_spinner: Optional[QDoubleSpinBox] = None
        self._start_btn: Optional[QPushButton] = None
        self._sidebar_btn: Optional[QPushButton] = None

    def create_toolbar(self) -> QToolBar:
        tb = QToolBar()
        tb.setMovable(False)
        tb.setStyleSheet("""
            QToolBar {
                background-color: #0A0B10;
                border-bottom: 1px solid #1F222F;
                spacing: 8px;
                padding: 4px;
            }
            QLabel {
                color: #9499C3;
                font-size: 11px;
                font-weight: bold;
            }
            QLineEdit {
                background-color: #14151D;
                color: #E2E4E9;
                border: 1px solid #2C3043;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 11px;
            }
            QLineEdit:focus {
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
            QPushButton {
                background-color: #14151D;
                color: #E2E4E9;
                border: 1px solid #2C3043;
                border-radius: 4px;
                padding: 6px 12px;
                font-size: 11px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #1F222F;
                color: #FFFFFF;
            }
            QPushButton#startBtn {
                background-color: #1B3A2B;
                color: #4ADE80;
                border-color: #22C55E;
            }
            QPushButton#startBtn:hover {
                background-color: #22C55E;
                color: #FFFFFF;
            }
            QPushButton#stopBtn {
                background-color: #3A1B1B;
                color: #F87171;
                border-color: #EF4444;
            }
            QPushButton#stopBtn:hover {
                background-color: #EF4444;
                color: #FFFFFF;
            }
            QPushButton#sidebarBtn:checked {
                color: #3B82F6;
                background-color: #1A3050;
                border-color: #3B82F6;
            }
        """)

        # ── Source selector ──
        tb.addWidget(QLabel(" Source: "))
        self._source_combo = QComboBox()
        self._source_combo.addItems(["Replay", "Live"])
        default_index = 0
        if self._source and self._source.data_source == DataSource.CRYPCODILE_LIVE:
            default_index = 1
        self._source_combo.setCurrentIndex(default_index)
        self._source_combo.currentIndexChanged.connect(self._on_source_changed)
        self._source_combo.setStyleSheet("""
            QComboBox {
                background-color: #14151D;
                color: #E2E4E9;
                border: 1px solid #2C3043;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 11px;
                min-width: 80px;
            }
            QComboBox QAbstractItemView {
                background-color: #14151D;
                color: #E2E4E9;
                selection-background-color: #1F222F;
                selection-color: #FFFFFF;
                border: 1px solid #2C3043;
            }
        """)
        tb.addWidget(self._source_combo)

        tb.addSeparator()

        # ── Symbol selector ──
        tb.addWidget(QLabel(" Symbol: "))
        self._symbol_edit = QLineEdit()
        self._symbol_edit.setText(self._source.symbol if self._source else "binance-spot:SOLUSDT")
        self._symbol_edit.setFixedWidth(140)
        self._symbol_edit.setPlaceholderText("binance-spot:SOLUSDT")
        if self._source:
            self._symbol_edit.editingFinished.connect(self._source.on_symbol_changed)
        tb.addWidget(self._symbol_edit)

        tb.addSeparator()

        # ── Replay speed spinbox ──
        tb.addWidget(QLabel(" Replay: "))
        self._replay_speed_spinner = QDoubleSpinBox()
        self._replay_speed_spinner.setRange(0.1, 20.0)
        self._replay_speed_spinner.setValue(20.0)
        self._replay_speed_spinner.setSingleStep(0.1)
        self._replay_speed_spinner.setDecimals(1)
        self._replay_speed_spinner.setSuffix("x")
        self._replay_speed_spinner.setFixedWidth(80)
        self._replay_speed_spinner.setEnabled(default_index == 0)
        self._replay_speed_spinner.valueChanged.connect(self._on_replay_speed_changed)
        tb.addWidget(self._replay_speed_spinner)

        tb.addSeparator()

        # ── Start / Stop button ──
        self._start_btn = QPushButton("\u25b6 Start")
        self._start_btn.setObjectName("startBtn")
        if self._source:
            self._start_btn.clicked.connect(self._source.toggle_simulation)
        tb.addWidget(self._start_btn)

        tb.addSeparator()

        # ── Sidebar toggle button ──
        self._sidebar_btn = QPushButton("Sidebar")
        self._sidebar_btn.setObjectName("sidebarBtn")
        self._sidebar_btn.setCheckable(True)
        self._sidebar_btn.setChecked(True)
        self._sidebar_btn.clicked.connect(self._on_sidebar_toggled)
        tb.addWidget(self._sidebar_btn)

        return tb

    def _on_replay_speed_changed(self, val: float) -> None:
        if self._source:
            self._source.replay_speed = val

    def _on_source_changed(self, index: int) -> None:
        if not self._source:
            return
        if index == 0:
            self._source.switch_to(DataSource.CRYPCODILE_REPLAY)
        elif index == 1:
            self._source.switch_to(DataSource.CRYPCODILE_LIVE)

    def _on_sidebar_toggled(self, checked: bool) -> None:
        self._window.sidebar.setVisible(checked)

    def set_start_stop_state(self, running: bool) -> None:
        if not self._start_btn:
            return
        if running:
            self._start_btn.setText("\u25a0 Stop")
            self._start_btn.setObjectName("stopBtn")
            self._start_btn.style().unpolish(self._start_btn)
            self._start_btn.style().polish(self._start_btn)
        else:
            self._start_btn.setText("\u25b6 Start")
            self._start_btn.setObjectName("startBtn")
            self._start_btn.style().unpolish(self._start_btn)
            self._start_btn.style().polish(self._start_btn)

    def update_visibility(self, source: DataSource, connected: bool = False) -> None:
        pass

    def set_connected_state(self, connected: bool) -> None:
        pass
