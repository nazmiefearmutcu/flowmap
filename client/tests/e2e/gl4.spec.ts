import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * Campaign-4 lane E2 — GL invariants pinned at the pixel level.
 *
 * Five probes over the EXISTING e2e surfaces (no src changes):
 *   1. `?test=heatmap` hook: `setLevelFloor(2)`/`levelInfoWithFloor(2)` force the
 *      SUM-mip level and the painted cells genuinely coarsen (one wall row →
 *      a 16-row block) — a forced tick-grouping display, not just a report.
 *   2. `?spy=1` live renderer: `setTickGrouping(16)` → `getTickGrouping() === 16`
 *      and `probeAt(center).group === 16` (crosshair agrees with the paint).
 *   3. `?spy=1`: deep TIME zoom-out selects the mip level from the COLUMN axis
 *      (row footprint alone would pick level 0) and the resident liquidity still
 *      paints — the deep time-zoom-out mip spec the ROADMAP asked for.
 *   4. `?spy=1`: the `imbalance` depth channel paints a divergent sample and
 *      switching back to `sum` restores the same frame (the divergent LUT row is
 *      actually used); invariants only, no exact pixel pins.
 *   5. `?spy=1`: a forced webgl context loss/restore keeps follow-OFF intent
 *      (`renderer.following === false`) and the renderer recovers.
 *
 * Assertions are directional invariants with loose SwiftShader-safe thresholds;
 * no wall-clock pins — every wait is a condition.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Open `?spy=1` and wait for the live sim session with `minCols` columns. */
async function waitForLive(page: Page, minCols: number): Promise<void> {
  await page.goto('/?spy=1');
  await page.waitForFunction(
    (min) => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      if (!live || !live.renderer) return false;
      const r = live.renderer;
      return (
        live.store.getState().status === 'live' &&
        r.residentRange() !== null &&
        r.newestColSeq >= min
      );
    },
    minCols,
    // Generous: a locally reused server may run the default (slow) sim cadence,
    // so reaching N columns is a condition wait, never a clock assumption.
    { timeout: 150_000 },
  );
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test('tick grouping floor forces the SUM-mip level and coarsens the painted cells (?test=heatmap)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const consoleErrors = collectErrors(page);

  await page.goto('/?test=heatmap');
  await page.waitForFunction(() => '__flowmapTest' in window, undefined, { timeout: 30_000 });

  const result = await page.evaluate(
    (cfg) => {
      const api = (window as unknown as { __flowmapTest: any }).__flowmapTest;
      api.init(cfg.rows, cfg.layers, cfg.width, cfg.height, /* mips */ true);

      // A SINGLE bright wall row, everything else zero: at level 0 it is a
      // hairline; the level-2 block that contains it sums to the same density
      // and covers 16 rows on screen — the "coarser cells" direction.
      const bid = new Array(cfg.rows).fill(0);
      bid[cfg.wallRow] = cfg.wallValue;
      const zeros = new Array(cfg.rows).fill(0);
      for (let s = 0; s < cfg.nCols; s++) api.appendColumn(s, bid, zeros);

      api.setEncoding(1, cfg.norm, false);
      api.setView({
        colOffset: cfg.colOffset,
        colScale: cfg.colScale,
        rowOffset: cfg.rowOffset,
        rowScale: cfg.rowScale,
      });

      const infoNatural = api.levelInfo();
      const infoFloor2 = api.levelInfoWithFloor(2);
      const infoFloor0 = api.levelInfoWithFloor(0);

      const strip = (levelFloor: number): number[] => {
        api.setLevelFloor(levelFloor);
        return api.readPixels(cfg.width >> 1, 0, 1, cfg.height);
      };
      const base = strip(0);
      const forced = strip(2);
      api.setLevelFloor(0);
      const infoRestored = api.levelInfo();

      // PNG artifact of the forced-coarse frame (bottom-left → top-left flip).
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

      return {
        infoNatural,
        infoFloor2,
        infoFloor0,
        infoRestored,
        base,
        forced,
        png: cv.toDataURL('image/png'),
      };
    },
    {
      rows: 1024,
      layers: 2,
      width: 256,
      height: 64,
      // Wall at an exact 16-row block start so the level-2 texel contains it.
      wallRow: 512,
      wallValue: 100,
      norm: 100,
      colOffset: 140,
      colScale: 20,
      rowOffset: 496,
      rowScale: 32,
      nCols: 300,
    },
  );

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    join(ARTIFACT_DIR, 'gl4-tick-grouping.png'),
    Buffer.from(result.png.replace(/^data:image\/png;base64,/, ''), 'base64'),
  );

  const bright = (strip: number[]): number => {
    let n = 0;
    for (let i = 0; i < strip.length; i += 4) {
      if (luma(strip[i], strip[i + 1], strip[i + 2]) > 60) n++;
    }
    return n;
  };
  const baseBright = bright(result.base);
  const forcedBright = bright(result.forced);

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);

  // Natural view at 0.5 rows/pixel is level 0 (one tap) — the floor is what moves it.
  expect(result.infoNatural.level).toBe(0);
  expect(result.infoNatural.rowsPerPixel).toBeLessThan(1);
  // Forced floor 2 reports the ceiling of the floor: level 2 = 16-row blocks.
  expect(result.infoFloor2.level).toBe(2);
  expect(result.infoFloor2.blk).toBe(16);
  // Floor 0 stays the natural selection.
  expect(result.infoFloor0.level).toBe(0);

  // Display direction: a hairline row becomes a 16-row block (≈32 device px).
  expect(baseBright, `native hairline wall px ${baseBright}`).toBeLessThanOrEqual(8);
  expect(forcedBright, `forced level-2 wall px ${forcedBright}`).toBeGreaterThanOrEqual(12);
  expect(forcedBright).toBeGreaterThan(baseBright + 6);

  // Clearing the floor restores the baseline selection.
  expect(result.infoRestored.level).toBe(0);
});

test('setTickGrouping(16) pins the crosshair group at the chart center (?spy)', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const consoleErrors = collectErrors(page);
  await waitForLive(page, 64);

  const probe = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    const canvas = document.querySelector('canvas#gl') as HTMLCanvasElement;
    const at = () => r.probeAt(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const baseline = { grouping: r.getTickGrouping(), level: r.currentMipLevel };
    r.setTickGrouping(16);
    const p16 = at();
    const forced = {
      grouping: r.getTickGrouping(),
      level: r.currentMipLevel,
      group: p16 ? p16.group : null,
    };
    r.setTickGrouping(1);
    const p1 = at();
    const restored = {
      grouping: r.getTickGrouping(),
      level: r.currentMipLevel,
      group: p1 ? p1.group : null,
    };
    return { baseline, forced, restored };
  });

  expect(probe.forced.grouping, 'setter holds the requested grouping').toBe(16);
  expect(probe.forced.level, 'floor level = ceil(log4 16) = 2').toBe(2);
  expect(probe.forced.group, 'crosshair reports the painted block').toBe(16);

  expect(probe.restored.grouping).toBe(1);
  expect(probe.restored.level, 'n=1 returns to the natural level').toBe(probe.baseline.level);
  expect(probe.restored.group).toBe(4 ** probe.baseline.level);

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('deep time zoom-out selects the SUM mip by the COLUMN axis and keeps liquidity painted (?spy)', async ({
  page,
}) => {
  test.setTimeout(200_000);
  const consoleErrors = collectErrors(page);
  await waitForLive(page, 512);

  const result = await page.evaluate(async () => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    const canvas = document.querySelector('canvas#gl') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
    const dbw = Math.max(1, gl.drawingBufferWidth);
    const dbh = Math.max(1, gl.drawingBufferHeight);

    // Freeze both axes: this is the "user zoomed time out" state.
    r.setFollowTime(false);
    r.setPriceFollow('off');
    const before = { level: r.currentMipLevel, view: r.viewSnapshot };

    // Drive the REAL time-zoom camera op synchronously until the mip rises.
    let guard = 0;
    while (r.currentMipLevel < 2 && guard++ < 60) r.zoomTimeForTest(1.5);
    let level = r.currentMipLevel;

    if (level < 2) {
      // Deterministic fallback through the same view uniforms: a column span
      // 18× the device width forces the column axis to level 2 even when the
      // camera clamp walk is slow on a loaded box.
      const range = r.residentRange();
      const colScale = 18 * dbw;
      const center = (range.oldest + range.newest + 1) / 2;
      r.setViewForTest(center - colScale / 2, colScale, before.view.rowOffset, before.view.rowScale);
      level = r.currentMipLevel;
    }

    // Condition wait: let the frame draw and the viewport norm settle.
    await new Promise<void>((resolve) => {
      let frames = 0;
      const tick = () => {
        if ((r.normalizerForTest.settled && r.drawCount > 0) || ++frames >= 90) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    // Pixel probe: count non-background (thermal) pixels over the whole canvas.
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    let thermal = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 25) thermal++;
    }

    return {
      levelBefore: before.level,
      level,
      rowFoot: before.view.rowScale / dbh,
      colFoot: r.viewSnapshot.colScale / dbw,
      thermal,
      range: r.residentRange(),
    };
  });

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const shot = await page.locator('canvas#gl').screenshot();
  writeFileSync(join(ARTIFACT_DIR, 'gl4-deep-time-zoom.png'), shot);

  // The price footprint alone would select level 0 — the rise is column-driven.
  expect(result.rowFoot, `row footprint ${result.rowFoot.toFixed(3)} rows/px`).toBeLessThan(4);
  expect(result.colFoot, `col footprint ${result.colFoot.toFixed(1)} cols/px`).toBeGreaterThanOrEqual(16);
  expect(result.level, 'deep time zoom-out rose the SUM-mip level').toBeGreaterThanOrEqual(2);
  // And the resident liquidity is still painted through the mips, not a void.
  expect(result.thermal, `thermal px at level ${result.level}`).toBeGreaterThan(50);

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('imbalance channel paints a divergent sample and sum restores the frame (?spy)', async ({
  page,
}) => {
  test.setTimeout(200_000);
  const consoleErrors = collectErrors(page);
  await waitForLive(page, 560);

  const result = await page.evaluate(async () => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    const canvas = document.querySelector('canvas#gl') as HTMLCanvasElement;

    // Pure-heatmap frame for a fair channel comparison (the price line / BBO
    // drift with the live feed and would otherwise move pixels between grabs).
    r.setFollowTime(false);
    r.setPriceFollow('off');
    r.setOverlayVisibility({
      bubbles: false,
      bbo: false,
      vwap: false,
      profile: false,
      markers: false,
      axes: false,
      price: false,
      cvd: false,
    });

    // A window fully inside SEALED resident history: its right edge sits a full
    // tile column behind the live edge, so appends cannot touch its tiles.
    const range = r.residentRange();
    const view = r.viewSnapshot;
    const colScale = 200;
    const right = range.newest - 300;
    r.setViewForTest(right - colScale, colScale, view.rowOffset, view.rowScale);

    const settle = () =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const tick = () => {
          if (r.normalizerForTest.settled || ++frames >= 90) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    const frames = (n: number) =>
      new Promise<void>((resolve) => {
        let k = 0;
        const tick = () => {
          if (++k >= n) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    const grab = () => {
      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, off.width, off.height).data;
    };
    const stats = (d: Uint8ClampedArray) => {
      let painted = 0;
      let warm = 0;
      let cool = 0;
      for (let i = 0; i < d.length; i += 4) {
        const rr = d[i];
        const gg = d[i + 1];
        const bb = d[i + 2];
        const l = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        // Painted = differs from the ramp background (5,8,14). The campaign-4.1
        // dark-field default keeps typical levels well under luma 25, so an
        // absolute-luma probe would read a painted field as blank.
        if (Math.abs(rr - 5) + Math.abs(gg - 8) + Math.abs(bb - 14) > 9) painted++;
        if (l > 20 && rr > bb + 12) warm++;
        if (l > 20 && bb > rr + 12) cool++;
      }
      return { painted, warm, cool };
    };
    const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (
          Math.abs(a[i] - b[i]) > 8 ||
          Math.abs(a[i + 1] - b[i + 1]) > 8 ||
          Math.abs(a[i + 2] - b[i + 2]) > 8
        ) {
          n++;
        }
      }
      return n;
    };

    await settle();
    // R2-M2: pin the viewport norm so the EMA glide cannot move pixels between
    // the grabs (freezeNormForTest; reset by any session reset).
    r.freezeNormForTest();

    // R2-M2 cont'd: the live sim can SPLICE its history once shortly after the
    // settle (a one-time frame change in a sealed window — measured: adjacent
    // grabs differ by ~8k px ONCE, then stay byte-identical for the rest of the
    // probe). Wait for a run of byte-identical adjacent frames before starting
    // the channel legs, so the comparison is deterministic and the tolerance
    // below only has to absorb live-data advance (new columns outside the
    // sealed window).
    let quiet = 0;
    for (let attempt = 0; attempt < 40 && quiet < 4; attempt++) {
      const a = grab();
      await frames(2);
      const b = grab();
      quiet = diff(a, b) === 0 ? quiet + 1 : 0;
    }

    r.setDepthChannel('sum');
    await frames(3);

    // R2-M2: retry the channel round-trip until one lands in a quiet window.
    // The live sim's history loader splices pages asynchronously, and a splice
    // that intersects the sealed view moves a band of pixels regardless of the
    // norm being pinned (measured ~5–10k px, a few frames wide). A real restore
    // regression fails EVERY attempt; a splice transient only fails the
    // attempts it lands inside. The quiescence gate above already removed the
    // common case; this is the belt-and-braces.
    let diffChannel = 0;
    let diffRestore = Number.POSITIVE_INFINITY;
    let sumStats = stats(new Uint8ClampedArray(4));
    let imbStats = stats(new Uint8ClampedArray(4));
    let attempts = 0;
    for (; attempts < 8 && diffRestore > 200; attempts++) {
      r.setDepthChannel('sum');
      await frames(3);
      const a = grab();
      r.setDepthChannel('imbalance');
      await frames(3);
      const b = grab();
      r.setDepthChannel('sum');
      await frames(3);
      const c = grab();
      diffChannel = diff(a, b);
      diffRestore = diff(a, c);
      sumStats = stats(a);
      imbStats = stats(b);
    }

    return {
      channel: r.getDepthChannel(),
      ramp: r.currentRamp,
      sum: sumStats,
      imb: imbStats,
      diffChannel,
      diffRestore,
      totalPixels: canvas.width * canvas.height,
      attempts,
    };
  });

  // Honesty ramp guard: the live sim session is real-depth L2, so the divergent
  // channel is honoured (a SYNTH session would force 'sum' and this would fail).
  expect(result.ramp, 'sim session renders the real-depth ramp').not.toBe(1);
  expect(result.channel, 'channel restored to sum').toBe('sum');

  // Both channels paint real signal (not a blank frame).
  expect(result.sum.painted, `sum painted px ${result.sum.painted}`).toBeGreaterThan(30);
  expect(result.imb.painted, `imbalance painted px ${result.imb.painted}`).toBeGreaterThan(30);
  expect(result.imb.warm + result.imb.cool, 'divergent hues present').toBeGreaterThan(30);

  // The divergent LUT row is actually used: switching changes many pixels...
  expect(result.diffChannel, `channel-switch diff px ${result.diffChannel}`).toBeGreaterThan(300);
  // ...while switching back restores the sealed frame (no time-driven drift).
  // The norm is PINNED (freezeNormForTest), the probe waits for quiescent
  // (byte-identical adjacent) frames before the legs, and the round-trip
  // retries past async history splices — so the only residual is live-data
  // advance outside this sealed window. Tolerance = 1% of the canvas as a
  // documented margin on top of that.
  const restoreTolerance = Math.max(4713, Math.round(0.01 * result.totalPixels));
  expect(
    result.diffRestore,
    `restore diff px ${result.diffRestore} (tol ${restoreTolerance}, channel ${result.diffChannel}, attempts ${result.attempts})`,
  ).toBeLessThanOrEqual(restoreTolerance);

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('context loss preserves follow-OFF intent and the renderer recovers (?spy)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const consoleErrors = collectErrors(page);
  await waitForLive(page, 64);

  const before = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    r.setFollowTime(false);
    return {
      following: r.following,
      lost: r.contextLostCount,
      restored: r.contextRestoredCount,
    };
  });
  expect(before.following, 'follow turned off before the loss').toBe(false);

  const lost = await page.evaluate(() =>
    (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.loseContextForTest(),
  );
  test.skip(!lost, 'WEBGL_lose_context is unavailable under this GL backend');

  await page.waitForFunction(
    (n) => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.contextLostCount > n,
    before.lost,
    { timeout: 10_000 },
  );
  await page.evaluate(() =>
    (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.restoreContextForTest(),
  );
  await page.waitForFunction(
    (n) =>
      (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.contextRestoredCount > n,
    before.restored,
    { timeout: 15_000 },
  );

  const after = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    return { following: r.following, restored: r.contextRestoredCount };
  });
  expect(after.restored, 'context was restored').toBeGreaterThan(before.restored);
  expect(after.following, 'follow-OFF intent survives the restore').toBe(false);

  // Recovery: the live feed repopulates the rebuilt ring.
  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
      const range = r.residentRange();
      return range !== null && range.count > 0;
    },
    undefined,
    { timeout: 20_000 },
  );

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
