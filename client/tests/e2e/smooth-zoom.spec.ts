import { expect, test } from '@playwright/test';

/**
 * Lane F (Bookmap-class overhaul) — the width-scaled Gaussian field sampler.
 *
 * Replaces crisp-zoom.spec.ts. The level-0 display sampler is now ONE kernel on
 * the time axis: `sigma = clamp(2.5 px × cpp, 0.12, 2.0)` columns, 9 fixed taps
 * with CPU-computed weights uploaded as uniforms (out-of-window taps are
 * dropped and the weight sum renormalizes, so the live edge keeps full weight).
 * Properties covered here:
 *   (a) deep zoom (cpp 0.5) shows NO hard per-column steps — p95 of |Δluma|
 *       between adjacent pixels of an alternating-column field stays far below
 *       the per-cell contrast;
 *   (b) a dim→bright column edge widens smoothly with cpp (sigma pinned in
 *       screen pixels) but never spreads multi-cell — the historical fixed
 *       3-tap kernel smeared edges over 40–200 px at deep zoom;
 *   (c) the row-only path (rpp 3.05, cpp 0.25) keeps the time-axis stripe
 *       structure (no 4-column block averaging) with luma variance ≫ flat;
 *   (d) the vertical (row) convention, wave-2 barcode fix (F1 2026-09-14): dy
 *       is PIXEL-denominated and active at every zoom (the old `rpp >= 2 → 0`
 *       cutoff is gone), so the half-row boundary widens into a soft band
 *       (≥2.5 px, ≤8 px mush bar) both at rpp 2.2 (level-0 triple) and at the
 *       rpp 3.05 DEFAULT — which rides the row-mip path, where the same triple
 *       is applied to the deep-row Gaussian (`rowMipSoft`; `info.rowDy` ≈ 6.7
 *       rows there). The isolated-wall magnitude exemption (SUM-mip contract)
 *       stays covered by mips.spec.ts.
 *
 * All fixtures are synthetic, driven through the ?test=heatmap hook
 * (window.__flowmapTest) and read back with gl.readPixels — deterministic.
 * Calibrated against the frozen sigma law (lane F probe, 2026-09-12); bars sit
 * ~1.3–2× above the measured values.
 */

const ROWS = 8;
const LAYERS = 2; // capacity = 512 columns; only ≤64 are needed
const WIDTH = 512;
const HEIGHT = 256;

function luma(px: number[], i: number): number {
  return 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
}

/** Population variance of the per-pixel luma along a strip (structure detector). */
function lumaVariance(px: number[]): number {
  const n = px.length / 4;
  const vals: number[] = [];
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const l = luma(px, i);
    vals.push(l);
    mean += l;
  }
  mean /= n;
  let v = 0;
  for (const l of vals) v += (l - mean) * (l - mean);
  return v / n;
}

/** p95 of |Δluma| between adjacent pixels (hard-column-step detector). */
function p95AdjacentStep(px: number[]): number {
  const vals: number[] = [];
  for (let i = 0; i < px.length / 4; i++) vals.push(luma(px, i));
  const steps: number[] = [];
  for (let i = 1; i < vals.length; i++) steps.push(Math.abs(vals[i] - vals[i - 1]));
  steps.sort((a, b) => a - b);
  return steps[Math.min(steps.length - 1, Math.ceil(0.95 * steps.length) - 1)];
}

/** 10–90 % transition width (px) of a monotone dark→bright edge in a strip. */
function transition10to90(px: number[]): number {
  const vals: number[] = [];
  for (let i = 0; i < px.length / 4; i++) vals.push(luma(px, i));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const amp = max - min;
  if (amp < 40) return Number.POSITIVE_INFINITY; // no readable edge
  const lo = min + 0.1 * amp;
  const hi = min + 0.9 * amp;
  const loIdx = vals.findIndex((v) => v >= lo);
  const hiIdx = vals.findIndex((v) => v >= hi);
  if (loIdx < 0 || hiIdx < 0) return Number.POSITIVE_INFINITY;
  return hiIdx - loIdx + 1;
}

test('deep zoom (cpp 0.5) shows no hard column steps — Gaussian plan active', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // Alternating dim (0.2) / bright (1.0) columns at cpp 0.5 (2 px per cell).
  // A nearest-cell sampler would paint hard 2-px steps (per-step |Δluma| ≫ 30
  // at this contrast); the Gaussian spreads each edge over ~6 px.
  const result = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, false);
      const dim = new Array(cfg.rows).fill(0.2);
      const bright = new Array(cfg.rows).fill(1.0);
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < 64; s++) api.appendColumn(s, s % 2 === 0 ? dim : bright, zeros);
      api.setEncoding(1, 1, false);
      // colf(x) = (x + 0.5)/2 − 126.75 → column 0 covers x 254..255, column 29
      // ends at x≈314; the whole 60-px strip is resident.
      api.setView({ colOffset: -126.75, colScale: 256, rowOffset: 0, rowScale: cfg.rows });
      api.render();
      const info = api.levelInfo();
      const strip = api.readPixels(254, cfg.height >> 1, 60, 1);
      return { info, strip };
    },
    { rows: ROWS, layers: LAYERS, width: WIDTH, height: HEIGHT },
  );

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(result.info.colsPerPixel).toBeCloseTo(0.5, 5);
  // The Gaussian plan is the active sampler at this footprint (σ 1.25 cols →
  // the 5-tap ≥3σ-truncation tier).
  expect(result.info.smoothSigma).toBeCloseTo(1.25, 5); // 2.5 × 0.5
  expect(result.info.smoothTaps).toBe(5);
  const p95 = p95AdjacentStep(result.strip as number[]);
  expect(p95, `p95 adjacent step ${p95.toFixed(2)} (must stay ≪ the cell contrast)`).toBeLessThan(
    15,
  );
});

test('column-edge transition widens with cpp but never smears multi-cell', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  const result = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, false);
      const dim = new Array(cfg.rows).fill(0.2);
      const bright = new Array(cfg.rows).fill(1.0);
      const zeros = new Array(cfg.rows).fill(0);
      // Wide dim plateau (cols 0..191) then bright (192..255) — fully resident
      // at every zoom level, so the readback sees both plateaus.
      for (let s = 0; s < 256; s++) api.appendColumn(s, s < 192 ? dim : bright, zeros);
      api.setEncoding(1, 1, false);

      const rows: { cpp: number; sigma: number; strip: number[] }[] = [];
      for (const cpp of [0.25, 0.5, 1, 2]) {
        const colScale = cpp * cfg.width;
        const colOffset = 192 - colScale * (0.5 + 0.5 / cfg.width);
        api.setView({ colOffset, colScale, rowOffset: 0, rowScale: cfg.rows });
        api.render();
        const info = api.levelInfo();
        const strip = api.readPixels(cfg.width / 2 - 32, cfg.height >> 1, 64, 1);
        rows.push({ cpp, sigma: info.smoothSigma, strip: Array.from(strip) });
      }
      return rows;
    },
    { rows: ROWS, layers: LAYERS, width: WIDTH, height: HEIGHT },
  );

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);

  // Calibrated bars (lane F probe, 2026-09-12): measured 5/6/4/2 px for
  // cpp 0.25/0.5/1/2. sigma is pinned at 2.5 SCREEN pixels, so the edge is
  // ~6.4 px (10–90) at deep zoom and sharpens as the 2-column cap engages —
  // never the 40–200 px multi-cell smear of the old kernel.
  const bars: Record<string, number> = { '0.25': 7, '0.5': 8, '1': 6, '2': 4 };
  for (const row of result) {
    const width = transition10to90(row.strip);
    expect(Number.isFinite(width), `cpp ${row.cpp} reads a real edge (got ${width})`).toBe(true);
    expect(
      width,
      `cpp ${row.cpp}: 10–90 width ${width} px must stay ≤ ${bars[String(row.cpp)]} px`,
    ).toBeLessThanOrEqual(bars[String(row.cpp)]);
  }
});

test('row-only path (rpp 3.05, cpp 0.25) keeps the time-axis stripe structure', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // The owner's scrolled-back regime: a collapsing PRICE axis (rpp 3.05 — the
  // 4×4 SUM mip would paint 4-column blocks) while time is deep-zoomed (cpp
  // 0.25). Alternating 0.2/1.0 columns: the row-only mip keeps stripes as
  // distinct cells (measured variance ≈ 393; the block-averaged path collapses
  // toward flat). The Gaussian (sigma 0.625 cols) keeps most of the contrast.
  const result = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      const caps = api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ true);
      if (!caps.colorBufferFloat || !caps.mipsEnabled) return { skipped: true as const, caps };

      const dim = new Array(cfg.rows).fill(0.2);
      const bright = new Array(cfg.rows).fill(1.0);
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, s % 2 === 0 ? dim : bright, zeros);
      api.setEncoding(1, cfg.norm, false);

      // cpp 0.25: 128 columns across 512 px. rpp 3.05: 780.8 rows across 256 px
      // (rowOffset 600 keeps the window inside the 2048-row grid).
      api.setView({ colOffset: 0, colScale: 128, rowOffset: 600, rowScale: 780.8 });
      api.render();
      const info = api.levelInfo();
      const strip = api.readPixels(0, cfg.height >> 1, 32, 1);
      return { skipped: false as const, caps, info, strip };
    },
    { rows: 2048, layers: 2, width: 512, height: 256, nCols: 130, norm: 4 },
  );

  test.skip(result.skipped === true, 'EXT_color_buffer_float / SUM mips unavailable on this GL backend');
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  if (result.skipped) return;

  expect(result.info.rowOnly, 'draw selected the row-only mip').toBe(true);
  expect(result.info.colsPerPixel).toBeCloseTo(0.25, 5);
  expect(result.info.smoothSigma).toBeCloseTo(0.625, 5);
  const variance = lumaVariance(result.strip as number[]);
  expect(variance, `row-only strip luma variance ${variance.toFixed(1)}`).toBeGreaterThan(150);
});

test('vertical soft band at rpp 2.2: the level-0 triple is ACTIVE (no dy=0 freeze)', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // One column profile: dim lower half (rows 0..31), bright upper half (32..63).
  // rpp 2.2 (the OLD dy=0 ceiling): under the wave-2 law dy = 2.2 × 2.2 = 4.84
  // rows ≈ 2.2 SCREEN px, so this view MUST soften — the "dy=0 freeze at
  // rpp >= 2" was the exact defect the barcode campaign proved at the default.
  const strip = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ false);

      const bid = new Array(cfg.rows).fill(0);
      for (let r = 0; r < cfg.rows; r++) bid[r] = r < cfg.rows / 2 ? 0.2 : 1.0;
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, bid, zeros);
      api.setEncoding(1, cfg.norm, false);

      // rpp 2.2; cpp 0.25 (64 columns / 256 px). Boundary row 32 sits at
      // y = 32/2.2 ≈ 14.5 px (bottom-up readback): read a 22-px window around
      // it, strictly inside the 0..64-row visible span (no background rows).
      api.setView({ colOffset: 0, colScale: 64, rowOffset: 0, rowScale: 2.2 * 64 });
      api.render();
      return api.readPixels(1, 4, 1, 22);
    },
    { rows: 64, layers: 1, width: 256, height: 64, nCols: 70, norm: 1.2 },
  );

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  const edge = transition10to90(strip as number[]);
  // eslint-disable-next-line no-console
  console.log(`[F1] rpp 2.2 vertical 10-90 edge: ${edge} px`);
  // Measured 4 px (wave-2 F1, 2026-09-14): mandatory ≥3 px bar with 25% headroom.
  expect(edge, `vertical 10-90 edge ${edge} px (soft band at rpp 2.2)`).toBeGreaterThanOrEqual(3);
  expect(edge, `vertical 10-90 edge ${edge} px (no mush > 8 px)`).toBeLessThanOrEqual(8);
});

test('vertical soft band: dy>0 (rpp 0.5) widens the half-row boundary but never mushes', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // Same dim/bright half-row boundary at rpp 0.5 (dy = 2.2 × 0.5 = 1.1 rows ≈
  // 2.2 px): the barcode fix turns the hard 1-px step into a soft band. The
  // 10-90 edge must widen past the hairline regime yet stay inside the mush
  // bar (< 8 px) — price levels stay distinguishable.
  const strip = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ false);

      const bid = new Array(cfg.rows).fill(0);
      for (let r = 0; r < cfg.rows; r++) bid[r] = r < cfg.rows / 2 ? 0.2 : 1.0;
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, bid, zeros);
      api.setEncoding(1, cfg.norm, false);

      // rpp 0.5 over rows 16..48; boundary row 32 at y = (32-16)/0.5 = 32 px.
      api.setView({ colOffset: 0, colScale: 64, rowOffset: 16, rowScale: 0.5 * 64 });
      api.render();
      return api.readPixels(1, 20, 1, 24);
    },
    { rows: 64, layers: 1, width: 256, height: 64, nCols: 70, norm: 1.2 },
  );

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  const edge = transition10to90(strip as number[]);
  expect(edge, `vertical 10-90 edge ${edge} px (soft band, no hairline)`).toBeGreaterThanOrEqual(2.5);
  expect(edge, `vertical 10-90 edge ${edge} px (no mush > 8 px)`).toBeLessThanOrEqual(8);
});

test('vertical default (rpp 3.05, row-mip path): the rowMipSoft triple widens the level boundary', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // THE default-view case the barcode campaign kept failing: rpp 3.05 rides
  // the row-mip path (`fetchRowMipGauss` + its isolated-wall keep), where the
  // FIRST fix left single levels crisp. Wave 2 wraps that fetch in the same
  // pixel-denominated 0.25/0.5/0.25 triple (rowMipSoft, offset dy/4 texels):
  // a level boundary must widen into the 3–8 px band — soft, not a hairline,
  // not mush. A dim/bright half-grid boundary keeps the fixture simple; the
  // isolated single-row spike amplitude contract stays with mips.spec.ts.
  const result = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      const caps = api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ true);
      if (!caps.colorBufferFloat || !caps.mipsEnabled) return { skipped: true as const, caps };

      const bid = new Array(cfg.rows).fill(0);
      for (let r = 0; r < cfg.rows; r++) bid[r] = r < cfg.rows / 2 ? 0.2 : 1.0;
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, bid, zeros);
      // 4-row row-mip sums: the dim plateau ≈ 0.8, the bright plateau ≈ 4.0;
      // norm 5.33 puts them at t ≈ 0.15 / 0.75 — both off the ramp rails so
      // the measured edge is the KERNEL, not a clamp.
      api.setEncoding(1, cfg.norm, false);

      // rpp 3.05 (780.8 rows across 256 px): boundary row 1024 sits at
      // y = (1024 - 633.6) / 3.05 = 128 px (bottom-up readback).
      api.setView({
        colOffset: 0,
        colScale: 64,
        rowOffset: cfg.rows / 2 - (3.05 * cfg.height) / 2,
        rowScale: 3.05 * cfg.height,
      });
      api.render();
      const info = api.levelInfo();
      const strip = api.readPixels(1, cfg.height / 2 - 12, 1, 24);
      return { skipped: false as const, caps, info, strip };
    },
    { rows: 2048, layers: 2, width: 512, height: 256, nCols: 130, norm: 4 / 0.75 },
  );

  test.skip(result.skipped === true, 'EXT_color_buffer_float / SUM mips unavailable on this GL backend');
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  if (result.skipped) return;

  expect(result.info.rowOnly, 'draw selected the row-only mip').toBe(true);
  expect(result.info.rowFade).toBe(1);
  // The wave-2 mandate: the pixel-denominated triple is ACTIVE at the default
  // (dy = 2.2 × 3.05 ≈ 6.71 ROW units; sampleInfo reports it additively).
  if (typeof result.info.rowDy === 'number') {
    expect(result.info.rowDy).toBeCloseTo(2.2 * 3.05, 3);
  }
  const edge = transition10to90(result.strip as number[]);
  // eslint-disable-next-line no-console
  console.log(`[F1] rpp 3.05 (row-mip) vertical 10-90 edge: ${edge} px`);
  expect(edge, `default-view vertical 10-90 edge ${edge} px (no hairline)`).toBeGreaterThanOrEqual(3);
  expect(edge, `default-view vertical 10-90 edge ${edge} px (no mush > 8 px)`).toBeLessThanOrEqual(8);
});

test('vertical rpp 2.2 (D4 in-one-notch zone): the row-mip engages and softens the boundary', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // Wave 3 / F10: D4 measured one wheel notch in from the default (rpp 2.07) as
  // a barcode dead zone — the old rowFade renormalization zeroed the row-mip
  // path through [2.0, 2.5] while the sparse level-0 triple (±dy 4.55 rows)
  // painted three disconnected hairlines. The edge now starts at 1.5, so this
  // view runs the DENSE row-mip kernel at weight 0.7: the level boundary must
  // read as a 3–8 px soft band.
  const result = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      const caps = api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ true);
      if (!caps.colorBufferFloat || !caps.mipsEnabled) return { skipped: true as const, caps };

      const bid = new Array(cfg.rows).fill(0);
      for (let r = 0; r < cfg.rows; r++) bid[r] = r < cfg.rows / 2 ? 0.2 : 1.0;
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, bid, zeros);
      // 4-row row-mip sums: dim ≈ 0.8, bright ≈ 4.0; norm 5.33 → t ≈ 0.15/0.75.
      api.setEncoding(1, cfg.norm, false);

      // rpp 2.2 (563.2 rows across 256 px): boundary row 1024 at y=128.
      api.setView({
        colOffset: 0,
        colScale: 64,
        rowOffset: cfg.rows / 2 - (2.2 * cfg.height) / 2,
        rowScale: 2.2 * cfg.height,
      });
      api.render();
      const info = api.levelInfo();
      const strip = api.readPixels(1, cfg.height / 2 - 12, 1, 24);
      return { skipped: false as const, caps, info, strip };
    },
    { rows: 2048, layers: 2, width: 512, height: 256, nCols: 130, norm: 4 / 0.75 },
  );

  test.skip(result.skipped === true, 'EXT_color_buffer_float / SUM mips unavailable on this GL backend');
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  if (result.skipped) return;

  expect(result.info.rowOnly, 'draw selected the row-only mip at rpp 2.2').toBe(true);
  // The F10 ramp: (2.2 − 1.5) / 1.0 = 0.7.
  expect(result.info.rowFade).toBeCloseTo(0.7, 3);
  if (typeof result.info.rowDy === 'number') {
    expect(result.info.rowDy).toBeCloseTo(2.2 * 2.2, 3);
  }
  const edge = transition10to90(result.strip as number[]);
  // eslint-disable-next-line no-console
  console.log(`[F10] rpp 2.2 (row-mip mix) vertical 10-90 edge: ${edge} px`);
  expect(edge, `rpp 2.2 vertical 10-90 edge ${edge} px (no hairline)`).toBeGreaterThanOrEqual(3);
  expect(edge, `rpp 2.2 vertical 10-90 edge ${edge} px (no mush > 8 px)`).toBeLessThanOrEqual(8);
});

test('vertical rpp 6.1 multi-tap footprint: per-tap softening (D4 zoom-out zone a)', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // D4 zone a (rpp > 4): the historical bare block sum had NO vertical kernel,
  // so 88–90% of bands stayed sub-3-px needles. Wave 3 / F10 routes every tap
  // of the multi-tap footprint through the same Gaussian + triple; at rpp 6.1
  // (nRowTaps 2) the boundary must soften into the 3–8 px band.
  const result = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      const caps = api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ true);
      if (!caps.colorBufferFloat || !caps.mipsEnabled) return { skipped: true as const, caps };

      const bid = new Array(cfg.rows).fill(0);
      for (let r = 0; r < cfg.rows; r++) bid[r] = r < cfg.rows / 2 ? 0.2 : 1.0;
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, bid, zeros);
      // nRowTaps = ceil(6.1 / 4) = 2 → footprint sums double: dim ≈ 1.6,
      // bright ≈ 8.0; norm 16 puts them at t 0.1 / 0.5, both off the rails.
      api.setEncoding(1, cfg.norm, false);

      // rpp 6.1 (1561.6 rows across 256 px): boundary row 1024 at y=128.
      api.setView({
        colOffset: 0,
        colScale: 64,
        rowOffset: cfg.rows / 2 - (6.1 * cfg.height) / 2,
        rowScale: 6.1 * cfg.height,
      });
      api.render();
      const info = api.levelInfo();
      const strip = api.readPixels(1, cfg.height / 2 - 12, 1, 24);
      return { skipped: false as const, caps, info, strip };
    },
    { rows: 2048, layers: 2, width: 512, height: 256, nCols: 130, norm: 16 },
  );

  test.skip(result.skipped === true, 'EXT_color_buffer_float / SUM mips unavailable on this GL backend');
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  if (result.skipped) return;

  expect(result.info.rowOnly, 'draw selected the row-only mip at rpp 6.1').toBe(true);
  expect(result.info.rowFade).toBe(1);
  expect(result.info.nRowTaps).toBe(2); // the multi-tap branch is the one under test
  if (typeof result.info.rowMipSoften === 'number') {
    expect(result.info.rowMipSoften).toBe(1);
  }
  const edge = transition10to90(result.strip as number[]);
  // eslint-disable-next-line no-console
  console.log(`[F10] rpp 6.1 (multi-tap soft) vertical 10-90 edge: ${edge} px`);
  expect(edge, `rpp 6.1 vertical 10-90 edge ${edge} px (no hairline)`).toBeGreaterThanOrEqual(3);
  expect(edge, `rpp 6.1 vertical 10-90 edge ${edge} px (no mush > 8 px)`).toBeLessThanOrEqual(8);
});
