import numpy as np
import os
import sys

# Ensure flowmap can be imported
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from flowmap.engine.density_engine import DensityEngine
from flowmap.engine.config import EngineConfig
from flowmap.core import BookLevel, BBO

def generate_price_path(n_ticks=500, tick_size=0.05):
    """
    Generate a realistic price path.
    Combines a slow sine wave trend with high frequency random walk noise.
    """
    np.random.seed(42)
    base_price = 100.0
    mid_prices = []
    current = base_price
    for t in range(n_ticks):
        # Trend component
        trend_change = 0.15 * np.sin(2 * np.pi * t / 200)
        # Noise component (random walk step)
        noise = np.random.normal(0, 0.2)
        current = current + trend_change + noise
        mid_prices.append(current)
    return mid_prices

def run_simulation(centering_mode, ema_alpha=0.05, deadband_pct=0.35, n_ticks=500):
    prices = generate_price_path(n_ticks)
    config = EngineConfig(
        centering_mode=centering_mode,
        centering_ema_alpha=ema_alpha,
        centering_deadband_pct=deadband_pct
    )
    # We initialize with config
    engine = DensityEngine(config=config)
    engine.resize(100, 200) # 100 vertical rows
    
    center_history = []
    mid_ticks_history = []
    delta_history = []
    
    for i, mid in enumerate(prices):
        # Create BookLevel snapshots to trigger detecting tick_size
        levels = [
            BookLevel(price=mid - 0.05, bid_size=10, ask_size=0),
            BookLevel(price=mid + 0.05, bid_size=0, ask_size=10)
        ]
        bbo = BBO(timestamp=i, symbol="TEST", bid=mid - 0.025, ask=mid + 0.025, bid_size=5, ask_size=5)
        
        # Capture current center price ticks BEFORE pushing
        old_center = engine.center_price_ticks
        engine.push_snapshot(levels, bbo)
        new_center = engine.center_price_ticks
        
        center_history.append(new_center)
        mid_ticks_history.append(mid / engine.tick_size)
        
        if old_center is not None and new_center is not None:
            delta_history.append(abs(new_center - old_center))
        else:
            delta_history.append(0)
            
    return mid_ticks_history, center_history, delta_history

def evaluate_mode(name, mode, alpha=0.05, deadband=0.35):
    mid_hist, center_hist, delta_hist = run_simulation(mode, alpha, deadband)
    
    # Calculate metrics
    deltas = np.array(delta_hist)
    n_rolls = np.sum(deltas > 0)
    total_roll_dist = np.sum(deltas)
    max_jump = np.max(deltas) if len(deltas) > 0 else 0
    mean_jitter = np.mean(deltas)
    
    # Calculate distance to mid (in ticks)
    # We only measure once center is initialized
    valid_indices = [i for i, c in enumerate(center_hist) if c is not None]
    mid_hist_arr = np.array(mid_hist)[valid_indices]
    center_hist_arr = np.array(center_hist)[valid_indices]
    avg_dist_to_mid = np.mean(np.abs(mid_hist_arr - center_hist_arr))
    
    return {
        "mode": name,
        "n_rolls": n_rolls,
        "total_roll_dist": total_roll_dist,
        "max_jump": max_jump,
        "mean_jitter": mean_jitter,
        "avg_dist_to_mid": avg_dist_to_mid
    }

if __name__ == "__main__":
    modes_to_test = [
        ("Immediate", "immediate", 0.05, 0.35),
        ("Deadband (0.35)", "deadband", 0.05, 0.35),
        ("Deadband (0.15)", "deadband", 0.05, 0.15),
        ("EMA (alpha=0.02)", "ema", 0.02, 0.35),
        ("EMA (alpha=0.05)", "ema", 0.05, 0.35),
        ("EMA (alpha=0.10)", "ema", 0.10, 0.35),
        ("EMA (alpha=0.20)", "ema", 0.20, 0.35),
        ("Smooth Deadband (0.35, a=0.05)", "smooth_deadband", 0.05, 0.35),
        ("Smooth Deadband (0.15, a=0.10)", "smooth_deadband", 0.10, 0.15),
    ]
    
    print("# Centering Algorithm Smoothness Benchmark")
    print(f"| Algorithm | Number of Rolls | Total Roll Dist (ticks) | Max Single Jump (ticks) | Mean Jitter (ticks/frame) | Avg Distance to Mid (ticks) |")
    print(f"|---|---|---|---|---|---|")
    for name, mode, alpha, db in modes_to_test:
        res = evaluate_mode(name, mode, alpha, db)
        print(f"| {res['mode']:<30} | {res['n_rolls']:<15} | {res['total_roll_dist']:<23.1f} | {res['max_jump']:<23} | {res['mean_jitter']:<25.4f} | {res['avg_dist_to_mid']:<27.2f} |")
