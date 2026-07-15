# FlowMap + Crypcodile FlowMap — EKSTRA KAPSAMLI BUG HUNT

**Tarih:** 2026-07-13  
**Kapsam:** `/Users/nazmi/flowmap` (standalone) + `/Users/nazmi/Crypcodile` içindeki FlowMap entegrasyonu  
**GUI tooling:** cua-driver (daemon running) + mac-computer-use MCP  

## Fazlar

| Faz | Subagent | Çıktı |
|-----|----------|-------|
| 1 — Keşif | 20 | `phase1_research/*.md` |
| 2 — Plan | 50 | `phase2_plan/*.md` + birleşik plan |
| 3 — Av | 100 | `phase3_execution/*.md` + findings registry |
| 4 — Fix | 100 | `phase4_fixes/*` + çözülen issue listesi |

## Projeler

### Standalone FlowMap (`/Users/nazmi/flowmap`)
- ~13.3k LOC Python, PyQt6
- Hotspots: `heatmap_widget.py` (2349), `main_window.py` (1175), `crypcodile_replay.py` (961), `simulator.py` (782), `density_engine.py` (586)
- Entry: `run_flowmap.py` / `flowmap/main.py`
- Dist: `dist/FlowMap.app`

### Crypcodile-embedded FlowMap
- `src/crypcodile/gui/flowmap_window.py`
- Tests: `tests/test_flowmap.py`, `tests/gui/test_flowmap_window.py`, `tests/gui/test_flowmap_gui_cua.py`

## Bug sınıfları (hedef taksonomi)
1. Correctness (yanlış fiyat/volume/BBO/heatmap)
2. Concurrency / race / queue stall
3. Memory / leak / unbounded growth
4. Performance / FPS / UI freeze
5. Rendering artifacts / jitter / flicker
6. Input / UX / keyboard-mouse
7. Data source edge cases (replay/live/sim)
8. Integration (standalone ↔ crypcodile)
9. Packaging / crash on start
10. Security (path injection, untrusted plugin)

## Çalışma kuralları
- Her agent çıktısını kendi dosyasına yazar
- Finding formatı: ID, severity (P0-P3), file:line, repro, expected/actual, fix hint
- Fix fazında regression test eklenir mümkünse
- GUI doğrulama: cua-driver snapshot + screenshot
