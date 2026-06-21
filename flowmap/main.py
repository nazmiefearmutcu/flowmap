"""
FlowMap — Open-source Bookmap-style order flow visualization.
"""

import sys
from PyQt6.QtWidgets import QApplication
from .ui.main_window import MainWindow


def main():
    """Launch the FlowMap application."""
    app = QApplication(sys.argv)
    app.setApplicationName("FlowMap")
    app.setOrganizationName("FlowMap")

    window = MainWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
