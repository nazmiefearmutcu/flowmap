"""FlowMap Dark Theme — centralized constants and styles."""
from PyQt6.QtGui import QColor, QFont

# ── Color Palette ──
class Colors:
    BG_DEEP = QColor(10, 11, 16)              # Obsidian deep background
    BG_PANEL = QColor(18, 19, 26)            # Slate panel background
    BG_CHART = QColor(12, 13, 20)            # Chart background
    BG_BUTTON = QColor(26, 28, 36)           # Button background
    BG_BUTTON_HOVER = QColor(34, 37, 48)     # Button hover background
    BG_INPUT = QColor(20, 21, 29)            # Input background
    BG_INPUT_HOVER = QColor(26, 28, 36)      # Input hover background
    BG_TOOLBAR = QColor(18, 19, 26)          # Toolbar background
    BG_STATUSBAR = QColor(12, 13, 20)        # Statusbar background
    BG_DOCK = QColor(18, 19, 26)             # Dock background
    BG_DOCK_TITLE = QColor(26, 28, 36)       # Dock title background

    BORDER_SUBTLE = QColor(31, 34, 47)       # Subtle border color
    BORDER_MEDIUM = QColor(44, 48, 67)       # Medium border color
    BORDER_CHART = QColor(60, 66, 92)        # Chart border color
    BORDER_STATUSBAR = QColor(31, 34, 47)    # Statusbar border color

    TEXT_PRIMARY = QColor(226, 228, 233)     # Off-white primary text
    TEXT_SECONDARY = QColor(148, 153, 195)   # Slate-blue secondary text
    TEXT_DIM = QColor(95, 100, 128)          # Muted violet-gray text
    TEXT_BRIGHT = QColor(255, 255, 255)      # Bright white text

    ACCENT_GREEN = QColor(16, 185, 129)      # Emerald Green
    ACCENT_RED = QColor(239, 68, 68)         # Vibrant Crimson
    ACCENT_BLUE = QColor(59, 130, 246)       # Cyber Blue
    ACCENT_YELLOW = QColor(245, 158, 11)     # Amber Yellow

    # Button-specific
    BTN_START_BG = QColor(14, 58, 47)        # Dark emerald
    BTN_START_BG_HOVER = QColor(18, 75, 61)
    BTN_STOP_BG = QColor(62, 24, 27)         # Dark crimson
    BTN_STOP_BG_HOVER = QColor(82, 31, 36)
    BTN_CONNECT_BG = QColor(15, 46, 74)       # Dark steel blue
    BTN_CONNECT_BG_HOVER = QColor(21, 63, 100)
    BTN_DISCONNECT_BG = QColor(62, 24, 27)
    BTN_DISCONNECT_BG_HOVER = QColor(82, 31, 36)

    # Chart
    CHART_LINE = QColor(59, 130, 246)        # Cyber Blue line
    CHART_FILL = QColor(59, 130, 246, 35)    # Translucent Cyber Blue area
    CHART_GRID = QColor(44, 48, 67)          # Medium border for grid
    CHART_ZERO = QColor(95, 100, 128, 100)

    # CVD / Pulse
    CVD_POSITIVE_LINE = QColor(16, 185, 129)
    CVD_NEGATIVE_LINE = QColor(239, 68, 68)
    CVD_POSITIVE_FILL = QColor(16, 185, 129, 45)
    CVD_NEGATIVE_FILL = QColor(239, 68, 68, 45)

    # Slider
    SLIDER_GROOVE = QColor(20, 21, 29)
    SLIDER_HANDLE = QColor(148, 153, 195)    # Slate-blue

    # Splitter
    SPLITTER_HANDLE = QColor(31, 34, 47)


# ── Fonts ──
class Fonts:
    MONO = "JetBrains Mono"
    SANS = "Inter"

    @staticmethod
    def mono(size: int, bold: bool = False) -> QFont:
        w = QFont.Weight.Bold if bold else QFont.Weight.Normal
        font = QFont(Fonts.MONO, size)
        font.setWeight(w)
        font.setFamilies([Fonts.MONO, "Menlo", "Courier New", "monospace"])
        return font

    @staticmethod
    def sans(size: int, bold: bool = False) -> QFont:
        w = QFont.Weight.Bold if bold else QFont.Weight.Normal
        font = QFont(Fonts.SANS, size)
        font.setWeight(w)
        font.setFamilies([Fonts.SANS, "Segoe UI", "Helvetica Neue", "Arial", "sans-serif"])
        return font


# ── Main Stylesheet ──
MAIN_STYLESHEET = """
    /* Main Window Background */
    QMainWindow {
        background-color: #0A0B10;
    }

    /* Menu Bar Styling */
    QMenuBar {
        background-color: #0A0B10;
        color: #E2E4E9;
        border-bottom: 1px solid #1F222F;
        font-family: "Inter", "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 11px;
    }
    QMenuBar::item {
        background: transparent;
        padding: 4px 10px;
        border-radius: 4px;
    }
    QMenuBar::item:selected {
        background-color: #1F222F;
        color: #FFFFFF;
    }
    QMenuBar::item:pressed {
        background-color: #2C3043;
    }

    /* Menu Styling */
    QMenu {
        background-color: #12131A;
        color: #E2E4E9;
        border: 1px solid #1F222F;
        border-radius: 6px;
        padding: 4px 0px;
        font-family: "Inter", "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 11px;
    }
    QMenu::item {
        padding: 6px 20px;
        border-radius: 4px;
        margin: 2px 4px;
    }
    QMenu::item:selected {
        background-color: #3B82F6;
        color: #FFFFFF;
    }
    QMenu::separator {
        height: 1px;
        background-color: #1F222F;
        margin: 4px 0px;
    }

    /* Toolbar Styling */
    QToolBar {
        background-color: #12131A;
        border-bottom: 1px solid #1F222F;
        spacing: 8px;
        padding: 4px 12px;
    }
    QToolBar::separator {
        width: 1px;
        background-color: #1F222F;
        margin: 4px 2px;
    }

    /* Statusbar Styling */
    QStatusBar {
        background-color: #0C0D14;
        color: #9499C3;
        border-top: 1px solid #1F222F;
        font-family: "Inter", "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 11px;
        padding-left: 10px;
    }

    /* Label Styling */
    QLabel {
        color: #9499C3;
        font-family: "Inter", "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 11px;
        font-weight: 500;
    }

    /* Button Styling */
    QPushButton {
        background-color: #1A1C24;
        color: #E2E4E9;
        border: 1px solid #2C3043;
        border-radius: 5px;
        padding: 5px 14px;
        font-family: "Inter", "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 11px;
        font-weight: 600;
    }
    QPushButton:hover {
        background-color: #222530;
        border-color: #3C425C;
        color: #FFFFFF;
    }
    QPushButton:pressed {
        background-color: #15161D;
        border-color: #3B82F6;
    }

    /* Specific Action Buttons */
    QPushButton#startBtn {
        background-color: #0E3A2F;
        color: #A7F3D0;
        border: 1px solid #10B981;
    }
    QPushButton#startBtn:hover {
        background-color: #124B3D;
        color: #FFFFFF;
        border-color: #34D399;
    }
    QPushButton#startBtn:pressed {
        background-color: #0A2D24;
    }

    QPushButton#stopBtn {
        background-color: #3E181B;
        color: #FCA5A5;
        border: 1px solid #EF4444;
    }
    QPushButton#stopBtn:hover {
        background-color: #521F24;
        color: #FFFFFF;
        border-color: #F87171;
    }
    QPushButton#stopBtn:pressed {
        background-color: #2F1113;
    }

    QPushButton#connectBtn {
        background-color: #0F2E4A;
        color: #93C5FD;
        border: 1px solid #3B82F6;
    }
    QPushButton#connectBtn:hover {
        background-color: #153F64;
        color: #FFFFFF;
        border-color: #60A5FA;
    }
    QPushButton#connectBtn:pressed {
        background-color: #0B2237;
    }

    QPushButton#disconnectBtn {
        background-color: #3E181B;
        color: #FCA5A5;
        border: 1px solid #EF4444;
    }
    QPushButton#disconnectBtn:hover {
        background-color: #521F24;
        color: #FFFFFF;
        border-color: #F87171;
    }
    QPushButton#disconnectBtn:pressed {
        background-color: #2F1113;
    }

    /* Input Fields */
    QLineEdit {
        background-color: #14151D;
        color: #E2E4E9;
        border: 1px solid #2C3043;
        border-radius: 5px;
        padding: 4px 8px;
        font-family: "Inter", "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 11px;
    }
    QLineEdit:hover {
        border-color: #3C425C;
    }
    QLineEdit:focus {
        border-color: #3B82F6;
        background-color: #1A1C24;
    }

    /* Combobox Styling */
    QComboBox {
        background-color: #1A1C24;
        color: #E2E4E9;
        border: 1px solid #2C3043;
        border-radius: 5px;
        padding: 4px 24px 4px 8px;
        font-family: "Inter", "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 11px;
    }
    QComboBox:hover {
        background-color: #222530;
        border-color: #3C425C;
    }
    QComboBox:focus {
        border-color: #3B82F6;
    }
    QComboBox::drop-down {
        subcontrol-origin: padding;
        subcontrol-position: top right;
        width: 20px;
        border-left: none;
    }
    QComboBox::down-arrow {
        image: none;
        border: none;
        width: 0;
        height: 0;
        border-left: 4px solid transparent;
        border-right: 4px solid transparent;
        border-top: 5px solid #9499C3;
        margin-right: 8px;
    }
    QComboBox::down-arrow:hover {
        border-top-color: #FFFFFF;
    }
    QComboBox QAbstractItemView {
        background-color: #12131A;
        color: #E2E4E9;
        border: 1px solid #1F222F;
        border-radius: 6px;
        selection-background-color: #3B82F6;
        selection-color: #FFFFFF;
        padding: 4px;
        outline: 0px;
    }

    /* Sliders styling */
    QSlider::groove:horizontal {
        height: 6px;
        background-color: #14151D;
        border: 1px solid #2C3043;
        border-radius: 3px;
    }
    QSlider::sub-page:horizontal {
        background-color: #3B82F6;
        border-radius: 3px;
    }
    QSlider::handle:horizontal {
        background-color: #E2E4E9;
        border: 1px solid #2C3043;
        width: 14px;
        height: 14px;
        margin-top: -5px;
        margin-bottom: -5px;
        border-radius: 7px;
    }
    QSlider::handle:horizontal:hover {
        background-color: #FFFFFF;
        border-color: #3B82F6;
    }
    QSlider::handle:horizontal:pressed {
        background-color: #3B82F6;
        border-color: #E2E4E9;
    }

    /* Splitter Styling */
    QSplitter::handle {
        background-color: #1F222F;
    }
    QSplitter::handle:hover {
        background-color: #3B82F6;
    }

    /* Dock Widget Styling */
    QDockWidget {
        background-color: #12131A;
        color: #E2E4E9;
        titlebar-close-icon: none;
        border: 1px solid #1F222F;
        font-family: "Inter", "Segoe UI", "Helvetica Neue", sans-serif;
        font-size: 11px;
    }
    QDockWidget::title {
        background-color: #1A1C24;
        padding: 6px 12px;
        text-align: left;
        border-bottom: 1px solid #1F222F;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: #9499C3;
    }

    /* Scrollbars Styling to complete dark look */
    QScrollBar:vertical {
        background-color: #0A0B10;
        width: 10px;
        margin: 0px;
    }
    QScrollBar::handle:vertical {
        background-color: #222530;
        min-height: 20px;
        border-radius: 5px;
        border: 1px solid #1F222F;
        margin: 1px;
    }
    QScrollBar::handle:vertical:hover {
        background-color: #2C3043;
        border-color: #3C425C;
    }
    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
        height: 0px;
    }
    QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {
        background: none;
    }

    QScrollBar:horizontal {
        background-color: #0A0B10;
        height: 10px;
        margin: 0px;
    }
    QScrollBar::handle:horizontal {
        background-color: #222530;
        min-width: 20px;
        border-radius: 5px;
        border: 1px solid #1F222F;
        margin: 1px;
    }
    QScrollBar::handle:horizontal:hover {
        background-color: #2C3043;
        border-color: #3C425C;
    }
    QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {
        width: 0px;
    }
    QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {
        background: none;
    }
"""

