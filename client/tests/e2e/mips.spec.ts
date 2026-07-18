import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * T7 verification — SUM-mips keep liquidity walls bright when you zoom OUT.
 *
 * The failure this guards against: with a plain average-downsampled mip, a
 * 500-lot wall surrounded by empty ticks renders as ~500/16 when price zooms out
 * (many rows collapse per pixel) — walls DILUTE exactly when a heatmap must show
 * them most. Bookmap tick-grouping needs the SUMMED resting size, so the mips are
 * SUMS and `generateMipmap` is never used.
 *
 * Setup: a single bright wall row (size 500) surrounded by empty rows, in many
 * identical columns, driven through the real WebGL2 renderer via the
 * `?test=heatmap` hook with the SUM-mip chain enabled (window.__flowmapTest,
 * init(..., mips=true)). We render three views of the SAME data:
 *   - native  (rows-per-pixel < 1  → level 0, one tap)
 *   - mid     (rows-per-pixel ≈ 4  → level 1)
 *   - zoomed  (rows-per-pixel ≈ 16 → level 2)
 * and read the wall's brightness in each. The contract: the wall stays as bright
 * zoomed out as native (SUM-preserved), NOT ~1/16 of it (which is what an average
 * mip would produce). We assert B_zoomed > 0.5·B_native (and, more strongly, that
 * it is comparable AND far above the ~1/16 average regime).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

// Geometry. ROWS divisible by 16 → both mip levels; a short canvas so a full-grid
// price view collapses ~16 rows per pixel (level 2) without needing rowScale>rows.
const ROWS = 1024;
const LAYERS = 2; // capacity = 256*2 = 512 columns
const WIDTH = 256;
const HEIGHT = 64;
const WALL_ROW = ROWS / 2; // 512 — a single, isolated wall row
const WALL_VALUE = 500; // the "500-lot wall" from the spec
const N_COLS = 300; // enough that the level-2 columns around center are generated
// Normalize so the native wall lands mid-bright (t≈0.75): dilution is then clearly
// visible (an average mip would fall to t≈0.05, near the black floor).
const NORM = WALL_VALUE / 0.75;
// What a (wrong) average mip would show the wall as, at level 2: 500/16.
const AVG_MIP_INTENSITY = WALL_VALUE / 16;

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Brightest luma along a 1-px-wide vertical strip (captures the wall line). */
function maxStripLuma(strip: number[], height: number): number {
  let m = 0;
  for (let y = 0; y < height; y++) {
    const i = y * 4;
    const l = luma(strip[i], strip[i + 1], strip[i + 2]);
    if (l > m) m = l;
  }
  return m;
}

test('SUM-mips keep a liquidity wall bright when zoomed out (not diluted ~1/16)', async ({
  page,
}) => {
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
      const caps = api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ true);

      // Single isolated wall row, everything else exactly zero. The ask channel
      // is all-zero (SUM combines bid+ask, so the wall shows on the bid alone).
      const bid = new Array(cfg.rows).fill(0);
      bid[cfg.wallRow] = cfg.wallValue;
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, bid, zeros);

      api.setEncoding(1, cfg.norm, false);

      // Center on a column whose level-2 texel is fully generated (col 150 →
      // level-2 col 9, produced once col 159 was appended).
      const COL_OFFSET = 140;
      const COL_SCALE = 20;

      // Helper: set a price view that puts the wall row at the vertical center,
      // read the center strip, and report the level chosen + wall brightness.
      const sample = (rowScale: number) => {
        api.setView({
          colOffset: COL_OFFSET,
          colScale: COL_SCALE,
          rowOffset: cfg.wallRow - rowScale / 2,
          rowScale,
        });
        const info = api.levelInfo();
        const strip = api.readPixels(cfg.width >> 1, 0, 1, cfg.height);
        return { info, strip };
      };

      // native: 32 rows across 64 px → rpp 0.5 → level 0.
      const native = sample(32);
      // mid: 256 rows across 64 px → rpp 4 → level 1.
      const mid = sample(256);
      // zoomed: full 1024-row grid across 64 px → rpp 16 → level 2.
      const zoomed = sample(cfg.rows);

      // PNG of the zoomed-out frame (the wall must still be a visible bright line).
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

      return { caps, native, mid, zoomed, png };
    },
    {
      rows: ROWS,
      layers: LAYERS,
      width: WIDTH,
      height: HEIGHT,
      wallRow: WALL_ROW,
      wallValue: WALL_VALUE,
      nCols: N_COLS,
      norm: NORM,
    },
  );

  const bNative = maxStripLuma(result.native.strip, HEIGHT);
  const bMid = maxStripLuma(result.mid.strip, HEIGHT);
  const bZoomed = maxStripLuma(result.zoomed.strip, HEIGHT);

  // Persist the zoomed-out frame + the headline numbers.
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    join(ARTIFACT_DIR, 'mips-zoomed.png'),
    Buffer.from(result.png.replace(/^data:image\/png;base64,/, ''), 'base64'),
  );
  const summary = {
    mips: { enabled: result.caps.mipsEnabled, maxLevel: result.caps.maxMipLevel },
    levels: {
      native: result.native.info,
      mid: result.mid.info,
      zoomed: result.zoomed.info,
    },
    wall_brightness: {
      B_native: Number(bNative.toFixed(1)),
      B_mid_level1: Number(bMid.toFixed(1)),
      B_zoomed_level2: Number(bZoomed.toFixed(1)),
      ratio_zoomed_over_native: Number((bZoomed / Math.max(1e-9, bNative)).toFixed(3)),
    },
    control: {
      avg_mip_intensity: AVG_MIP_INTENSITY,
      note: 'An average mip would render the wall at 500/16=31.25 -> t≈0.05 -> luma≈11 (near the black floor). SUM keeps it at the native brightness.',
    },
  };
  // eslint-disable-next-line no-console
  console.log('[mips] ' + JSON.stringify(summary, null, 2));

  // --- Assertions -----------------------------------------------------------------
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);

  // The SUM-mip chain actually exists (EXT_color_buffer_float under SwiftShader).
  expect(result.caps.colorBufferFloat).toBe(true);
  expect(result.caps.mipsEnabled).toBe(true);
  expect(result.caps.maxMipLevel).toBe(2);

  // Level selection tracks price zoom-out: native→0, mid→1, zoomed→2.
  expect(result.native.info.level).toBe(0);
  expect(result.mid.info.level).toBe(1);
  expect(result.zoomed.info.level).toBe(2);

  // The wall is genuinely bright at native zoom (baseline).
  expect(bNative, `native wall luma ${bNative.toFixed(1)}`).toBeGreaterThan(150);

  // THE POINT: zoomed out the wall stays bright — SUM-preserved, not ~1/16.
  expect(
    bZoomed,
    `zoomed(level 2) wall luma ${bZoomed.toFixed(1)} vs native ${bNative.toFixed(1)}`,
  ).toBeGreaterThan(bNative * 0.5);
  // Stronger: it is COMPARABLE to native (a genuine sum), and the level-1 hop too.
  expect(bZoomed).toBeGreaterThan(bNative * 0.8);
  expect(bMid).toBeGreaterThan(bNative * 0.8);
  // And clearly OUT of the average-mip regime (which would be luma ~11, near black).
  expect(bZoomed, 'zoomed wall must not be diluted toward the black floor').toBeGreaterThan(50);
});
