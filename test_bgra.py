#!/usr/bin/env python3
import sys
from PyQt6.QtGui import QImage

for name in dir(QImage.Format):
    if not name.startswith("__"):
        print(name)
