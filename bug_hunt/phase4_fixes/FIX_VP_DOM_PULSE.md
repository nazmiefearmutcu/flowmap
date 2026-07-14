# Phase-4 Fix Notes — VP / DOM / Pulse / CVD side

**Date:** 2026-07-13  
**Agent:** Phase-4 FIX (VP_DOM_PULSE)  
**Findings:** FIND-P234-01, FIND-P233-01, FIND-P232-02, FIND-NUM-07

---

## Summary

| ID | Status | File(s) | Change |
|----|--------|---------|--------|
| FIND-P234-01 | FIXED | `flowmap/ui/overlays/volume_profile.py` | Y pitch = fixed `row_height` (heatmap if linked) |
| FIND-P233-01 | FIXED | `flowmap/ui/dom/dom_ladder.py` | BBO-centered window; honor `_depth` |
| FIND-P232-02 | FIXED | `flowmap/ui/pulse.py` | CVD slice uses heatmap `_scroll_offset` |
| FIND-NUM-07 | FIXED | `flowmap/ui/overlays/cvd.py` (+ pulse already used helper) | `is_buy_side` for delta |

---

## FIND-P234-01 — Volume profile Y vs heatmap row_height

**Problem:** Paint used `y_start = int(i * h / bh)` (stretch full height). Heatmap uses fixed pitch `i * row_height` with unused remainder strip. `set_row_height` stored `self.row_height` but paint ignored it → systematic skew.

**Fix:** In `paintEvent`, resolve pitch as:

```text
rh = heatmap.row_height if heatmap linked else self.row_height
y_start = i * rh
```

Stop when `y_start >= h` (remainder unused, same as heatmap). Bar height still leaves 1px gap when `rh > 1`.

**Not changed:** Level list source (`set_levels` / `get_visible_prices`); HUD header/footer overlays.

---

## FIND-P233-01 — DOM not BBO-centered

**Problem:** `display_levels = self._levels[-visible_count:]` always showed the highest prices. Deep books put far asks on screen and bids near mid off-screen. `set_depth` / `_depth` unused for windowing.

**Fix:**

- `_select_display_levels(h)`:
  - `visible_count = min(n, fit_to_height, 2 * _depth)`
  - Center index = closest level to BBO mid `(bid+ask)/2` (fallback bid/ask/book middle)
  - Slice `[center - n//2 : …]` clamped to book bounds
  - Reverse for display (high price at top)
- Mouse hit-test maps through `_window_start` / `_window_count` instead of assuming full-book reverse index
- Bar max size normalized on visible window (not whole book)

**Not changed:** Wheel scroll offset (FIND-P233-02 still open); paint throttle.

---

## FIND-P232-02 — Pulse CVD ignores scroll_offset

**Problem:** MarketPulse always sliced `history[len-bw : len]` (live tip). Heatmap history view uses `end = len - _scroll_offset`.

**Fix:** When heatmap is linked:

```text
scroll_offset = heatmap._scroll_offset
slice_end   = history_len - scroll_offset
slice_start = slice_end - bw
```

Both `_cvd_history` and `_timestamp_history` use the same window so sweep markers stay X-aligned with the CVD series under scroll.

**Not changed:** Standalone pulse path (no heatmap) still uses local deque; badge “live edge” sweep placement already checked `_scroll_offset == 0`.

---

## FIND-NUM-07 — CVD Side.BUY only

**Problem:** `CVDOverlay.add_trade` used `side == Side.BUY` only. Book-side tags (`Side.BID`) and string sides counted as sells, diverging from `OrderBook.record_trade` / `is_buy_side`.

**Fix:**

- `cvd.py`: `from ...core import is_buy_side`; `delta = size if is_buy_side(side) else -size`
- `pulse.py`: already used `is_buy_side` in `add_trade` / `add_trades` (verified)

**Not changed:** Sweep side comparison still uses raw `Side` equality for same-side bursts (orthogonal).

---

## Verification (static / light)

1. VP: `y_start` no longer contains `h / bh`; uses `row_height`.
2. DOM: no `[-visible_count:]` highest-N slice; `_select_display_levels` present; `_depth` multiplies window.
3. Pulse: `slice_end` depends on `_scroll_offset`.
4. CVD: `is_buy_side` import and use at delta site.

---

## Residual risk

- DOM wheel pan still no-op (FIND-P233-02).
- VP HUD 20px header / 16px footer still cover first/last row pixels (pre-existing UX).
- Pulse X mapping uses buffer width `bw`; if `right_margin_w` / timeline width diverge further, column alignment may still drift slightly.
