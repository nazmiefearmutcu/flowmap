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
 *   (d) the vertical (row) convention, POST barcode-fix (W1 2026-09-13): the
 *       dy=0 endpoint (rpp 2.2 — rowSmoothDyFor returns 0 there) stays crisp
 *       (≤3 px across a half-row boundary), while dy>0 (rpp 0.5) deliberately
 *       widens the same boundary into a soft band (≥2.5 px) that still stays
 *       inside the mush bar (≤8 px). The deep-row Gaussian's isolated-wall
 *       exemption is covered by mips.spec.ts.
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

test('vertical endpoint: dy=0 (rpp 2.2) keeps the half-row boundary ≤ 3 px', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // One column profile: dim lower half (rows 0..31), bright upper half (32..63).
  // rpp 2.2 (> the 2.0 soften ceiling) keeps the EXACT legacy level-0 path:
  // rowSmoothDyFor returns 0 there, so this end of the barcode fix must stay a
  // hard ~1-px edge (the "dy=0 endpoint exact" contract; larger rpp also stays
  // crisp through the row-mip Gaussian, which only kicks in at rpp >= 2.5 with
  // a 1-tap footprint — here the draw is still level-0).
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
  expect(edge, `vertical 10-90 edge ${edge} px (dy=0 endpoint must stay crisp)`).toBeLessThanOrEqual(3);
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
