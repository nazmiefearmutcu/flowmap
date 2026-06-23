"""
Bookmap Features Details Dialog — displays the 9 core features/tools in a premium, dark-themed grid.
"""
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QScrollArea, QWidget, QGridLayout, QPushButton
)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
from ..theme import Colors, Fonts, MAIN_STYLESHEET

class FeatureCard(QWidget):
    """A card displaying a single feature with description and bullet points."""
    def __init__(self, title: str, description: str, bullets: list[str] = None, parent=None):
        super().__init__(parent)
        self.setStyleSheet("""
            QWidget {
                background-color: #181A24;
                border: 1px solid #2C3043;
                border-radius: 8px;
            }
            QLabel#title {
                color: #FFFFFF;
                font-size: 13px;
                font-weight: bold;
                border: none;
                background: transparent;
            }
            QLabel#desc {
                color: #9499C3;
                font-size: 11px;
                border: none;
                background: transparent;
            }
            QLabel#bullet {
                color: #A7F3D0;
                font-size: 11px;
                border: none;
                background: transparent;
            }
        """)
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(8)
        
        title_lbl = QLabel(title)
        title_lbl.setObjectName("title")
        title_lbl.setFont(Fonts.sans(13, bold=True))
        title_lbl.setWordWrap(True)
        layout.addWidget(title_lbl)
        
        desc_lbl = QLabel(description)
        desc_lbl.setObjectName("desc")
        desc_lbl.setFont(Fonts.sans(11))
        desc_lbl.setWordWrap(True)
        layout.addWidget(desc_lbl)
        
        if bullets:
            bullets_layout = QVBoxLayout()
            bullets_layout.setSpacing(4)
            bullets_layout.setContentsMargins(0, 4, 0, 0)
            for b in bullets:
                b_lbl = QLabel(f"✔ {b}")
                b_lbl.setObjectName("bullet")
                b_lbl.setFont(Fonts.sans(11))
                b_lbl.setWordWrap(True)
                bullets_layout.addWidget(b_lbl)
            layout.addLayout(bullets_layout)
            
        layout.addStretch()

class FeaturesDetailDialog(QDialog):
    """Dialog showing detailed description of all premium order book visualizer features."""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("FlowMap — Details About Features")
        self.resize(1000, 750)
        self.setMinimumSize(800, 600)
        
        # Apply main window dark styling
        self.setStyleSheet(MAIN_STYLESHEET + """
            QDialog {
                background-color: #0A0B10;
            }
            QScrollArea {
                border: none;
                background-color: transparent;
            }
            QWidget#scrollContainer {
                background-color: transparent;
            }
            QLabel#headerTitle {
                color: #FFFFFF;
                font-size: 18px;
                font-weight: bold;
            }
        """)
        
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(24, 24, 24, 24)
        main_layout.setSpacing(16)
        
        # Header layout
        header_layout = QHBoxLayout()
        header_lbl = QLabel("DETAILS ABOUT FEATURES")
        header_lbl.setObjectName("headerTitle")
        header_lbl.setFont(Fonts.sans(18, bold=True))
        header_layout.addWidget(header_lbl)
        
        header_layout.addStretch()
        
        close_btn = QPushButton("Close")
        close_btn.setFixedWidth(80)
        close_btn.clicked.connect(self.accept)
        header_layout.addWidget(close_btn)
        
        main_layout.addLayout(header_layout)
        
        # Scroll area for cards
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        
        scroll_content = QWidget()
        scroll_content.setObjectName("scrollContainer")
        grid = QGridLayout(scroll_content)
        grid.setSpacing(16)
        grid.setContentsMargins(0, 0, 0, 0)
        
        # Define the 9 cards
        features_data = [
            (
                "Liquidity Heatmap",
                "Watch limit orders at all price levels update in real time.",
                [
                    "Identify real support and resistance.",
                    "See when large traders add or withdraw liquidity.",
                    "Anticipate potential breakouts or reversals."
                ]
            ),
            (
                "Volume Bubbles",
                "Understand aggressive buying and selling as it happens.",
                [
                    "Visualize volume executed at each price.",
                    "Instantly see imbalances between buyers and sellers.",
                    "Detect momentum or exhaustion early."
                ]
            ),
            (
                "Best Bid and Ask (BBO)",
                "Track how incoming volume interacts with the spread.",
                [
                    "Identify absorption and exhaustion.",
                    "Gauge short-term shifts before they appear on candlestick charts."
                ]
            ),
            (
                "Order Book Depth (DOM)",
                "Visualize all pending liquidity, not just the top of the book.",
                [
                    "View full market depth (DOM ladder).",
                    "Configure columns to suit your trading style."
                ]
            ),
            (
                "Nanosecond Zoom",
                "Dive deep into the market microstructure.",
                [
                    "Real-time rendering of every update, volume, liquidity, and BBO at ultra-high FPS.",
                    "Perfect for scalping or post-trade analysis."
                ]
            ),
            (
                "Stops & Iceberg Tracker",
                "Detect hidden iceberg orders and spot large stop triggers causing sharp movements.",
                None
            ),
            (
                "Tradermap Pro",
                "Filter out market maker bots and isolate real liquidity for cleaner, more reliable heatmap readings (e.g. limit orders exceeding a specific size).",
                None
            ),
            (
                "DOM Pro",
                "Visualize the order book with higher precision, combining depth data and trade flows for better entry/exit timing.",
                None
            ),
            (
                "Market Pulse",
                "Track large trades, order sweeps, and momentum shifts in real time to align with institutional flow.",
                None
            )
        ]
        
        # Populate grid layout with cards (3 columns)
        cols = 3
        for idx, (title, desc, bullets) in enumerate(features_data):
            card = FeatureCard(title, desc, bullets)
            row = idx // cols
            col = idx % cols
            grid.addWidget(card, row, col)
            
        scroll.setWidget(scroll_content)
        main_layout.addWidget(scroll)
