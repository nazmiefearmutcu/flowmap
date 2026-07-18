import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * T9 verification — viewport-percentile normalization + crosshair readout, driven
 * through the REAL renderer (ring, per-tile histograms, EMA, exact CPU cache,
 * camera inverse, Crosshair DOM). The app is opened with `?normalize=1` (no live
 * feed) and `renderer.preloadNormalizeScenario()` injects two equal-shaped density
 * regions whose scales differ ×50 — a DIM overnight-style region and a BRIGHT
 * live-edge-style region — plus one KNOWN wall cell with a distinctive exact size.
 * Columns flow through the real `writeColumn` path, so the histograms and the
 * exact column cache are populated exactly as live.
 *
 * Runs headless on ANGLE/SwiftShader (software GL) via the shared launch flags in
 * playwright.config (`--use-gl=angle --use-angle=swiftshader
 * --enable-unsafe-swiftshader --ignore-gpu-blocklist`), so WebGL2 actually
 * renders and pixels can be read back.
 *
 * Asserts:
 *   (a) RENORMALIZATION: after panning from the bright region into the dim region
 *       the norm drops far (viewport-adaptive, not stuck on the bright edge) and
 *       the dim region is NOT near-black — its rendered contrast is comparable to
 *       the bright region (both walls render at similar brightness). A GLOBAL
 *       (non-viewport) norm would leave the dim region near-black (thermal ≈ 0).
 *   (b) CROSSHAIR: a CDP mouse-move over the known wall cell makes the Crosshair
 *       DOM show the EXACT price (epoch row→price) and a nonzero size matching the
 *       injected wall (read from the CPU cache, never GPU/mip texels).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

/** Non-background luma threshold + the minimum bright-pixel count expected. */
const THERMAL_LUMA = 25;

interface CanvasStats {
  thermal: number;
  meanLuma: number;
  norm: number;
}

interface Scenario {
  rows: number;
  epoch: number;
  params: { epoch: number; tick: number; tick_multiple: number; dt_ns: number; p0: number; rows: number };
  dim: { colLo: number; colHi: number };
  bright: { colLo: number; colHi: number };
  dimWindow: { colLo: number; colHi: number };
  brightWindow: { colLo: number; colHi: number };
  centerRow: number;
  band: { lo: number; hi: number };
  wall: { col: number; row: number; bid: number; price: number };
  capacityCols: number;
}

test('§8.3 T9: viewport normalization renormalizes a dim region + crosshair reads exact size', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?normalize=1');
  await page.waitForFunction(
    () => !!(window as unknown as { __flowmapLive?: any }).__flowmapLive?.renderer,
    undefined,
    { timeout: 45_000 },
  );

  // Preload the two-region scenario + known wall; publish the epoch to the store
  // so the crosshair's row→price mapping is defined.
  const sc: Scenario = await page.evaluate(() => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    const s = live.renderer.preloadNormalizeScenario();
    live.store.setState({ epochs: new Map([[s.epoch, s.params]]), gridEpoch: s.epoch });
    (window as unknown as { __sc: unknown }).__sc = s;
    return s;
  });

  const frameWindow = (win: { colLo: number; colHi: number }): Promise<void> =>
    page.evaluate((w) => {
      const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
      const s = (window as unknown as { __sc: any }).__sc;
      live.renderer.setViewForTest(w.colLo, w.colHi - w.colLo + 1, s.band.lo, s.band.hi - s.band.lo);
    }, win);

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
      let lumaSum = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (luma > lumaThreshold) thermal++;
        lumaSum += luma;
        n++;
      }
      const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
      return { thermal, meanLuma: lumaSum / n, norm: live.renderer.currentNorm };
    }, THERMAL_LUMA);

  // --- (a) Renormalization: bright region, then pan into the dim region. --------
  await frameWindow(sc.brightWindow);
  await page.waitForTimeout(800); // let the EMA settle onto the bright regime
  const bright = await readStats();

  await frameWindow(sc.dimWindow);
  await page.waitForTimeout(800); // renormalize down to the dim regime
  const dim = await readStats();

  // Save the renormalized dim region as the report artifact.
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const shot = await page.locator('canvas#gl').screenshot();
  writeFileSync(join(ARTIFACT_DIR, 'normalize-dim.png'), shot);

  // The norm is VIEWPORT-adaptive: bright edge is far brighter than the dim
  // region, and panning renormalizes far downward (not stuck on the live edge).
  expect(bright.norm, `bright norm ${bright.norm.toFixed(1)}`).toBeGreaterThan(100);
  expect(dim.norm, `dim norm ${dim.norm.toFixed(1)}`).toBeLessThan(50);
  expect(bright.norm / dim.norm).toBeGreaterThan(5);

  // The dim region is NOT near-black (a global norm would leave it ≈ 0 thermal)
  // and its contrast is COMPARABLE to the bright region after renormalization.
  expect(dim.thermal, `dim thermal ${dim.thermal} (near-black would be ~0)`).toBeGreaterThan(3000);
  expect(dim.thermal).toBeGreaterThan(bright.thermal * 0.5);
  expect(dim.thermal).toBeLessThan(bright.thermal * 2);

  // --- (b) Crosshair: hover the known wall cell via a CDP mouse move. -----------
  const hover = await page.evaluate(() => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    const s = (window as unknown as { __sc: any }).__sc;
    // Frame a level-0 view around the known wall (col, row) so group === 1.
    live.renderer.setViewForTest(s.wall.col - 60, 120, s.wall.row - 60, 120);
    const px = live.renderer.cellToCanvasCss(s.wall.col, s.wall.row);
    const rect = (document.querySelector('canvas#gl') as HTMLCanvasElement).getBoundingClientRect();
    return { x: rect.left + px.x, y: rect.top + px.y };
  });

  await page.mouse.move(hover.x, hover.y);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="crosshair-price"]');
      return !!el && !!el.textContent && el.textContent !== '—';
    },
    undefined,
    { timeout: 5_000 },
  );

  const readout = await page.evaluate(() => {
    const q = (id: string): string | null =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    return {
      price: q('crosshair-price'),
      bid: q('crosshair-bid'),
      ask: q('crosshair-ask'),
      time: q('crosshair-time'),
      group: q('crosshair-group'),
    };
  });

  // Exact price from the epoch row→price mapping (tick 0.5 → 1 decimal).
  expect(readout.price).toBe(sc.wall.price.toFixed(1));
  // Exact injected wall size from the CPU cache — nonzero, matching the wall.
  expect(Number(readout.bid)).toBeGreaterThan(0);
  expect(Number(readout.bid)).toBeCloseTo(sc.wall.bid, 1);
  // Level-0 view → single cell, no grouping row shown.
  expect(readout.group).toBeNull();

  // Clean run — no console errors, no GL errors (checkGLError throws → pageerror).
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
