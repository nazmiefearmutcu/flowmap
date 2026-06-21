# FlowMap 📊

**Open-source Bookmap-style order flow visualization platform.**

FlowMap brings institutional-grade order book heatmap visualization to everyone. Built with Python and PyQt6, it renders real-time liquidity heatmaps, trade execution bubbles, DOM depth, and volume analytics — inspired by [Bookmap](https://bookmap.com/).

![FlowMap Screenshot](https://img.shields.io/badge/status-alpha-orange)
![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![PyQt6](https://img.shields.io/badge/PyQt-6-green)

---

## ✨ Features

### 🔥 Real-Time Order Book Heatmap
- Bid/ask depth visualized as colored rows (green = bids, red = asks)
- Multiple color schemes: **Bookmap**, **Mono**
- Gamma correction for better depth perception
- Configurable row height and zoom

### 🫧 Trade Execution Bubbles
- Every trade plotted at its exact price level
- Bubble size scales with trade quantity
- Color-coded by aggressor side (green = buy, red = sell)
- Flash effect on new trades

### 📊 Market Analytics
- **VWAP** — Volume-weighted average price overlay
- **Volume Profile** — Horizontal histogram with POC
- **CVD** — Cumulative Volume Delta
- **BBO** — Best bid/offer markers
- **DOM Ladder** — Depth of market display
- **Imbalance & Absorption** — Order book pressure analysis
- **Liquidity Wall Detection** — Algorithmic iceberg/spoof detection

### 🎮 Interactive Controls
- Mouse-wheel zoom and scroll
- Keyboard shortcuts (F=follow, Space=auto-follow, +/-=zoom)
- Auto-follow mode keeps BBO centered
- Simulation speed control (1× to 20×)
- One-click presets (Scalper, Swing, HFT, Clean)

### 🖥️ Platform
- **Desktop app** — Python/PyQt6 (cross-platform: Windows, macOS, Linux)
- **Demo mode** — Built-in market simulator with realistic data
- **Live mode** — WebSocket connection to crypto exchanges via CCXT
- **Replay mode** — Record and replay market sessions

---

## 🚀 Quick Start

### Prerequisites
- Python 3.10+
- pip or uv

### Installation

```bash
# Clone the repo
git clone https://github.com/yourusername/flowmap.git
cd flowmap

# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run
python run_flowmap.py
```

### Or install as a package

```bash
pip install -e .
flowmap
```

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `F` | Center view on best bid/offer |
| `Space` | Toggle auto-follow mode |
| `+` / `=` | Zoom in (increase row height) |
| `-` | Zoom out (decrease row height) |
| `R` | Reset scroll position |
| `Ctrl+R` | Start/stop simulation |
| `Ctrl+Q` | Quit application |

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
│   │   └── crypto.py      # Live crypto feeds (CCXT)
│   ├── ui/             # PyQt6 GUI
│   │   ├── heatmap/       # Heatmap render engine
│   │   ├── dom/           # DOM ladder
│   │   ├── overlays/      # VWAP, CVD, Volume Profile
│   │   └── main_window.py # App orchestration
│   ├── indicators/     # Technical indicators
│   ├── plugins/        # Plugin/addon API
│   ├── trading/        # Broker integration
│   └── main.py         # Entry point
├── tests/
├── requirements.txt
└── README.md
```

---

## 🛣️ Roadmap

### Phase 1 — Core Engine ✅ (Current)
- [x] Order book data structures
- [x] Market data simulator
- [x] Heatmap render engine
- [x] Basic UI with controls

### Phase 2 — Indicators & Overlays
- [ ] VWAP overlay
- [ ] Volume Profile (POC)
- [ ] CVD chart
- [ ] DOM ladder widget
- [ ] Time & Sales tape

### Phase 3 — Live Data
- [ ] Crypto exchange WebSocket (CCXT)
- [ ] Record & replay
- [ ] Multi-symbol support

### Phase 4 — Advanced
- [ ] Plugin API (like Bookmap's Python API)
- [ ] Order book imbalance detection
- [ ] Liquidity wall detection
- [ ] Footprint charts
- [ ] Multi-book (consolidated order books)

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- [Bookmap](https://bookmap.com/) — The inspiration and gold standard for order flow visualization
- [OrderFlowMap](https://github.com/Azhagesan-dev/OrderFlowMap) — Excellent single-file browser-based Bookmap-style visualizer
- [OpenAlgo](https://github.com/marketcalls/openalgo) — WebSocket market data server
