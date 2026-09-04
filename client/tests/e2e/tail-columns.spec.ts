import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tail-columns regression (the "heatmap fades out after ~256 columns" bug).
 *
 * The level-0 sampling path interpolates the field BILINEARLY in ring-slot
 * space: the shader must fold the absolute col_seq into (layer, tile-column)
 * with a mod before fetching. A version of that sampler fetched by the raw
 * absolute column instead — correct for the first tile, silently ZERO for every
 * later column — so a live session rendered a hard vertical edge where the
 * second tile layer begins and an empty strip over the newest data, while the
 * crosshair (CPU cache) kept reporting real sizes. This spec pins the contract:
 * with a wall in EVERY column across MULTIPLE tile layers, the leftmost and
 * rightmost visible columns must render identically bright.
 *
 * Geometry matters: 4096 rows × 64 layers is the production `deep`-band ring,
 * and the append count (5000) crosses four tile layers.
 */
test('level-0 field renders the FULL resident window — no fade past tile layer 1', async ({
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
      api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ true);

      const bid = new Array(cfg.rows).fill(0);
      bid[Math.floor(cfg.rows / 2)] = cfg.wallValue;
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, bid, zeros);
      api.setEncoding(1, cfg.norm, false);
      api.setView({
        colOffset: cfg.nCols - 309,
        colScale: 309,
        rowOffset: Math.floor(cfg.rows / 2) - 150,
        rowScale: 300,
      });

      const maxLuma = (strip: number[]) => {
        let m = 0;
        for (let i = 0; i < strip.length; i += 4) {
          const l = 0.299 * strip[i] + 0.587 * strip[i + 1] + 0.114 * strip[i + 2];
          if (l > m) m = l;
        }
        return m;
      };
      const colLuma = (col: number) => {
        const frac = (col - (cfg.nCols - 309)) / 309;
        const x = Math.min(cfg.width - 1, Math.max(0, Math.round(frac * (cfg.width - 1))));
        return +maxLuma(api.readPixels(x, 0, 1, cfg.height)).toFixed(1);
      };
      const left = colLuma(cfg.nCols - 309);
      const mid = colLuma(cfg.nCols - 155);
      const nearEnd = colLuma(cfg.nCols - 55);
      const last = colLuma(cfg.nCols - 1);

      // Artifact PNG of the whole view for the report.
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
      return { left, mid, nearEnd, last, png: cv.toDataURL('image/png') };
    },
    { rows: 4096, layers: 64, width: 927, height: 993, wallValue: 50, norm: 100, nCols: 5000 },
  );

  mkdirSync('test-results/artifacts', { recursive: true });
  writeFileSync(
    join('test-results/artifacts/tail-columns.png'),
    Buffer.from(result.png.replace(/^data:image\/png;base64,/, ''), 'base64'),
  );

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  // EVERY probed column across all four tile layers renders at wall brightness —
  // including the very last column (the blank-strip failure mode reads ~2.7).
  for (const [label, luma] of Object.entries({
    left: result.left,
    mid: result.mid,
    nearEnd: result.nearEnd,
    last: result.last,
  })) {
    expect(luma, `${label} column wall luma`).toBeGreaterThan(100);
  }
  // And they agree within noise — column position must not affect brightness.
  expect(Math.abs(result.last - result.left)).toBeLessThan(5);
});
