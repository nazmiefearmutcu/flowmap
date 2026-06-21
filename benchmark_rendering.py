#!/usr/bin/env python3
"""
Benchmark Rendering Script for FlowMap.
Measures paintEvent execution times, FPS, and CPU consumption of:
1. HeatmapWidget (standalone)
2. MainWindow (full UI layout including PriceChart and HeatmapWidget)
across resolutions: 800x600 and 1920x1080.
"""

import os
import sys
import time
import subprocess
import threading
import numpy as np

# Force offscreen QPA platform to run headlessly without window popups
os.environ["QT_QPA_PLATFORM"] = "offscreen"

# Setup project path
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PROJECT_DIR)

from PyQt6.QtCore import Qt, QTimer, QEventLoop
from PyQt6.QtWidgets import QApplication
from PyQt6.QtGui import QPaintEvent

from flowmap.ui.heatmap_widget import HeatmapWidget
from flowmap.ui.price_chart import PriceChart
from flowmap.ui.main_window import MainWindow
from flowmap.core.order_book import OrderBook
from flowmap.data.simulator import MarketSimulator
from flowmap.core import Side, BookLevel, BBO

# =========================================================================
# CPU Monitoring Utility (Portable for macOS/Linux using ps)
# =========================================================================
def get_cpu_usage() -> float:
    """Get the current process CPU usage percentage."""
    try:
        output = subprocess.check_output(['ps', '-p', str(os.getpid()), '-o', '%cpu']).decode()
        lines = [line.strip() for line in output.strip().split('\n') if line.strip()]
        if len(lines) >= 2:
            return float(lines[1])
    except Exception:
        pass
    return 0.0

class CpuSampler(threading.Thread):
    """Periodically samples the CPU percentage of this process."""
    def __init__(self, interval=0.1):
        super().__init__()
        self.interval = interval
        self.samples = []
        self.running = True
        
    def run(self):
        while self.running:
            self.samples.append(get_cpu_usage())
            time.sleep(self.interval)
            
    def stop(self):
        self.running = False

# =========================================================================
# Subclassed Widgets to Track Paint Times
# =========================================================================
class MonitoredHeatmapWidget(HeatmapWidget):
    """HeatmapWidget with instrumented paintEvent to collect execution times."""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.paint_times = []
        
    def paintEvent(self, event: QPaintEvent) -> None:
        t0 = time.perf_counter()
        super().paintEvent(event)
        t1 = time.perf_counter()
        self.paint_times.append(t1 - t0)

class MonitoredMainWindow(MainWindow):
    """MainWindow with instrumented child widgets to collect execution times."""
    def __init__(self):
        super().__init__()
        self.heatmap_paint_times = []
        self.chart_paint_times = []
        
        # Override heatmap's paintEvent
        old_hm_paint = self.heatmap.paintEvent
        def hm_paint(event):
            t0 = time.perf_counter()
            old_hm_paint(event)
            t1 = time.perf_counter()
            self.heatmap_paint_times.append(t1 - t0)
        self.heatmap.paintEvent = hm_paint
        
        # Override price_chart's paintEvent
        old_chart_paint = self.price_chart.paintEvent
        def chart_paint(event):
            t0 = time.perf_counter()
            old_chart_paint(event)
            t1 = time.perf_counter()
            self.chart_paint_times.append(t1 - t0)
        self.price_chart.paintEvent = chart_paint

# =========================================================================
# Data Feed Helpers
# =========================================================================
def push_data_to_window(window: MainWindow, levels, snapshot, bbo, trades):
    """Push levels, BBO, and trades to the MainWindow's widgets."""
    # Feed to order book
    window._order_book.apply_snapshot(snapshot)
    
    # Push to heatmap
    window.heatmap.push_snapshot(levels, bbo)
    for trade in trades:
        window.heatmap.add_trade(trade.price, trade.size, trade.side, is_liquidation=trade.is_liquidation)
        
    # Push to price_chart
    if bbo is not None and bbo.bid > 0 and bbo.ask > 0:
        mid = (bbo.bid + bbo.ask) / 2.0
        window.price_chart.push_price(mid)

def push_data_to_widget(widget: HeatmapWidget, levels, snapshot, bbo, trades):
    """Push levels, BBO, and trades directly to HeatmapWidget."""
    widget.push_snapshot(levels, bbo)
    for trade in trades:
        widget.add_trade(trade.price, trade.size, trade.side, is_liquidation=trade.is_liquidation)

# =========================================================================
# Benchmarking Routines
# =========================================================================
def run_uncapped_benchmark(app, target, test_snapshots, duration=3.0):
    """Runs target at maximum throughput (rendering as fast as possible)."""
    start_time = time.perf_counter()
    frame_count = 0
    snapshot_idx = 0
    num_snapshots = len(test_snapshots)
    
    cpu_sampler = CpuSampler(interval=0.1)
    cpu_sampler.start()
    
    # Reset monitored paint times
    if isinstance(target, MainWindow):
        target.heatmap_paint_times.clear()
        target.chart_paint_times.clear()
    else:
        target.paint_times.clear()
        
    while time.perf_counter() - start_time < duration:
        levels_snap, snapshot, bbo, trades = test_snapshots[snapshot_idx]
        
        if isinstance(target, MainWindow):
            push_data_to_window(target, levels_snap, snapshot, bbo, trades)
            target.repaint()
        else:
            push_data_to_widget(target, levels_snap, snapshot, bbo, trades)
            target.repaint()
            
        app.processEvents()
        frame_count += 1
        snapshot_idx = (snapshot_idx + 1) % num_snapshots
        
    elapsed = time.perf_counter() - start_time
    cpu_sampler.stop()
    cpu_sampler.join()
    
    fps = frame_count / elapsed
    avg_cpu = np.mean(cpu_sampler.samples) if cpu_sampler.samples else 0.0
    
    return {
        "fps": fps,
        "elapsed": elapsed,
        "frames": frame_count,
        "avg_cpu": avg_cpu
    }

def run_capped_benchmark(app, target, test_snapshots, duration=3.0, target_fps=60):
    """Runs target at a capped FPS (e.g. 60 FPS) using QTimer."""
    loop = QEventLoop()
    timer = QTimer()
    timer.setInterval(int(1000 / target_fps))
    
    start_time = time.perf_counter()
    frame_count = 0
    snapshot_idx = 0
    num_snapshots = len(test_snapshots)
    
    cpu_sampler = CpuSampler(interval=0.1)
    cpu_sampler.start()
    
    # Reset monitored paint times
    if isinstance(target, MainWindow):
        target.heatmap_paint_times.clear()
        target.chart_paint_times.clear()
    else:
        target.paint_times.clear()
        
    def tick():
        nonlocal frame_count, snapshot_idx
        
        levels_snap, snapshot, bbo, trades = test_snapshots[snapshot_idx]
        
        if isinstance(target, MainWindow):
            push_data_to_window(target, levels_snap, snapshot, bbo, trades)
            target.repaint()
        else:
            push_data_to_widget(target, levels_snap, snapshot, bbo, trades)
            target.repaint()
            
        app.processEvents()
        frame_count += 1
        snapshot_idx = (snapshot_idx + 1) % num_snapshots
        
        # Terminate event loop if duration elapsed
        if time.perf_counter() - start_time >= duration:
            timer.stop()
            loop.quit()
            
    timer.timeout.connect(tick)
    timer.start()
    loop.exec()
    
    elapsed = time.perf_counter() - start_time
    cpu_sampler.stop()
    cpu_sampler.join()
    
    fps = frame_count / elapsed
    avg_cpu = np.mean(cpu_sampler.samples) if cpu_sampler.samples else 0.0
    
    return {
        "fps": fps,
        "elapsed": elapsed,
        "frames": frame_count,
        "avg_cpu": avg_cpu
    }

# =========================================================================
# Main Runner
# =========================================================================
def main():
    print("======================================================================")
    print("FLOWMAP RENDERING PIPELINE BENCHMARK")
    print("======================================================================")
    
    # 1. Initialize Qt Application in offscreen platform
    app = QApplication(sys.argv)
    
    # 2. Generate simulation data
    print("\n[Data Preparation] Generating market simulation snapshot timeline...")
    order_book = OrderBook("BENCH.BTC/USDT", depth=25)
    simulator = MarketSimulator(
        symbol="BENCH.BTC/USDT",
        base_price=65000.0,
        tick_size=0.5,
        depth_levels=25,
    )
    
    test_snapshots = []
    # Warmup simulator to build order depth
    for _ in range(50):
        simulator.tick()
        
    # Capture 400 realistic state snapshots
    for i in range(400):
        result = simulator.tick()
        # Create levels mapping
        levels = {}
        for price, size in result['snapshot'].bids:
            levels[price] = [size, 0.0]
        for price, size in result['snapshot'].asks:
            if price in levels:
                levels[price][1] = size
            else:
                levels[price] = [0.0, size]
        
        # Build BookLevel instances
        level_list = [
            BookLevel(
                price=p,
                bid_size=s[0],
                ask_size=s[1],
                trade_volume=0,
                trade_count=0,
                last_trade_side=None,
                delta=s[0]-s[1],
                max_size=max(s)
            )
            for p, s in sorted(levels.items())
        ]
        
        test_snapshots.append((level_list, result['snapshot'], result['bbo'], result['trades']))
        
    print(f"[Data Preparation] Successfully pre-generated {len(test_snapshots)} snapshots.")
    
    resolutions = [
        (800, 600),
        (1920, 1080)
    ]
    
    results = []
    
    for width, height in resolutions:
        print(f"\n" + "-" * 70)
        print(f"BENCHMARKING RESOLUTION: {width}x{height}")
        print("-" * 70)
        
        # ----------------------------------------------------
        # TEST TARGET 1: HeatmapWidget Standalone
        # ----------------------------------------------------
        print(f"\n[Target: HeatmapWidget] Initializing and resizing to {width}x{height}...")
        widget = MonitoredHeatmapWidget()
        widget.resize(width, height)
        widget.show()
        app.processEvents()
        
        # Run widget uncapped
        print("  - Running Uncapped throughput test (3 seconds)...")
        res_uncapped = run_uncapped_benchmark(app, widget, test_snapshots, duration=3.0)
        # Extract paint stats (skip first 20 frames for JIT/warmup)
        paint_ms = np.array(widget.paint_times[20:]) * 1000.0 if len(widget.paint_times) > 20 else np.array(widget.paint_times) * 1000.0
        avg_paint = np.mean(paint_ms) if len(paint_ms) > 0 else 0.0
        max_paint = np.max(paint_ms) if len(paint_ms) > 0 else 0.0
        std_paint = np.std(paint_ms) if len(paint_ms) > 0 else 0.0
        
        results.append({
            "resolution": f"{width}x{height}",
            "target": "HeatmapWidget",
            "mode": "Uncapped",
            "fps": res_uncapped["fps"],
            "avg_cpu": res_uncapped["avg_cpu"],
            "avg_paint": avg_paint,
            "max_paint": max_paint,
            "std_paint": std_paint
        })
        
        # Run widget capped at 60 FPS
        print("  - Running Capped (60 FPS) simulation test (3 seconds)...")
        res_capped = run_capped_benchmark(app, widget, test_snapshots, duration=3.0, target_fps=60)
        paint_ms = np.array(widget.paint_times[20:]) * 1000.0 if len(widget.paint_times) > 20 else np.array(widget.paint_times) * 1000.0
        avg_paint = np.mean(paint_ms) if len(paint_ms) > 0 else 0.0
        max_paint = np.max(paint_ms) if len(paint_ms) > 0 else 0.0
        std_paint = np.std(paint_ms) if len(paint_ms) > 0 else 0.0
        
        results.append({
            "resolution": f"{width}x{height}",
            "target": "HeatmapWidget",
            "mode": "Capped (60 FPS)",
            "fps": res_capped["fps"],
            "avg_cpu": res_capped["avg_cpu"],
            "avg_paint": avg_paint,
            "max_paint": max_paint,
            "std_paint": std_paint
        })
        
        widget.close()
        app.processEvents()
        
        # ----------------------------------------------------
        # TEST TARGET 2: MainWindow (Heatmap + Chart + status)
        # ----------------------------------------------------
        print(f"\n[Target: MainWindow] Initializing and resizing to {width}x{height}...")
        window = MonitoredMainWindow()
        # Adjust dimensions and show
        window.resize(width, height)
        window.show()
        app.processEvents()
        
        # Run window uncapped
        print("  - Running Uncapped throughput test (3 seconds)...")
        res_uncapped_win = run_uncapped_benchmark(app, window, test_snapshots, duration=3.0)
        
        # Extract paint stats (skip first 20 frames for JIT/warmup)
        hm_paint_ms = np.array(window.heatmap_paint_times[20:]) * 1000.0 if len(window.heatmap_paint_times) > 20 else np.array(window.heatmap_paint_times) * 1000.0
        chart_paint_ms = np.array(window.chart_paint_times[20:]) * 1000.0 if len(window.chart_paint_times) > 20 else np.array(window.chart_paint_times) * 1000.0
        
        avg_hm = np.mean(hm_paint_ms) if len(hm_paint_ms) > 0 else 0.0
        max_hm = np.max(hm_paint_ms) if len(hm_paint_ms) > 0 else 0.0
        
        avg_chart = np.mean(chart_paint_ms) if len(chart_paint_ms) > 0 else 0.0
        max_chart = np.max(chart_paint_ms) if len(chart_paint_ms) > 0 else 0.0
        
        results.append({
            "resolution": f"{width}x{height}",
            "target": "MainWindow (Heatmap)",
            "mode": "Uncapped",
            "fps": res_uncapped_win["fps"],
            "avg_cpu": res_uncapped_win["avg_cpu"],
            "avg_paint": avg_hm,
            "max_paint": max_hm,
            "std_paint": np.std(hm_paint_ms) if len(hm_paint_ms) > 0 else 0.0
        })
        
        results.append({
            "resolution": f"{width}x{height}",
            "target": "MainWindow (PriceChart)",
            "mode": "Uncapped",
            "fps": res_uncapped_win["fps"],
            "avg_cpu": res_uncapped_win["avg_cpu"],
            "avg_paint": avg_chart,
            "max_paint": max_chart,
            "std_paint": np.std(chart_paint_ms) if len(chart_paint_ms) > 0 else 0.0
        })
        
        # Run window capped at 60 FPS
        print("  - Running Capped (60 FPS) simulation test (3 seconds)...")
        res_capped_win = run_capped_benchmark(app, window, test_snapshots, duration=3.0, target_fps=60)
        
        hm_paint_ms = np.array(window.heatmap_paint_times[20:]) * 1000.0 if len(window.heatmap_paint_times) > 20 else np.array(window.heatmap_paint_times) * 1000.0
        chart_paint_ms = np.array(window.chart_paint_times[20:]) * 1000.0 if len(window.chart_paint_times) > 20 else np.array(window.chart_paint_times) * 1000.0
        
        avg_hm = np.mean(hm_paint_ms) if len(hm_paint_ms) > 0 else 0.0
        max_hm = np.max(hm_paint_ms) if len(hm_paint_ms) > 0 else 0.0
        
        avg_chart = np.mean(chart_paint_ms) if len(chart_paint_ms) > 0 else 0.0
        max_chart = np.max(chart_paint_ms) if len(chart_paint_ms) > 0 else 0.0
        
        results.append({
            "resolution": f"{width}x{height}",
            "target": "MainWindow (Heatmap)",
            "mode": "Capped (60 FPS)",
            "fps": res_capped_win["fps"],
            "avg_cpu": res_capped_win["avg_cpu"],
            "avg_paint": avg_hm,
            "max_paint": max_hm,
            "std_paint": np.std(hm_paint_ms) if len(hm_paint_ms) > 0 else 0.0
        })
        
        results.append({
            "resolution": f"{width}x{height}",
            "target": "MainWindow (PriceChart)",
            "mode": "Capped (60 FPS)",
            "fps": res_capped_win["fps"],
            "avg_cpu": res_capped_win["avg_cpu"],
            "avg_paint": avg_chart,
            "max_paint": max_chart,
            "std_paint": np.std(chart_paint_ms) if len(chart_paint_ms) > 0 else 0.0
        })
        
        window.close()
        app.processEvents()

    # =========================================================================
    # Report Generation
    # =========================================================================
    print("\n" + "=" * 100)
    print("BENCHMARK RESULTS SUMMARY")
    print("=" * 100)
    
    header = f"{'Resolution':<12} | {'Target Component':<25} | {'Mode':<15} | {'FPS':<8} | {'CPU %':<8} | {'Avg Paint':<10} | {'Max Paint':<10}"
    print(header)
    print("-" * 100)
    
    for r in results:
        fps_str = f"{r['fps']:.1f}"
        cpu_str = f"{r['avg_cpu']:.1f}%"
        avg_p_str = f"{r['avg_paint']:.2f} ms"
        max_p_str = f"{r['max_paint']:.2f} ms"
        
        row_str = f"{r['resolution']:<12} | {r['target']:<25} | {r['mode']:<15} | {fps_str:<8} | {cpu_str:<8} | {avg_p_str:<10} | {max_p_str:<10}"
        print(row_str)
        
    print("=" * 100)
    
    # Save results to a CSV/JSON report file
    import json
    report_path = os.path.join(PROJECT_DIR, "benchmark_report.json")
    with open(report_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nDetailed report saved to: {report_path}")

    # Generate visual markdown report in the artifacts directory
    artifact_dir = os.environ.get("GEMINI_ARTIFACT_DIR")
    if not artifact_dir:
        # Fallback to local brain directory
        artifact_dir = "/Users/nazmi/.gemini/antigravity-cli/brain/26063ac9-4060-4915-8e5d-01dcd19c1e60"
        
    md_report_path = os.path.join(artifact_dir, "benchmark_results.md")
    
    try:
        os.makedirs(os.path.dirname(md_report_path), exist_ok=True)
        with open(md_report_path, "w") as f:
            f.write("# FlowMap Rendering Performance Report\n\n")
            f.write("This report presents the paint event execution times, frames per second (FPS), and CPU consumption across different screen resolutions and components.\n\n")
            
            f.write("## Summary Table\n\n")
            f.write("| Resolution | Target Component | Mode | FPS | Avg CPU Usage | Avg Paint Time | Max Paint Time |\n")
            f.write("|:---|:---|:---|:---|:---|:---|:---|\n")
            
            for r in results:
                f.write(f"| {r['resolution']} | {r['target']} | {r['mode']} | {r['fps']:.1f} | {r['avg_cpu']:.1f}% | {r['avg_paint']:.2f} ms | {r['max_paint']:.2f} ms |\n")
                
            f.write("\n## Implementation Details\n")
            f.write("- **Offscreen Rendering**: The benchmark is executed headlessly via Qt's `offscreen` QPA platform to eliminate the overhead and asynchronous v-sync bounds of display servers.\n")
            f.write("- **Simulated Capping**: In `Capped (60 FPS)` mode, rendering updates are driven by a high-precision `QTimer` firing at 16.6ms intervals, mirroring standard user interaction rates.\n")
            f.write("- **Uncapped Throughput**: In `Uncapped` mode, updates are forced as fast as possible to identify rendering bottleneck limits.\n")
            f.write("- **CPU Sampling**: CPU usage of the rendering process is queried dynamically using local process tracking (`ps` query).\n")
            
        print(f"Visual Markdown report saved to: {md_report_path}")
    except Exception as e:
        print(f"Could not save markdown report to artifacts: {e}")

if __name__ == "__main__":
    main()
