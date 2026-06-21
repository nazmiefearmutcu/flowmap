import sys
import numpy as np
from flowmap.engine.density_engine import DensityEngine
from flowmap.engine.color_system import ColorSystem
from flowmap.data.simulator import MarketSimulator
from flowmap.core import BBO, BookLevel

engine = DensityEngine(max_levels=50, history_width=600, decay=0.92)
engine.resize(150, 200)

sim = MarketSimulator(symbol="TEST", base_price=24500, tick_size=0.05,
                      depth_levels=15, volume_per_tick=0.25)

for tick in range(5):
    r = sim.tick()
    snap = r['snapshot']
    bbo_data = r['bbo']

    levels = {}
    for price, size in snap.bids:
        levels[price] = [size, 0.0]
    for price, size in snap.asks:
        if price in levels:
            levels[price][1] = size
        else:
            levels[price] = [0.0, size]

    level_list = [BookLevel(price=p, bid_size=s[0], ask_size=s[1],
                            trade_volume=0, trade_count=0,
                            last_trade_side=None, delta=s[0]-s[1],
                            max_size=max(s))
                  for p, s in sorted(levels.items())]

    bbo = BBO(timestamp=tick, symbol="TEST",
              bid=bbo_data.bid, ask=bbo_data.ask,
              bid_size=bbo_data.bid_size, ask_size=bbo_data.ask_size)

    engine.push_snapshot(level_list, bbo)
    
    buf = engine.get_buffer()
    non_bg = np.sum(np.any(buf[:, :, :3] != ColorSystem.BG_COLOR[:3], axis=2))
    print(f"Tick {tick}: BBO={bbo.bid:.2f}/{bbo.ask:.2f}, tick_size={engine.tick_size:.5f}, center={engine.center_price_ticks}, non_bg_pixels={non_bg}")
