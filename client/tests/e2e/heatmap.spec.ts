import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * T4 verification — the WebGL2 heatmap actually renders in a real browser.
 *
 * GL cannot be meaningfully unit-mocked, so this drives the real renderer via
 * the `?test=heatmap` hook (window.__flowmapTest) and reads pixels back:
 *   (a) context initializes with no GL errors (checkGLError throws otherwise,
 *       which would reject the evaluate),
 *   (b) a known bright "wall" row renders bright at the expected screen row,
 *   (c) zero-density regions render near-black,
 *   (d) appending more columns advances the resident range and wraps the ring.
 *
 * Bulk work runs inside single page.evaluate closures to avoid per-column
 * round-trips. Fully deterministic: synthetic columns, fixed sizes.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

// Must mirror the browser-side synthetic column (kept in sync by hand — the
// spec asserts against these exact rows).
const ROWS = 256;
const LAYERS = 4; // capacity = 256*4 = 1024 columns
const WIDTH = 512;
const HEIGHT = 512;
const WALL_LO = 126;
const WALL_HI = 130;
const WALL_VALUE = 100;
const NORM = 100;

function luma(px: number[]): number {
  return 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
}

test('heatmap renders resident columns with a bright wall and black voids', async ({ page }) => {
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
      const caps = api.init(cfg.rows, cfg.layers, cfg.width, cfg.height);

      // Build a synthetic column: bright wall across [wallLo..wallHi], a
      // guaranteed-zero band in rows [0..30], low triangular noise elsewhere.
      const makeBid = (): number[] => {
        const bid = new Array(cfg.rows).fill(0);
        for (let r = 0; r < cfg.rows; r++) {
          if (r >= cfg.wallLo && r <= cfg.wallHi) bid[r] = cfg.wallValue;
          else if (r <= 30) bid[r] = 0;
          else bid[r] = (r % 7) * 0.4; // ≤ 2.4, well below the norm floor
        }
        return bid;
      };
      const zeros = new Array(cfg.rows).fill(0);

      const bid = makeBid();
      // 200 identical L2 columns (ask channel = 0 → exercises RG interleave).
      for (let s = 0; s < 200; s++) api.appendColumn(s, bid, zeros);

      api.setEncoding(1, cfg.norm, false);
      api.fitView();
      api.render();

      // Wall sits at rows ~128 → screen center; zero band at rows ~10 → near
      // the bottom (readPixels origin is bottom-left).
      const wallPx = api.readPixels(cfg.width >> 1, cfg.height >> 1, 1, 1);
      const zeroPx = api.readPixels(cfg.width >> 1, 20, 1, 1);
      const rangeAfter200 = api.residentRange();

      // Encode exactly what GL produced into a PNG dataURL (bottom-left→top-left
      // flip) so the saved artifact matches the readback, independent of the
      // compositor / preserveDrawingBuffer.
      const full = api.readPixels(0, 0, cfg.width, cfg.height);
      const cv = document.createElement('canvas');
      cv.width = cfg.width;
      cv.height = cfg.height;
      const c2d = cv.getContext('2d')!;
      const img = c2d.createImageData(cfg.width, cfg.height);
      for (let y = 0; y < cfg.height; y++) {
        const srcRow = (cfg.height - 1 - y) * cfg.width * 4;
        const dstRow = y * cfg.width * 4;
        for (let i = 0; i < cfg.width * 4; i++) img.data[dstRow + i] = full[srcRow + i];
      }
      c2d.putImageData(img, 0, 0);
      const png = cv.toDataURL('image/png');

      // Now append past capacity to prove the ring advances + wraps.
      const bid2 = makeBid();
      for (let s = 200; s < 1200; s++) api.appendColumn(s, bid2, zeros);
      api.fitView();
      const rangeAfter1200 = api.residentRange();
      // Wall still bright after wrap (any column carries it).
      const wallPxAfterWrap = api.readPixels(cfg.width >> 1, cfg.height >> 1, 1, 1);

      return { caps, wallPx, zeroPx, rangeAfter200, rangeAfter1200, wallPxAfterWrap, png };
    },
    {
      rows: ROWS,
      layers: LAYERS,
      width: WIDTH,
      height: HEIGHT,
      wallLo: WALL_LO,
      wallHi: WALL_HI,
      wallValue: WALL_VALUE,
      norm: NORM,
    },
  );

  // Persist the GL readback as a PNG artifact for the report.
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const pngPath = join(ARTIFACT_DIR, 'heatmap.png');
  const b64 = result.png.replace(/^data:image\/png;base64,/, '');
  writeFileSync(pngPath, Buffer.from(b64, 'base64'));

  // (a) Context initialized, capabilities read, no GL errors thrown.
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(result.caps.maxArrayTextureLayers).toBeGreaterThanOrEqual(LAYERS);
  expect(result.caps.maxTextureSize).toBeGreaterThanOrEqual(ROWS);
  expect(result.caps.maxTextureImageUnits).toBeGreaterThanOrEqual(8);
  expect(typeof result.caps.colorBufferFloat).toBe('boolean');

  // (b) Wall row is bright (yellow/white, high LUT color).
  expect(luma(result.wallPx)).toBeGreaterThan(200);
  expect(result.wallPx[0]).toBeGreaterThan(180);
  expect(result.wallPx[1]).toBeGreaterThan(180);
  expect(result.wallPx[2]).toBeGreaterThan(180);

  // (c) Zero-density band is near-black.
  expect(luma(result.zeroPx)).toBeLessThan(30);
  expect(result.zeroPx[0]).toBeLessThan(40);
  expect(result.zeroPx[1]).toBeLessThan(40);
  expect(result.zeroPx[2]).toBeLessThan(40);

  // (d) Resident range advances and wraps at capacity (256*4 = 1024).
  expect(result.rangeAfter200).toEqual({ oldest: 0, newest: 199, count: 200 });
  expect(result.rangeAfter1200.newest).toBe(1199);
  expect(result.rangeAfter1200.count).toBe(ROWS === 256 ? LAYERS * 256 : result.rangeAfter1200.count);
  expect(result.rangeAfter1200.count).toBe(1024);
  expect(result.rangeAfter1200.oldest).toBe(1199 - 1024 + 1);
  // Content survives the wrap: wall still bright.
  expect(luma(result.wallPxAfterWrap)).toBeGreaterThan(200);
});
