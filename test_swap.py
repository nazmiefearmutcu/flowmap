#!/usr/bin/env python3
import sys
from PyQt6.QtWidgets import QApplication
from PyQt6.QtGui import QImage, QColor
import numpy as np

app = QApplication(["--platform", "offscreen"])

# Red pixel in numpy (R=255, G=0, B=0, A=255)
buf = np.array([[[255, 0, 0, 255]]], dtype=np.uint8)

# Wrap it directly in ARGB32
qimg = QImage(buf.data, 1, 1, 4, QImage.Format.Format_ARGB32)
color = qimg.pixelColor(0, 0)
print(f"ARGB32: R={color.red()} G={color.green()} B={color.blue()} A={color.alpha()}")

# Let's also check RGB32
qimg_rgb = QImage(buf.data, 1, 1, 4, QImage.Format.Format_RGB32)
color_rgb = qimg_rgb.pixelColor(0, 0)
print(f"RGB32: R={color_rgb.red()} G={color_rgb.green()} B={color_rgb.blue()} A={color_rgb.alpha()}")

# Let's check RGBA8888
qimg_rgba = QImage(buf.data, 1, 1, 4, QImage.Format.Format_RGBA8888)
color_rgba = qimg_rgba.pixelColor(0, 0)
print(f"RGBA8888: R={color_rgba.red()} G={color_rgba.green()} B={color_rgba.blue()} A={color_rgba.alpha()}")
