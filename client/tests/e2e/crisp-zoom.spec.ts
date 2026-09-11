import { expect, test } from '@playwright/test';

/**
 * Campaign 5 (contract F4) — the level-0 sampler must sharpen as you zoom in.
 *
 * The historical level-0 kernel (bilinear + fixed 0.25/0.5/0.25 column blur)
 * spans ~4 columns; at deep zoom one data column spans many device pixels and
 * the kernel smeared the boundary between adjacent columns over 40–200 px (S3
 * measurement). The scale-aware sampler switches to crisp cell sampling
 * (horizontal nearest column + vertical bilinear) at colsPerPixel <= 0.5 and
 * keeps the historical blur at colsPerPixel >= 1.5, cross-fading in between.
 *
 * Drives the real renderer via the ?test=heatmap hook (window.__flowmapTest,
 * see gl/testHook.ts) and pixel-reads the boundary between dim column 0 and a
 * bright run of columns 1..7 (so the readback strip never contains
 * out-of-window background). Fully deterministic: synthetic columns, fixed
 * sizes, whole scenario inside one page.evaluate.
 */

const ROWS = 8;
const LAYERS = 2; // capacity = 512 columns; only 8 are needed
const WIDTH = 512;
const HEIGHT = 256;

function luma(px: number[], i: number): number {
  return 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
}

/** Population variance of the per-pixel luma along a strip (R2-M3 discriminator). */
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

test('deep zoom paints crisp cell edges; zoomed-out keeps the column blur', async ({ page }) => {
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

      // Column 0 dim (density 0.2), columns 1..7 bright (1.0), real bid/ask
      // arrays (ask zeros → the sum channel paints the bid density).
      const dim = new Array(cfg.rows).fill(0.2);
      const bright = new Array(cfg.rows).fill(1.0);
      const zeros = new Array(cfg.rows).fill(0);
      api.appendColumn(0, dim, zeros);
      for (let s = 1; s < 8; s++) api.appendColumn(s, bright, zeros);
      api.setEncoding(1, 1, false);

      // Cell mode: colScale/width = 256/512 = 0.5 cpp (<= 0.5). With
      // colOffset -127, colf(center x) = (x + 0.5)/2 - 127, so col 0 occupies
      // pixel centers x=254..255 (colf 0.25/0.75) and col 1 starts at x=256
      // (colf 1.25). The readback strip [254, 270) is entirely resident
      // columns — no out-of-window background to skew the 10–90 thresholds.
      api.setView({ colOffset: -127, colScale: 256, rowOffset: 0, rowScale: cfg.rows });
      api.render();
      const infoCell = api.levelInfo();
      const stripCell = api.readPixels(254, cfg.height >> 1, 16, 1);

      // Blur mode: colScale/width = 1024/512 = 2 cpp (>= 1.5) — sub-pixel
      // columns, the historical blur must stay fully engaged.
      api.setView({ colOffset: -511, colScale: 1024, rowOffset: 0, rowScale: cfg.rows });
      api.render();
      const infoBlur = api.levelInfo();
      const stripBlur = api.readPixels(0, cfg.height >> 1, cfg.width, 1);

      return { infoCell, stripCell, infoBlur, stripBlur };
    },
    { rows: ROWS, layers: LAYERS, width: WIDTH, height: HEIGHT },
  );

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);

  // Deep zoom (cpp 0.5): the crisp cell sampler is fully engaged...
  expect(result.infoCell.colsPerPixel).toBeCloseTo(0.5, 5);
  expect(result.infoCell.colCell).toBeCloseTo(1, 5);
  expect(result.infoCell.colBlur).toBeCloseTo(0, 5);
  // ...and the dim→bright boundary is a hard cell edge, not a smear.
  expect(transition10to90(result.stripCell)).toBeLessThanOrEqual(3);

  // Zoomed out (cpp 2): the historical blur is fully engaged.
  expect(result.infoBlur.colsPerPixel).toBeGreaterThanOrEqual(2);
  expect(result.infoBlur.colBlur).toBeCloseTo(1, 5);
  expect(result.infoBlur.colCell).toBeCloseTo(0, 5);
  // Render is still valid (no GL error) and the field is present.
  let maxBlurLuma = 0;
  for (let i = 0; i < result.stripBlur.length / 4; i++) {
    maxBlurLuma = Math.max(maxBlurLuma, luma(result.stripBlur, i));
  }
  expect(maxBlurLuma).toBeGreaterThan(40);
});

test('price zoom-out at deep time zoom samples the row-only mip (R2-M1: no 4-column blocks)', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // The owner's scrolled-back regime: a collapsing PRICE axis (rpp 3.05 — the
  // 4x4 SUM mip would paint 4-column blocks) while time is deep-zoomed
  // (cpp 0.25, one column over 4 px). Alternating 0.2/1.0 columns: with the
  // row-only mip the stripes survive as crisp cells; the old path averages the
  // 4-column block to a flat 0.6 field (near-zero variance).
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
  const variance = lumaVariance(result.strip);
  expect(variance, `row-only strip luma variance ${variance.toFixed(1)}`).toBeGreaterThan(150);
});

test('zoomed-out column blur still renders at the pixel level (R2-M3)', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // Same alternating field rendered at cpp 0.5 (full crisp) and cpp 2 (full
  // blur): the blur must average the 0.2/1.0 period-2 stripes into a flat
  // field, so the strip variance collapses — a GPU-side "always crisp"
  // regression (e.g. a silently dead u_colBlur lookup) fails this discriminator.
  const result = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ false);

      const dim = new Array(cfg.rows).fill(0.2);
      const bright = new Array(cfg.rows).fill(1.0);
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, s % 2 === 0 ? dim : bright, zeros);
      api.setEncoding(1, cfg.norm, false);

      // crisp: cpp 0.5 (64 columns / 128 px), window [32..96) fully resident.
      api.setView({ colOffset: 32, colScale: 64, rowOffset: 0, rowScale: cfg.rows });
      api.render();
      const infoCrisp = api.levelInfo();
      const stripCrisp = api.readPixels(0, cfg.height >> 1, cfg.width, 1);

      // blur: cpp 2 (256 columns / 128 px), window [0..256) fully resident.
      api.setView({ colOffset: 0, colScale: 256, rowOffset: 0, rowScale: cfg.rows });
      api.render();
      const infoBlur = api.levelInfo();
      const stripBlur = api.readPixels(0, cfg.height >> 1, cfg.width, 1);

      return { infoCrisp, stripCrisp, infoBlur, stripBlur };
    },
    { rows: 16, layers: 2, width: 128, height: 64, nCols: 260, norm: 1 },
  );

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);

  expect(result.infoCrisp.colCell).toBeCloseTo(1, 5);
  expect(result.infoBlur.colBlur).toBeCloseTo(1, 5);
  expect(result.infoBlur.colCell).toBeCloseTo(0, 5);

  const vCrisp = lumaVariance(result.stripCrisp);
  const vBlur = lumaVariance(result.stripBlur);
  expect(vCrisp, `crisp strip luma variance ${vCrisp.toFixed(1)}`).toBeGreaterThan(150);
  expect(
    vBlur,
    `blur variance ${vBlur.toFixed(1)} must collapse vs crisp ${vCrisp.toFixed(1)}`,
  ).toBeLessThan(vCrisp * 0.3);

  // The blur render is a real painted field, not a black frame.
  let maxBlurLuma = 0;
  for (let i = 0; i < result.stripBlur.length / 4; i++) {
    maxBlurLuma = Math.max(maxBlurLuma, luma(result.stripBlur, i));
  }
  expect(maxBlurLuma).toBeGreaterThan(40);
});

test('crisp path keeps the vertical half-row boundary within 3 px (R2-L2)', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  // One column profile: dim lower half (rows 0..31), bright upper half (32..63).
  // rpp 1 (64 rows / 64 px) keeps the level-0 crisp path; reading a VERTICAL
  // line across the half boundary catches a y0/fy half-row shift that every
  // horizontal-uniform test would miss.
  const strip = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ false);

      const bid = new Array(cfg.rows).fill(0);
      for (let r = 0; r < cfg.rows; r++) bid[r] = r < cfg.rows / 2 ? 0.2 : 1.0;
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, bid, zeros);
      api.setEncoding(1, cfg.norm, false);

      // rpp 1; cpp 0.25 (64 columns / 256 px) → level 0, full crisp.
      api.setView({ colOffset: 0, colScale: 64, rowOffset: 0, rowScale: cfg.rows });
      api.render();
      return api.readPixels(1, 0, 1, cfg.height);
    },
    { rows: 64, layers: 1, width: 256, height: 64, nCols: 70, norm: 1.2 },
  );

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  const edge = transition10to90(strip);
  expect(edge, `vertical 10-90 edge ${edge} px`).toBeLessThanOrEqual(3);
});
