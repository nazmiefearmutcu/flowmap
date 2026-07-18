import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * M2 integration-gate fix — the heatmap renderer must RESET on a subscription
 * change (symbol / market switch). Before the fix the renderer had no
 * session-change detection: it kept the OLD symbol's tile ring and a camera fit
 * to the OLD price frame, so a switch left stale tiles on screen while the new
 * session's columns appended onto the old ring.
 *
 * Switching to live binance-spot here would need real network (flaky in CI), so
 * this drives the fix deterministically against the REAL sim feed: it lets the
 * live sim populate the ring, calls `renderer.resetForSession()` through the dev
 * hook, and asserts — via the same dev-hook accessors — that
 *
 *   (a) the reset EMPTIES the renderer atomically: residentRange() → null, the
 *       auto-follow cursor (newestColSeq) rewinds to -1, and the camera is back
 *       to a following default;
 *   (b) the live feed REPOPULATES a fresh ring afterwards (resident range grows
 *       again, the cursor advances) with the camera re-following the live edge —
 *       i.e. the ring rebuilt and the camera refit to the new data, not the old;
 *   (c) the heatmap renders real thermal pixels again after the refit;
 *   (d) no console errors and no GL errors across the switch.
 *
 * The actual price-axis rebase (sim 88–128 → live BTC ~60k) is proven by the
 * manual sim→binance→sim live run; here the sim data is unchanged, so the proof
 * is the ring clearing + the camera refitting, which is the renderer-lifecycle
 * bug that was fixed.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

const THERMAL_LUMA = 25;
const MIN_THERMAL_PIXELS = 200;

interface CanvasStats {
  thermal: number;
  width: number;
  height: number;
}

test('heatmap renderer resets its GL state + refits on a session switch', async ({ page }) => {
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/');

  // Wait for the live wiring: renderer up, connection `live`, a populated ring.
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      if (!live || !live.renderer) return false;
      const range = live.renderer.residentRange();
      return live.store.getState().status === 'live' && range !== null && range.count > 20;
    },
    undefined,
    { timeout: 45_000 },
  );

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
      for (let i = 0; i < d.length; i += 4) {
        const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (luma > lumaThreshold) thermal++;
      }
      return { thermal, width: off.width, height: off.height };
    }, THERMAL_LUMA);

  // The heatmap is populated + rendering before the switch.
  const statsBefore = await readStats();
  expect(statsBefore.width).toBeGreaterThan(0);
  expect(statsBefore.thermal).toBeGreaterThan(MIN_THERMAL_PIXELS);

  // Capture the pre-reset state AND call resetForSession() in ONE evaluate so the
  // emptied ring is observed atomically (no live column can slip in between —
  // page JS is single-threaded, the reset runs before any stream handler).
  const reset = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    const beforeRange = r.residentRange();
    const beforeSeq = r.newestColSeq;
    r.resetForSession();
    const afterRange = r.residentRange();
    return {
      beforeCount: beforeRange ? beforeRange.count : 0,
      beforeSeq,
      afterRangeNull: afterRange === null,
      afterSeq: r.newestColSeq,
      afterFollowing: r.following,
    };
  });

  // (a) reset EMPTIED the renderer atomically.
  expect(reset.beforeCount).toBeGreaterThan(20);
  expect(reset.beforeSeq).toBeGreaterThan(20);
  expect(reset.afterRangeNull, 'residentRange() must be null right after reset').toBe(true);
  expect(reset.afterSeq, 'auto-follow cursor must rewind to -1').toBe(-1);
  expect(reset.afterFollowing, 'camera must be following after reset').toBe(true);

  // (b) the live feed rebuilds a fresh ring and the camera re-follows the edge.
  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
      const range = r.residentRange();
      return range !== null && range.count > 8 && r.newestColSeq >= 0 && r.following;
    },
    undefined,
    { timeout: 20_000 },
  );

  // Give the refit a moment of live streaming, then confirm it keeps advancing.
  const repop1 = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    return { count: r.residentRange().count, seq: r.newestColSeq };
  });
  await page.waitForTimeout(1000);
  const repop2 = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    return { count: r.residentRange().count, seq: r.newestColSeq };
  });
  expect(repop2.seq, `col_seq must advance after reset (was ${repop1.seq}, now ${repop2.seq})`).toBeGreaterThan(
    repop1.seq,
  );

  // (c) the heatmap renders real thermal pixels again after the refit.
  const statsAfter = await readStats();
  expect(
    statsAfter.thermal,
    'heatmap must render thermal pixels again after the session reset',
  ).toBeGreaterThan(MIN_THERMAL_PIXELS);

  // Save the post-reset canvas as the report artifact.
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const shotPath = join(ARTIFACT_DIR, 'session-switch.png');
  writeFileSync(shotPath, await page.locator('canvas#gl').screenshot());

  // (d) clean run — no console errors, no GL errors across the switch.
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
