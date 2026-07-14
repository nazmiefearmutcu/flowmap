# FlowMap 📊

**Open-source real-time order flow and market depth visualization platform.**

FlowMap brings institutional-grade order book heatmap visualization to your desktop. Built with Python, PyQt6, and vectorized NumPy array projections, it renders real-time liquidity heatmaps, trade execution bubbles, DOM depth, and volume analytics.

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

### 🔥 Real-Time Liquidity Stratigraphy Heatmap
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
- **Controls**:
  - **Start / Stop**: toolbar **Start** button or **Space**
  - **Auto-follow BBO**: **F** (toggle)
  - **Zoom**: mouse **wheel** (time zoom on chart; price zoom on price axis) or `+`/`-`
  - **Pan / scroll**: **Ctrl + wheel** (time pan on chart; price scroll on price axis); arrow keys also pan time
  - **Reset view**: **R**

---

## 📊 Benchmarks & Performance Metrics

To ensure institutional-grade reliability and low latency, FlowMap is continuously benchmarked using headless offscreen rendering driven by [benchmark_rendering.py](file:///Users/nazmi/flowmap/benchmark_rendering.py).

Under maximum throughput stress tests (rendering L2 book updates, CVD delta ticks, and trade events as fast as the queue drains), the platform achieves the following metrics:

| Resolution | Target Component | Mode | Throughput / FPS | Avg CPU Usage | Avg Paint Time | Max Paint Time |
|:---|:---|:---|:---|:---|:---|:---|
| **800x600** | HeatmapWidget | Uncapped | 56.3 FPS | 63.3% | 8.46 ms | 268.69 ms |
| **800x600** | MainWindow (Heatmap) | Uncapped | **147.9 FPS** | 90.0% | **2.73 ms** | 94.89 ms |
| **800x600** | MainWindow (Heatmap) | Capped (60 FPS) | 53.9 FPS | 62.4% | 4.64 ms | 50.42 ms |
| **1920x1080** | HeatmapWidget | Uncapped | 67.4 FPS | 88.8% | 6.06 ms | 180.31 ms |
| **1920x1080** | MainWindow (Heatmap) | Uncapped | **104.0 FPS** | 89.0% | **3.34 ms** | 134.66 ms |
| **1920x1080** | MainWindow (Heatmap) | Capped (60 FPS) | 39.2 FPS | 58.3% | 6.23 ms | 155.69 ms |

### Key Reliability Features
- **Zero-Lag Event Pipeline**: Rather than choking the UI event thread on high-frequency feeds, incoming messages are batched using thread-safe queues.
- **Microsecond Desync Protection**: BBO updates are applied directly to the order book's BBO tracking state, automatically cleaning crossed levels and triggering a repaint only when new data changes.
- **Offscreen Benchmarking**: Benchmarked headlessly via Qt's `offscreen` QPA platform to measure true internal computation limits independent of display server v-sync capping.

---

## 🛣️ Roadmap

### Phase 1 — Core Engine & UI ✅
- [x] Vectorized order book density engine
- [x] Zero-flicker double-buffered layout scaling
- [x] Professional bi-color density colormap implementation
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
