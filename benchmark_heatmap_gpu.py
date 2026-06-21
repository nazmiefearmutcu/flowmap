import sys
import os
import time
import numpy as np
from collections import deque
from typing import Optional

# Setup project path
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PROJECT_DIR)

from PyQt6.QtCore import Qt, QRect, QPointF
from PyQt6.QtWidgets import QApplication, QWidget, QSizePolicy
from PyQt6.QtGui import QImage, QPainter, QColor, QPen, QFont, QFontMetrics, QPaintEvent
from PyQt6.QtOpenGLWidgets import QOpenGLWidget

from flowmap.core.order_book import OrderBook
from flowmap.data.simulator import MarketSimulator
from flowmap.core import BookLevel, BBO, Side

# Dynamic compilation of CPU/GL classes from original heatmap_widget.py source
with open(os.path.join(PROJECT_DIR, "flowmap", "ui", "heatmap_widget.py"), "r") as f:
    widget_code = f.read()

# Define CPU version
cpu_globals = {
    "__name__": "flowmap.ui.heatmap_widget_cpu",
    "BaseHeatmapWidget": QWidget,
    "QWidget": QWidget,
    "QSizePolicy": QSizePolicy,
}
# Execute in CPU namespace
exec(widget_code, cpu_globals)
HeatmapWidgetCPU = cpu_globals["HeatmapWidget"]

# Define GL version
gl_globals = {
    "__name__": "flowmap.ui.heatmap_widget_gl",
    "BaseHeatmapWidget": QOpenGLWidget,
    "QWidget": QOpenGLWidget,
    "QSizePolicy": QSizePolicy,
}
# Execute in GL namespace
exec(widget_code, gl_globals)
HeatmapWidgetGL = gl_globals["HeatmapWidget"]


# Instrument CPU class to measure render times
class InstrumentedHeatmapWidgetCPU(HeatmapWidgetCPU):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.paint_times = []
        
    def paintEvent(self, event: QPaintEvent) -> None:
        t0 = time.perf_counter()
        super().paintEvent(event)
        t1 = time.perf_counter()
        self.paint_times.append(t1 - t0)


# Instrument GL class to measure render times
class InstrumentedHeatmapWidgetGL(InstrumentedHeatmapWidgetCPU, HeatmapWidgetGL):
    """MRO-safe instrumented GL widget."""
    def __init__(self, parent=None):
        # Initialize HeatmapWidgetGL directly (skips QWidget init)
        HeatmapWidgetGL.__init__(self, parent)
        self.paint_times = []


def run_benchmark():
    app = QApplication(sys.argv)
    
    # Measure Compile/Initialization Times
    print("==================================================")
    print(" 1. COMPILATION AND INITIALIZATION TIMES")
    print("==================================================")
    
    # CPU widget compilation and init
    t0 = time.perf_counter()
    w_cpu_temp = InstrumentedHeatmapWidgetCPU()
    w_cpu_temp.resize(400, 300)
    w_cpu_temp.show()
    app.processEvents()
    t1 = time.perf_counter()
    cpu_init_ms = (t1 - t0) * 1000
    w_cpu_temp.close()
    print(f"CPU Backend Init/Compile:    {cpu_init_ms:.2f} ms")
    
    # GPU widget compilation and init (includes OpenGL driver handshake and pipeline compilation)
    t0 = time.perf_counter()
    w_gl_temp = InstrumentedHeatmapWidgetGL()
    w_gl_temp.resize(400, 300)
    w_gl_temp.show()
    app.processEvents()  # Triggers initializeGL internally
    t1 = time.perf_counter()
    gl_init_ms = (t1 - t0) * 1000
    w_gl_temp.close()
    print(f"GPU OpenGL Backend Init/Compile: {gl_init_ms:.2f} ms")
    
    # Setup simulator
    order_book = OrderBook("BENCH.NIFTY", depth=25)
    simulator = MarketSimulator(
        symbol="BENCH.NIFTY",
        base_price=24500.0,
        tick_size=0.05,
        depth_levels=25,
    )
    
    # Generate simulation data
    print("\nGenerating simulation data...")
    test_snapshots = []
    for _ in range(300):
        result = simulator.tick()
        order_book.apply_snapshot(result['snapshot'])
        for trade in result['trades']:
            order_book.record_trade(trade)
        test_snapshots.append((order_book.get_levels(), order_book.bbo))
    print(f"Generated {len(test_snapshots)} ticks.")
    
    # Resolutions to test
    resolutions = [
        (800, 500, "Standard (800x500)"),
        (1400, 900, "Retina/Medium (1400x900)"),
        (1920, 1080, "FHD Screen (1920x1080)")
    ]
    
    print("\n==================================================")
    print(" 2. GPU FRAME RATES AND RENDER LATENCY")
    print("==================================================")
    
    for w, h, label in resolutions:
        print(f"\n--- Testing Resolution: {label} ---")
        
        # CPU Test
        widget_cpu = InstrumentedHeatmapWidgetCPU()
        widget_cpu.resize(w, h)
        widget_cpu.show()
        app.processEvents()
        
        for levels, bbo in test_snapshots:
            widget_cpu.push_snapshot(levels, bbo)
            widget_cpu.repaint()
            app.processEvents()
            
        cpu_paints = np.array(widget_cpu.paint_times[20:]) * 1000  # skip warmups
        cpu_avg = np.mean(cpu_paints)
        cpu_max = np.max(cpu_paints)
        cpu_fps = 1000.0 / cpu_avg if cpu_avg > 0 else 0
        print(f"CPU paintEvent:  Avg = {cpu_avg:5.2f} ms | Max = {cpu_max:5.2f} ms | Est. Frame Rate = {cpu_fps:6.1f} FPS")
        widget_cpu.close()
        app.processEvents()
        
        # GPU Test
        widget_gl = InstrumentedHeatmapWidgetGL()
        widget_gl.resize(w, h)
        widget_gl.show()
        app.processEvents()
        
        for levels, bbo in test_snapshots:
            widget_gl.push_snapshot(levels, bbo)
            widget_gl.repaint()
            app.processEvents()
            
        gl_paints = np.array(widget_gl.paint_times[20:]) * 1000
        gl_avg = np.mean(gl_paints)
        gl_max = np.max(gl_paints)
        gl_fps = 1000.0 / gl_avg if gl_avg > 0 else 0
        print(f"GPU paintEvent:  Avg = {gl_avg:5.2f} ms | Max = {gl_max:5.2f} ms | Est. Frame Rate = {gl_fps:6.1f} FPS")
        widget_gl.close()
        app.processEvents()

if __name__ == "__main__":
    run_benchmark()
