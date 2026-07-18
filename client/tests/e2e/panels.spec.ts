import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * T11 verification — the DOM ladder + time & sales tape panels (§9 right rail)
 * render live off the module-scoped bookStore, honestly badged (§7).
 *
 * The page opens with `?panels=1` (no live feed — so the sim stream does not fight
 * the injected data). The spec publishes a known epoch + L2/tick capability to the
 * store and injects a KNOWN DepthColumn + BBO + Trades straight into the bookStore
 * (bypassing the socket, the same path the live fan-out uses). It asserts:
 *   (a) the ladder shows price rungs whose bid/ask sizes match the injected book;
 *   (b) the best bid / best ask rungs are highlighted;
 *   (c) the tape lists the trades newest-first, colored by side (teal buy / red
 *       sell), with the honest `L2` / `TAPE TICK` badges;
 *   (d) collapsing each panel hides its body, and the rail toggle hides the rail;
 *   (e) no console / page errors.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

// Msg-type wire tags (proto/types MsgType) + mode/side constants.
const DEPTH = 3;
const TRADE = 5;
const BBO = 6;
const MODE_L2 = 0;
const SIDE_BUY = 0;
const SIDE_SELL = 1;

const TEAL = 'rgb(31, 182, 166)';
const RED = 'rgb(211, 82, 79)';

test('§9 T11: DOM ladder + tape render honestly off the bookStore', async ({ page }) => {
  test.setTimeout(120_000);

  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?panels=1');
  await page.waitForFunction(
    () => !!(window as unknown as { __flowmapLive?: any }).__flowmapLive?.bookStore,
    undefined,
    { timeout: 45_000 },
  );

  // Publish the epoch + capability, then inject a known book/bbo/trades.
  await page.evaluate((tags) => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    const params = { epoch: 1, tick: 0.5, tick_multiple: 1, dt_ns: 25_000_000, p0: 50, rows: 200 };
    live.store.setState({
      epochs: new Map([[1, params]]),
      gridEpoch: 1,
      capability: { depth: 'L2', tape: 'tick', trade_side: 'exchange' },
    });

    // Book: best bid at row 100 (px 100.0), best ask at row 101 (px 100.5).
    const bid = new Float32Array(params.rows);
    const ask = new Float32Array(params.rows);
    bid[98] = 3;
    bid[99] = 5;
    bid[100] = 8; // best bid (largest → full bar)
    ask[101] = 7; // best ask
    ask[102] = 4;
    ask[103] = 2;
    live.bookStore.ingestForTest({
      type: tags.DEPTH, epoch: 1, col_seq: 1, t0_ns: 25_000_000n,
      mode: tags.MODE_L2, final: true, bid, ask,
    });
    live.bookStore.ingestForTest({
      type: tags.BBO, ts_ns: 25_000_000n, bid_px: 100.0, bid_sz: 8, ask_px: 100.5, ask_sz: 7,
    });

    // Trades, oldest→newest: buy, sell, buy. Tape shows them newest-first.
    live.bookStore.ingestForTest({ type: tags.TRADE, ts_ns: 1_000_000n, price: 100.5, size: 2, side: tags.SIDE_BUY, side_src: 0, venue: 'sim' });
    live.bookStore.ingestForTest({ type: tags.TRADE, ts_ns: 2_000_000n, price: 100.0, size: 3, side: tags.SIDE_SELL, side_src: 0, venue: 'sim' });
    live.bookStore.ingestForTest({ type: tags.TRADE, ts_ns: 3_000_000n, price: 100.5, size: 5, side: tags.SIDE_BUY, side_src: 0, venue: 'sim' });
  }, { DEPTH, TRADE, BBO, MODE_L2, SIDE_BUY, SIDE_SELL });

  // Wait for the throttled (~10 Hz) flush to paint the injected book.
  await page.waitForFunction(() => !!document.querySelector('[data-row="100"]'), undefined, {
    timeout: 10_000,
  });

  // Save the rail as the report artifact.
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const shot = await page.locator('[data-testid="right-rail"]').screenshot();
  writeFileSync(join(ARTIFACT_DIR, 'panels.png'), shot);

  // (a) ladder rungs carry the injected bid/ask sizes at the right prices.
  const bidRow = page.locator('[data-row="100"]');
  const askRow = page.locator('[data-row="101"]');
  await expect(bidRow).toHaveAttribute('data-bid', '8.0000');
  await expect(bidRow).toHaveAttribute('data-price', '100.0');
  await expect(askRow).toHaveAttribute('data-ask', '7.0000');
  await expect(askRow).toHaveAttribute('data-price', '100.5');

  // (b) best bid / best ask rungs highlighted.
  await expect(bidRow).toHaveClass(/is-bestbid/);
  await expect(askRow).toHaveClass(/is-bestask/);

  // (c) badges are honest.
  await expect(page.locator('[data-testid="ladder-badge"]')).toHaveText('L2');
  await expect(page.locator('[data-testid="tape-badge"]')).toHaveText('TAPE TICK');

  // Tape: newest-first, colored by side.
  const rows = page.locator('[data-testid="tape-row"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-side', 'buy'); // newest (px 100.5, size 5)
  await expect(rows.nth(1)).toHaveAttribute('data-side', 'sell');
  await expect(rows.nth(2)).toHaveAttribute('data-side', 'buy');

  const buyColor = await rows.nth(0).locator('.tape__px').evaluate((el) => getComputedStyle(el).color);
  const sellColor = await rows.nth(1).locator('.tape__px').evaluate((el) => getComputedStyle(el).color);
  expect(buyColor).toBe(TEAL);
  expect(sellColor).toBe(RED);

  // (d) collapse each panel body, then hide the whole rail.
  await page.locator('[data-testid="ladder-collapse"]').click();
  await expect(page.locator('[data-testid="ladder-body"]')).toHaveCount(0);
  await page.locator('[data-testid="tape-collapse"]').click();
  await expect(page.locator('[data-testid="tape-body"]')).toHaveCount(0);

  await page.locator('[data-testid="rail-toggle"]').click();
  await expect(page.locator('[data-testid="right-rail"]')).toHaveCount(0);

  // (e) clean run.
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
