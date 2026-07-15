# Endless Development Loop — Active

**Stop condition:** Only the user may stop. Do **not** emit `FLOWMAP_FRONTEND_HEALTHY` unless every surface is screenshot-proven perfect.

## North-star (perfect output)

1. Live feed never silent-empty (SSL, reconnect, empty-state messaging)
2. Heatmap fills continuously while running (no frozen mid-panel)
3. COB / CVP / SVP readable mid-levels (not POC-only ghosts)
4. CVD / Pulse / Icebergs / LLT / DOM coherent with book
5. Replay + Live + Embedded paths all healthy under screenshots
6. Clean a11y / no log spam / no font-family thrash

## This session increments

| Gap | Fix |
|-----|-----|
| VP mid-levels invisible | `_bar_len` sqrt scale + min 2px |
| CVP/SVP O(n×levels) paint | `_rebinned` once per paint |
| COB drops dual-side level | draw bid+ask half-height |
| Timeline freezes without WS msgs | `_gui_tick` paints every tick once book exists |
| "Connected — waiting" stickiness | clear empty copy on first levels |
| LLT thrash at 60fps idle paint | throttle side panels to every 6 frames |
| Empty-key `_volume_on_level` fast path | always rebin siblings |

## Metrics (screenshot)

| Shot | hm L/M/R | note |
|------|----------|------|
| endless_audit_1 | 0.56/0.53/0.29 | long live session |
| endless_continuous_cols | 0.20/0.19/0.13 | 30s after continuous paint |

## Later increments

| Gap | Fix |
|-----|-----|
| Symbol switch left SOL icebergs on BTC | clear iceberg/LLT/DOM + title on `on_symbol_changed` |
| Enter in symbol field no-op | `returnPressed` → `on_symbol_changed` |
| Idle timeline freeze | continuous paint at ~20 Hz when quiet |
| 60fps idle history burn | throttle idle columns to every 3 frames |

## Metrics (latest)

| Shot | hm | L/M/R |
|------|-----|-------|
| endless_long_soak | **0.35** | 0.41/0.40/0.23 |
| endless_btc_soak | **0.44** | 0.53/0.50/0.29 |
| endless_full_restart (28s) | 0.15 | balanced |

89 unit tests green.

## Next weak areas (keep attacking)

- [ ] Faster visual density in first 10s (column_width / hist preload)
- [ ] Pulse vs status Vol window clarity
- [x] Multi-symbol switch screenshot proof (`endless_btc_clean.png` title BTC)
- [x] Decay slider hidden when n/a
- [ ] Iceberg Hidden semantics audit
- [x] COB footer peak depth size
- [x] Clear also wipes chart iceberg markers
