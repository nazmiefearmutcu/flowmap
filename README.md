# FlowMap 📊

**Open-source Bookmap-style order flow visualization platform.**

FlowMap brings institutional-grade order book heatmap visualization to your desktop. Built with Python, PyQt6, and vectorized NumPy array projections, it renders real-time liquidity heatmaps, trade execution bubbles, DOM depth, and volume analytics — inspired by [Bookmap Classic](https://bookmap.com/).

---

## 🏷️ Tags & Badges

![Status](https://img.shields.io/badge/status-active--development-emerald)
![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![PyQt6](https://img.shields.io/badge/PyQt-6-darkblue)
![Engine](https://img.shields.io/badge/engine-NumPy%20Vectorized-orange)
![Replay](https://img.shields.io/badge/replay-Crypcodile%20DuckDB-purple)

---

## ✨ Features

### 🔥 Real-Time Bookmap Classic Heatmap
- **Unified Color Scale**: Transitions smoothly based on volume density (transparent $\rightarrow$ white $\rightarrow$ orange/red) on both bid and ask sides.
- **Flicker-Free Stratigraphy**: Iterates the union of all active price levels in memory, allowing historical lines to smoothly decay and fade out rather than instantly vanish.
- **Zero Vertical Jitter**: Uses a running minimum of observed tick intervals to freeze the vertical price tick scale.

### 🫧 Trade Execution Bubbles & Overlays
- **Interactive Trade Circles**: Every trade is plotted at its exact price row, with size scaling by volume and color mapped to aggressor side (green = buy, red = sell).
- **Volume Profile Overlay**: Matches the exact float-based boundaries of heatmap rows to prevent vertical layout drift.
- **VWAP & CVD (Market Pulse)**: Continuous float-based sub-pixel line rendering for technical analysis.
- **High-Readability BBO Current Price Tags**: Snapped bid/ask tags highlighted inside dark, side-colored rounded capsules.

### 🗄️ Crypcodile Live & Replay Feed Integration
- **DuckDB Querying (Replay)**: Connects locally to parquet-structured Crypcodile historical data folders (e.g., `exchange=binance-spot`, `channel=book_delta`).
- **Real-Time WebSocket Feed (Live)**: Connects to live data pipelines for instant order flow charting on live tickers.
- **Zero-Lag Queue Optimization**: Direct queue processing of BBO (Best Bid & Offer) quotes, trade executions, and L2 snapshots/updates to update the heatmap on every packet.

### 🖥️ Platform & Rendering
- **GPU Acceleration**: Supports both CPU (`QWidget`) and GPU (`QOpenGLWidget`) backends.
- **Performance Optimized**: Vectorized price projections (`np.fromiter` and `np.maximum.at`) and pre-allocated/cached `QPen`/`QBrush` styling objects allow uncapped rendering speeds of **135+ FPS** at 1080p.

---

## 🏗️ Architecture

```
flowmap/
├── flowmap/
│   ├── core/           # Data models & order book
│   │   ├── types.py    # Market data primitives
│   │   └── order_book.py  # L2 limit order book
│   ├── data/           # Data sources
│   │   ├── simulator.py   # Synthetic market data
│   │   ├── crypcodile_replay.py # Historical DuckDB/Parquet player
│   │   ├── crypcodile_live.py   # Real-time WebSocket feed provider
│   │   └── crypto.py      # Live crypto feeds (CCXT)
│   ├── ui/             # PyQt6 GUI
│   │   ├── bubbles.py     # Trade circles canvas
│   │   ├── price_chart.py # Sits above heatmap, sharing time axis
│   │   ├── pulse.py       # Cumulative Volume Delta (CVD)
│   │   ├── overlays/      # VWAP, CVD, Volume Profile
│   │   ├── dom/           # DOM ladder
│   │   ├── theme.py       # Styling and CSS
│   │   └── main_window.py # App orchestration
│   ├── engine/         # Quant/Visual computation
│   │   ├── density_engine.py  # Vectorized row projections
│   │   └── color_system.py    # Look-up tables (LUTs)
│   └── main.py         # Entry point
```

---

## 🚀 Quick Start

### 📦 Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/nazmiefearmutcu/flowmap.git
   cd flowmap
   ```

2. **Create a virtual environment & install dependencies:**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

### 🎮 Running the Platform

To launch the dashboard:
```bash
python run_flowmap.py
```

- **Data Source Selection**: Choose **Simulator** or **Crypcodile Replay** from the toolbar source dropdown.
- **Controls**: Press **Start** to run. Use `+`/`-` or mouse scroll with `Ctrl` held down to adjust vertical line zoom. Use `Space` to toggle auto-follow BBO centering.

---

## 🛣️ Roadmap

### Phase 1 — Core Engine & UI ✅
- [x] Vectorized order book density engine
- [x] Zero-flicker double-buffered layout scaling
- [x] Bookmap Classic colormap implementation
- [x] Interactive mouse zooming, scrolling, and dragging

### Phase 2 — Indicators & Overlays ✅
- [x] VWAP overlays and snap price lines
- [x] Volume Profile (perfectly aligned POC)
- [x] CVD (Market Pulse) with Color Vision Deficiency (CVD) support
- [x] DOM Ladder panel

### Phase 3 — Live & Replay Feeds ✅
- [x] Crypcodile Replay parquet DuckDB connector
- [x] CCXT Live exchanges WebSocket provider
- [x] Record & Replay session manager

### Phase 4 — Algorithmic Detection 🔨
- [ ] Liquidity Wall & Iceberg order detection
- [ ] Order book order-flow imbalance indicators
- [ ] Footprint chart widgets

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
