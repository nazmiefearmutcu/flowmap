import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * M3 T3 verification — SYNTH-profile equity rendering + honesty (§7 / §7.1),
 * driven through the REAL renderer + bookStore on software GL (headless).
 *
 * The page opens with `?panels=1` (no live feed — the sim stream does not fight
 * the injected data). The spec publishes the keyless-equity capability
 * ({depth:'SYNTH_PROFILE', tape:'poll', trade_side:'na', vwap:'approx'}) + an
 * equity epoch to the store, feeds a cumulative volume-at-price SYNTH_PROFILE
 * book (mode==2, ask=null) into BOTH the renderer (heatmap) and the bookStore
 * (DOM ladder), and drives a terminal closed Status. It asserts:
 *   (a) the heatmap renders the SYNTH amber ramp (RAMP_SYNTH), NOT thermal, and
 *       an amber pixel lands at the profile's point-of-control;
 *   (b) the DOM ladder shows the SYNTH volume-at-price tier — badge `SYNTH`,
 *       profile rungs, and NO bid/ask size columns (no fabricated two-sided book);
 *   (c) the tape badge reads `TAPE POLL`;
 *   (d) the BBO overlay draws NOTHING fabricated (effective BBO is null — keyless
 *       equity is neither a channel BBO nor L2);
 *   (e) the closed-market banner + next-open countdown render;
 *   (f) no console / page / GL errors.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

// Msg-type wire tags (proto/types MsgType) + SYNTH_PROFILE mode.
const DEPTH = 3;
const MODE_SYNTH_PROFILE = 2;
const RAMP_SYNTH = 1;

test('§7 M3 T3: SYNTH-profile equity renders honestly (amber ramp, SYNTH ladder, closed banner)', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?panels=1');
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      return !!(live?.renderer && live?.bookStore);
    },
    undefined,
    { timeout: 45_000 },
  );

  // Publish the keyless-equity capability + epoch, feed a SYNTH_PROFILE book into
  // the renderer + bookStore, and drive a closed Status (opens ~90 s out).
  const poc = await page.evaluate((tags) => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    const r = live.renderer;

    // Equity SYNTH grid: cent tick, re-anchored near AAPL's real price (~$180).
    const rows = 256;
    const tick = 0.01;
    const p0 = 178.72; // center row (128) ≈ $180.00
    const epoch = 4;
    const params = { epoch, tick, tick_multiple: 1, dt_ns: 10_000_000_000, p0, rows };
    live.store.setState({
      epochs: new Map([[epoch, params]]),
      gridEpoch: epoch,
      normSeed: 8,
      capability: {
        depth: 'SYNTH_PROFILE',
        tape: 'poll',
        trade_side: 'na',
        vwap: 'approx',
        markers: ['gap', 'session_break'],
      },
    });

    // Cumulative volume-at-price: a bid-only density (ask EMPTY), peak (POC) at
    // the center row. Feed several finalized columns so the ring + follow frame
    // populate exactly as live.
    const pocRow = 128;
    const mkBid = (): Float32Array => {
      const bid = new Float32Array(rows);
      for (let r = 0; r < rows; r += 1) {
        const d = Math.abs(r - pocRow);
        if (d <= 18) bid[r] = 40 * (1 - d / 20) + (d === 0 ? 30 : 0);
      }
      return bid;
    };
    const total = 10;
    for (let s = 0; s < total; s += 1) {
      const col = {
        type: tags.DEPTH,
        epoch,
        col_seq: s,
        t0_ns: BigInt(s) * BigInt(params.dt_ns),
        mode: tags.MODE_SYNTH_PROFILE,
        final: true,
        bid: mkBid(),
        ask: null,
      };
      r.ingestForTest(col); // heatmap (real onDepthColumn path)
      live.bookStore.ingestForTest(col); // DOM ladder
    }

    // Terminal closed Status (spec §7.1): last-session warmup profile stays, feed
    // is closed, next open ~90 s out so the countdown is visible.
    const nextOpenMs = Date.now() + 90_000;
    live.store.setState({
      feedState: 'closed',
      nextOpenTs: BigInt(nextOpenMs) * 1_000_000n,
    });

    const pocCss = r.cellToCanvasCss(total - 1, pocRow);
    return { pocRow, pocCss, ramp: r.currentRamp, effBbo: r.overlayEffectiveBboForTest() };
  }, { DEPTH, MODE_SYNTH_PROFILE });

  // (a) The renderer selected the SYNTH ramp, not thermal.
  expect(poc.ramp, 'heatmap ramp is RAMP_SYNTH (amber)').toBe(RAMP_SYNTH);
  // (d) The BBO overlay would draw nothing fabricated for keyless equity.
  expect(poc.effBbo, 'BBO overlay draws no fabricated quote').toBeNull();

  // Let a couple of dirty frames paint the amber profile.
  await page.waitForTimeout(300);

  // Wait for the throttled (~10 Hz) bookStore flush to paint the ladder.
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="ladder-row"]'),
    undefined,
    { timeout: 10_000 },
  );

  // Save the workspace as the report artifact.
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(join(ARTIFACT_DIR, 'equity.png'), await page.screenshot());

  // (a) An amber pixel sits at the profile's POC (r >> b, warm single hue) — the
  // SYNTH ramp actually rendered, distinct from the thermal (cyan/white) look.
  const amber = await page.evaluate((p) => {
    const c = document.querySelector('canvas#gl') as HTMLCanvasElement;
    const dpr = c.width / Math.max(1, c.clientWidth);
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    const img = ctx.getImageData(0, 0, off.width, off.height).data;
    const cx = Math.round(p.pocCss.x * dpr);
    const cy = Math.round(p.pocCss.y * dpr);
    const rad = Math.round(10 * dpr);
    let n = 0;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || py < 0 || px >= off.width || py >= off.height) continue;
        const i = (py * off.width + px) * 4;
        const rr = img[i];
        const gg = img[i + 1];
        const bb = img[i + 2];
        // Amber: red-dominant, blue-starved, green below red (never cyan/white).
        if (rr > 110 && rr > bb + 55 && gg < rr) n++;
      }
    }
    return n;
  }, poc);
  expect(amber, 'SYNTH amber pixels at the profile POC').toBeGreaterThan(4);

  // (b) DOM ladder: SYNTH tier badge + profile rungs, NO bid/ask size columns.
  await expect(page.locator('[data-testid="ladder-badge"]')).toHaveText('SYNTH');
  expect(await page.locator('.ladder__profile').count(), 'profile rungs render').toBeGreaterThan(0);
  expect(
    await page.locator('.ladder__cell--bid').count(),
    'no fabricated bid column',
  ).toBe(0);
  expect(
    await page.locator('.ladder__cell--ask').count(),
    'no fabricated ask column',
  ).toBe(0);

  // (c) Tape badge is honest: display-only poll, not a tick tape.
  await expect(page.locator('[data-testid="tape-badge"]')).toHaveText('TAPE POLL');

  // (e) Closed-market banner + next-open countdown.
  await expect(page.locator('[data-testid="closed-banner"]')).toBeVisible();
  await expect(page.locator('[data-testid="closed-banner"]')).toContainText('MARKET CLOSED');
  await expect(page.locator('[data-testid="closed-countdown"]')).toContainText(/opens in \d{2}:\d{2}:\d{2}/);

  // (f) Clean run — no console/page errors, no GL errors.
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
