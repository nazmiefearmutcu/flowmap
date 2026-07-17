import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * T5 verification — the live sim heatmap renders end-to-end against the REAL
 * server (booted by playwright.config's webServer array: flowmap-server on 8720
 * + vite proxying to it). This is the first milestone-visible deliverable.
 *
 * The page loads the default app (no `?test=` hook), which subscribes the sim
 * feed and auto-follows the right edge. The spec asserts, over the live stream:
 *   (a) the connection reaches `live` and columns arrive (newest col_seq > 0);
 *   (b) new columns keep arriving over time (col_seq advances → scrolling);
 *   (c) the rendered canvas CHANGES between two captures ≥1 s apart (the heatmap
 *       is scrolling, not a frozen frame);
 *   (d) a substantial non-background region is present (thermal color pixels —
 *       the liquidity walls + ladder, not an all-black canvas);
 *   (e) no console errors and no GL errors (checkGLError throws → pageerror).
 *
 * Canvas pixels are read by copying the WebGL canvas onto a 2D canvas
 * (`drawImage`) — reliable because the renderer keeps `preserveDrawingBuffer`.
 * A PNG screenshot of the canvas is saved as the report artifact.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

/** Non-background luma threshold and the minimum bright-pixel count expected. */
const THERMAL_LUMA = 25;
const MIN_THERMAL_PIXELS = 200;

interface CanvasStats {
  thermal: number;
  checksum: number;
  width: number;
  height: number;
}

test('live sim heatmap renders and scrolls against the real server', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/');

  // Wait for the live wiring: renderer up, connection `live`, columns flowing.
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      if (!live) return false;
      const status = live.store.getState().status;
      const range = live.renderer.residentRange();
      return status === 'live' && range !== null && range.count > 5;
    },
    undefined,
    { timeout: 45_000 },
  );

  // Pixel-stats reader: copy the GL canvas to a 2D canvas and summarise it.
  const readStats = (): Promise<CanvasStats> =>
    page.evaluate((lumaThreshold) => {
      const c = document.querySelector('canvas#gl') as HTMLCanvasElement;
      const off = document.createElement('canvas');
      off.width = c.width;
      off.height = c.height;
      const ctx = off.getContext('2d')!;
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, off.width, off.height).data;
      let thermal = 0;
      let checksum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (luma > lumaThreshold) thermal++;
        // Position-weighted running sum: sensitive to WHERE pixels are, so a
        // horizontal scroll of identical-looking columns still changes it.
        checksum = (checksum + ((i % 1009) + 1) * (d[i] + d[i + 1] + d[i + 2])) >>> 0;
      }
      return { thermal, checksum, width: off.width, height: off.height };
    }, THERMAL_LUMA);

  const seqAt = (): Promise<number> =>
    page.evaluate(
      () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.newestColSeq,
    );

  const stats1 = await readStats();
  const seq1 = await seqAt();

  // ≥1 s of live streaming (sim finalizes 4 cols/s → several new columns).
  await page.waitForTimeout(1500);

  const stats2 = await readStats();
  const seq2 = await seqAt();

  // Save the canvas as the report artifact.
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const shotPath = join(ARTIFACT_DIR, 'live-sim.png');
  const shot = await page.locator('canvas#gl').screenshot();
  writeFileSync(shotPath, shot);

  // (a)/(b) columns arrived and kept advancing → the right edge scrolls.
  expect(seq1).toBeGreaterThan(0);
  expect(seq2, `col_seq must advance (was ${seq1}, now ${seq2})`).toBeGreaterThan(seq1);

  // (c) the rendered image changed between the two captures.
  expect(stats1.width).toBeGreaterThan(0);
  expect(stats1.height).toBeGreaterThan(0);
  expect(
    stats2.checksum,
    'canvas pixels must change over time (heatmap should be scrolling)',
  ).not.toBe(stats1.checksum);

  // (d) a real non-background region is present in both frames.
  expect(stats1.thermal).toBeGreaterThan(MIN_THERMAL_PIXELS);
  expect(stats2.thermal).toBeGreaterThan(MIN_THERMAL_PIXELS);

  // (e) clean run — no console errors, no GL errors.
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
