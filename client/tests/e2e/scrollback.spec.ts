import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * T8 verification — deep scroll-back: LRU full-res residency + HistoryRequest
 * backfill + WebGL context-loss recovery, end-to-end against the REAL server.
 *
 * The page opens with `?scrollback=1&budget=512`: a SMALL full-res residency
 * budget (512 columns) so the live sim (driven fast by the webServer's
 * FLOWMAP_DT_CRYPTO_NS override) overruns it in seconds. Once the ring has
 * wrapped, older columns are no longer resident full-res but ARE still on the
 * server. The spec then:
 *
 *   (A) pans LEFT into that evicted history and asserts a `HistoryRequest` fires,
 *       the backfilled columns become resident at their true absolute col_seq,
 *       the resident window stays within budget, and OLDER DATA RENDERS
 *       (thermal pixels appear in a viewport that is entirely below the old
 *       resident window);
 *   (B) zooms time out to the whole ring and asserts NO further backfill fires
 *       (deep zoom-out shows the whole extent — it must not re-populate it
 *       full-res);
 *   (C) forces a WebGL context loss (WEBGL_lose_context) and asserts the
 *       renderer recreates its GL objects and renders again, with no permanent
 *       GL error.
 *
 * The §10 perf gate is unaffected: the per-frame "ensure visible populated"
 * check is O(1) (visible-left vs resident-oldest), not O(history).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

const BUDGET = 512;
/** Wait until the live edge is this far past the budget so there is a deep,
 *  fully-evicted history to scroll back into. */
const OVERRUN_TARGET = BUDGET * 2 + 128; // ~1152 cols → ~29 s at 40 cols/s
const THERMAL_LUMA = 25;
const MIN_THERMAL_PIXELS = 150;

interface CanvasStats {
  thermal: number;
  checksum: number;
}

test('deep scroll-back: LRU residency + history backfill + context-loss recovery', async ({
  page,
}) => {
  test.setTimeout(150_000);

  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`/?scrollback=1&budget=${BUDGET}`);

  // Wait for live wiring AND for the live edge to overrun the budget by a wide
  // margin (so there is a large evicted history below the resident window).
  await page.waitForFunction(
    (overrun) => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      if (!live || !live.renderer) return false;
      const r = live.renderer;
      const range = r.residentRange();
      return (
        live.store.getState().status === 'live' &&
        range !== null &&
        r.newestColSeq > overrun &&
        r.residentBudgetCols === 512
      );
    },
    OVERRUN_TARGET,
    { timeout: 120_000 },
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
      let checksum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (luma > lumaThreshold) thermal++;
        checksum = (checksum + ((i % 1009) + 1) * (d[i] + d[i + 1] + d[i + 2])) >>> 0;
      }
      return { thermal, checksum };
    }, THERMAL_LUMA);

  // --- Baseline: following the live edge, within budget, no backfill yet. -----
  const baseline = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    return {
      budget: r.residentBudgetCols,
      range: r.residentRange(),
      newest: r.newestColSeq,
      history: r.historyStats(),
      following: r.following,
    };
  });
  expect(baseline.budget).toBe(BUDGET);
  expect(baseline.range.count, 'resident window within budget').toBeLessThanOrEqual(BUDGET);
  expect(baseline.range.oldest, 'older columns must have been evicted').toBeGreaterThan(0);
  expect(baseline.history.requestCount, 'no backfill while following live').toBe(0);

  // --- (A) Pan LEFT into the evicted history → backfill must fire. ------------
  const panInfo = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    const oldest = r.residentRange().oldest;
    // Zoom time in so a mid-history window fits comfortably below `oldest`.
    let guard = 0;
    while (r.viewSnapshot.colScale > oldest * 0.4 && guard++ < 30) r.zoomTimeForTest(0.6);
    const view = r.viewSnapshot;
    const span = view.colScale;
    // Target the middle of the evicted region (> 0 and < oldest, full viewport
    // below the old resident window).
    const targetCenter = Math.max(Math.ceil(span), Math.floor(oldest * 0.5));
    const currentCenter = view.colOffset + span / 2;
    r.panColumnsForTest(targetCenter - currentCenter);
    return { oldest, span, targetCenter, level: r.currentMipLevel };
  });
  // A resolvable (level < 2) view of a region below the old resident window.
  expect(panInfo.level, 'panned view must be full-res resolvable (level < 2)').toBeLessThan(2);
  expect(panInfo.targetCenter).toBeLessThan(panInfo.oldest);

  // Wait for the backfill: a request fired AND the target column is now resident.
  await page.waitForFunction(
    (target) => {
      const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
      const h = r.historyStats();
      return h.requestCount > 0 && r.isResidentFullRes(target);
    },
    panInfo.targetCenter,
    { timeout: 30_000 },
  );

  const afterBackfill = await page.evaluate((target) => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    return {
      history: r.historyStats(),
      range: r.residentRange(),
      targetResident: r.isResidentFullRes(target),
      newest: r.newestColSeq,
    };
  }, panInfo.targetCenter);

  // A HistoryRequest fired and the backfilled column landed at its true col_seq.
  expect(afterBackfill.history.requestCount, 'HistoryRequest must fire on scroll-back').toBeGreaterThan(0);
  expect(afterBackfill.targetResident, 'backfilled column resident full-res').toBe(true);
  // The resident window slid backward but stayed within the full-res budget.
  expect(afterBackfill.range.count, 'residency stays within budget').toBeLessThanOrEqual(BUDGET);
  expect(
    afterBackfill.range.oldest,
    'window slid back below the original oldest',
  ).toBeLessThan(baseline.range.oldest);

  // Older data actually renders: the viewport (entirely below the old resident
  // window) now shows thermal liquidity, not a blank canvas.
  const olderStats = await readStats();
  expect(
    olderStats.thermal,
    `older data must render after backfill (thermal px ${olderStats.thermal})`,
  ).toBeGreaterThan(MIN_THERMAL_PIXELS);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const shot = await page.locator('canvas#gl').screenshot();
  writeFileSync(join(ARTIFACT_DIR, 'scrollback.png'), shot);

  // --- (B) Deep zoom-out (whole ring on screen) must NOT backfill. ------------
  const reqBeforeZoom = afterBackfill.history.requestCount;
  const zoomState = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    // Zoom time out to the whole ring, then pan hard left.
    let guard = 0;
    while (r.viewSnapshot.colScale < r.residentBudgetCols && guard++ < 40) r.zoomTimeForTest(1.6);
    r.panColumnsForTest(-r.residentBudgetCols);
    return { span: r.viewSnapshot.colScale, budget: r.residentBudgetCols };
  });
  expect(zoomState.span, 'time-zoomed out to the whole ring').toBeGreaterThanOrEqual(
    zoomState.budget,
  );
  // Give a few frames for any (suppressed) backfill to (not) fire.
  await page.waitForTimeout(1000);
  const reqAfterZoom = await page.evaluate(
    () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.historyStats().requestCount,
  );
  expect(
    reqAfterZoom,
    'deep zoom-out must not trigger full-res backfill of the whole extent',
  ).toBe(reqBeforeZoom);

  // --- (C) WebGL context loss → recover and render again. ---------------------
  const restoredBefore = await page.evaluate(
    () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.contextRestoredCount,
  );
  const lost = await page.evaluate(
    () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.loseContextForTest(),
  );
  expect(lost, 'WEBGL_lose_context extension available under SwiftShader').toBe(true);

  await page.waitForFunction(
    () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.contextLostCount > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate(
    () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.restoreContextForTest(),
  );
  await page.waitForFunction(
    (before) =>
      (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.contextRestoredCount >
      before,
    restoredBefore,
    { timeout: 15_000 },
  );

  // After restore the ring is empty; the live feed (still flowing) re-populates
  // it. Wait for thermal pixels to return — proof the renderer recovered.
  await page.waitForFunction(
    (min) => {
      const c = document.querySelector('canvas#gl') as HTMLCanvasElement;
      const off = document.createElement('canvas');
      off.width = c.width;
      off.height = c.height;
      const ctx = off.getContext('2d')!;
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, off.width, off.height).data;
      let thermal = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 25) thermal++;
      }
      return thermal > min;
    },
    MIN_THERMAL_PIXELS,
    { timeout: 20_000 },
  );

  const recovered = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    return { restored: r.contextRestoredCount, drawCount: r.drawCount };
  });
  expect(recovered.restored, 'context was restored').toBeGreaterThan(restoredBefore);
  expect(recovered.drawCount, 'renderer drew frames after restore').toBeGreaterThan(0);

  // --- Clean run: no console/page errors, no permanent GL error. --------------
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
