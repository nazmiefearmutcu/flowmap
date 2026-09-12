# 2026-09-12 — Bookmap-Class Visual Overhaul (chart + heatmap + depth)

Status: APPROVED (owner, in-chat design review 2026-09-12)
Campaign kit: `C:\Users\Kullanıcı\flowmap-review\bookmap-2026-09-12\`

## Goal

Bring the heatmap chart, overlay stack and depth surfaces to Bookmap-grade visual
quality while keeping the per-theme chart palettes (owner decision: themes stay
integrated; midnight becomes the flagship full-thermal look, light themes get a
structure-equivalent treatment on their own ground).

Owner-ranked priorities: (1) heatmap texture / gradient, (2) grid / axis /
typography. Everything else — price line, trade bubbles, depth panel, scrollback
readability — is in scope.

## Root causes diagnosed (evidence)

1. **Walls blow out to flat saturated bands.** Fixed p97 white point + mild
   gamma maps everything at/above p97 to the same LUT entry. Evidence:
   `cap1-live.png`, `cap1-zoomed.png` (campaign kit), night captures
   `rp10-live.png` / `rp10-owner-scrollback-mid.png`.
2. **Bricks / mosaic.** Level-0 "crisp cell" sampler paints hard per-column
   rectangles at deep zoom; the fixed 3-tap column blur is too narrow once a
   column spans many device pixels. Evidence: `cap1-zoomed.png`.
3. **Scrollback plate.** Server reconstruction paints flat `[low, high]` candle
   bands with a fixed 12× display gain → saturated plates.
   Evidence: `rp10-owner-scrollback-mid.png`.
4. **Chrome.** Heavy blue grid lines crossing the chart, weak price-axis
   typography, millisecond-precision time labels. Evidence: `cap1-live.png`.

## Approach (approved: A)

Keep the tile / SUM-mip architecture. Redesign the presentation layers:
transfer curve, per-theme ramps, level-0 sampler smoothing, server
reconstruction distribution, overlay & axis styling.

### Lanes

- **L1 — Transfer curve & normalization.** Replace the fixed p97 clip with a
  two-segment curve (gamma lift below the knee, log compression above the knee;
  white point ≈ p99.7). Keeps Contrast/Tolerance semantics; wall cores
  differentiate instead of flattening. Golden pixel tests recalibrated.
- **L2 — Palette redesign (7 themes).** Shared ramp *structure* — long cool
  midband (near-black → deep blue → cyan), short warm band, near-white core.
  Midnight = full Bookmap thermal; paper/swiss/etc. get structure-equivalent
  ramps on their own ground. Registry pins + chart.test byte-identity updated.
- **L3 — Sampler smoothing.** Remove the crisp-cell path (mosaic source);
  width-scaled multi-tap gaussian smoothing on the time axis (price axis stays
  crisp). Perf budgets preserved; new "gradient continuity" pixel probe at
  4 zoom levels.
- **L4 — Server reconstruction + SIM distribution.** Candle bands become shaped
  distributions (dense near close, eroding toward the band edges) with a
  measured calibration replacing the fixed 12× gain. SIM synthetic feed walls
  share the shaping. Scrollback reads like the live view.
- **L5 — Grid / axis / typography.** Kill heavy grid lines (major price lines
  only, very low alpha); price-axis ladder + live price tag; adaptive time
  labels without milliseconds; tabular numerals.
- **L6 — Overlay polish (secondary).** Price line glow + right-edge tag + last
  price level; trade bubbles (sqrt-volume size, theme-tokenized sides);
  DOM/depth panel typography and depth bars.
- **V — Verification.** 4 read-only surveys → frozen CONTRACT → parallel lanes
  → INT → 2 independent FIX-FIRST reviews → coordinator fixes → live Playwright
  pixel evidence (7 themes × zoom levels) → all gates → exe rebuild + Desktop
  install.

### Measurable acceptance criteria

1. Wall interior gradient variance > threshold (flat saturated band = fail) —
   pixel probe.
2. Neighbor-column luma step below threshold at 4 zoom levels (mosaic edge =
   fail).
3. Empty area paints exactly `background()` (black point preserved).
4. Axis label contrast ≥ 4.5:1; grid alpha measured and bounded.
5. Scrollback saturated-plate ratio measured, below threshold.
6. All gates green: `tsc` 0 / eslint 0 / vitest / e2e / perf budgets.
7. Honesty invariants preserved: SYNTH amber tiers, reconstructed labels,
   normalization honesty (no fake data).

### Mid-campaign checkpoint

When L1 + L2 + L3 land on midnight, the coordinator presents a live
before/after screenshot to the owner before the full sweep continues.

### Non-goals

- No wire/protocol changes; no feed tier changes beyond reconstruction display
  shaping.
- No layout restructure (layout was polished in prior campaigns).
- No push: commits stay local (owner-gated).
