import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * M3 T4 — the two-market feature-parity matrix (the §G3 gate).
 *
 * A machine-checkable assertion of design-spec §7's two-market table: EVERY
 * feature is driven through the SAME market-agnostic renderer + UI shell for a
 * crypto-shaped session (L2 · tick · exchange) AND an equity-keyless-shaped
 * session (SYNTH_PROFILE · poll · na), and each cell is asserted to hold the
 * SPECIFIED state — full / badged-reduced / explicit N/A. The point is HONEST
 * parity, not identical fidelity: equities never fabricate L2 they cannot source.
 *
 * Both markets are injected through the dev hooks (`window.__flowmapLive`) with
 * `?panels=1` (full UI mounts; the sim feed is suppressed so it does not fight the
 * injected data). Per §7:
 *
 *   feature      crypto (L2/tick)            equity keyless (SYNTH/poll)
 *   heatmap      RAMP_INFERNO                RAMP_SYNTH (amber) — ramps DIFFER
 *   DOM ladder   full bid/ask book, L2      SYNTH profile, SYNTH badge, no bid/ask
 *   tape         TAPE TICK                  TAPE POLL
 *   CVD / side   SIDE EXCHANGE (real)       SIDE NA (keyless)
 *   BBO overlay  drawn (non-null)           null — never fabricated
 *   VWAP         real (no approx badge)     vwap:'approx'
 *   bubbles      full (tick)                1m AGG (poll tape drives the badge)
 *   markers      present                    present
 *   crosshair    present                    present
 *   replay ctrls present                    present
 *
 * Three tests: the crypto column, the equity column (each a fresh page → zero
 * cross-contamination), and a combined run that drives BOTH through ONE renderer
 * instance (reset between), asserts the ramps differ, and writes the resolved
 * matrix + both-market screenshots as report artifacts.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

// Wire tags (proto/types MsgType) + mode/side/ramp constants.
const DEPTH = 3;
const BAR = 4;
const TRADE = 5;
const BBO = 6;
const MARKER = 7;
const MODE_L2 = 0;
const MODE_SYNTH_PROFILE = 2;
const SIDE_BUY = 0;
const SIDE_SELL = 1;
const SIDE_UNKNOWN = 2;
const SIDE_SRC_EXCHANGE = 0;
const SIDE_SRC_NA = 2;
const RAMP_INFERNO = 0;
const RAMP_SYNTH = 1;

const TAGS = {
  DEPTH,
  BAR,
  TRADE,
  BBO,
  MARKER,
  MODE_L2,
  MODE_SYNTH_PROFILE,
  SIDE_BUY,
  SIDE_SELL,
  SIDE_UNKNOWN,
  SIDE_SRC_EXCHANGE,
  SIDE_SRC_NA,
};

interface Captured {
  ramp: number;
  effBboNull: boolean;
  bubbles: number;
  markers: number;
  vwap: number;
  hasChannelBbo: boolean;
  cap: Record<string, unknown> | null;
}

async function bootPanels(page: Page): Promise<void> {
  await page.goto('/?panels=1');
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      return !!(live?.renderer && live?.bookStore && live?.store);
    },
    undefined,
    { timeout: 45_000 },
  );
}

/**
 * Drive a crypto-shaped session (L2 book + tick tape + exchange side) through the
 * real renderer + bookStore + store, exactly as the live crypto fan-out does.
 */
async function injectCrypto(page: Page): Promise<Captured> {
  return page.evaluate((tags) => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    const r = live.renderer;

    // BTC-scale L2 grid: $0.50 tick, epoch anchored near ~$63k.
    const rows = 200;
    const tick = 0.5;
    const p0 = 63000;
    const epoch = 1;
    const params = { epoch, tick, tick_multiple: 1, dt_ns: 250_000_000, p0, rows };
    live.store.setState({
      epochs: new Map([[epoch, params]]),
      gridEpoch: epoch,
      normSeed: 4,
      // The real Crypcodile descriptor (futures adds 'liquidation'); no vwap key
      // → VWAP is real (from tape), never the 'approx' badge.
      capability: {
        depth: 'L2',
        tape: 'tick',
        trade_side: 'exchange',
        markers: ['liquidation', 'gap'],
      },
      feedState: 'live',
      nextOpenTs: null,
    });

    // Two-sided L2 book: best bid row 100 ($63050.0), best ask row 101 ($63050.5).
    const mkBook = () => {
      const bid = new Float32Array(rows);
      const ask = new Float32Array(rows);
      bid[98] = 3;
      bid[99] = 5;
      bid[100] = 8; // best bid (largest bar)
      ask[101] = 7; // best ask
      ask[102] = 4;
      ask[103] = 2;
      return { bid, ask };
    };
    const total = 10;
    for (let s = 0; s < total; s += 1) {
      const { bid, ask } = mkBook();
      const col = {
        type: tags.DEPTH,
        epoch,
        col_seq: s,
        t0_ns: BigInt(s) * BigInt(params.dt_ns),
        mode: tags.MODE_L2,
        final: true,
        bid,
        ask,
      };
      r.ingestForTest(col);
      live.bookStore.ingestForTest(col);
    }

    // Real channel BBO (drawn), tick trades (exchange side), a VWAP bar, markers.
    const bboMsg = {
      type: tags.BBO,
      ts_ns: BigInt(total) * BigInt(params.dt_ns),
      bid_px: p0 + 100 * tick,
      bid_sz: 8,
      ask_px: p0 + 101 * tick,
      ask_sz: 7,
    };
    r.ingestForTest(bboMsg);
    live.bookStore.ingestForTest(bboMsg);

    const trades = [
      { p: p0 + 101 * tick, sz: 2, side: tags.SIDE_BUY },
      { p: p0 + 100 * tick, sz: 3, side: tags.SIDE_SELL },
      { p: p0 + 101 * tick, sz: 5, side: tags.SIDE_BUY },
    ];
    trades.forEach((t, i) => {
      const msg = {
        type: tags.TRADE,
        ts_ns: BigInt(i + 1) * 1_000_000n,
        price: t.p,
        size: t.sz,
        side: t.side,
        side_src: tags.SIDE_SRC_EXCHANGE,
        venue: 'binance',
      };
      r.ingestForTest(msg);
      live.bookStore.ingestForTest(msg);
    });

    // Bars → real session VWAP (cumulative num/den).
    for (let c = 0; c < total; c += 2) {
      const k = c / 2 + 1;
      r.ingestForTest({
        type: tags.BAR,
        epoch,
        col_seq: c,
        t0_ns: BigInt(c) * BigInt(params.dt_ns),
        o: p0 + 100 * tick,
        h: p0 + 101 * tick,
        l: p0 + 99 * tick,
        c: p0 + 100 * tick,
        vol_buy: 1,
        vol_sell: 1,
        cvd_cum: 0,
        vwap_num_cum: (p0 + 100 * tick) * k,
        vwap_den_cum: k,
      });
    }

    // Markers: a liquidation glyph + a gap (crypto tier).
    r.ingestForTest({
      type: tags.MARKER,
      ts_ns: 4_000_000n,
      kind: 'liquidation',
      text: 'liq',
      price: p0 + 104 * tick,
      size: 25,
    });
    r.ingestForTest({ type: tags.MARKER, ts_ns: 5_000_000n, kind: 'gap', text: 'gap', price: null, size: null });

    const dbg = r.overlayDebugForTest();
    return {
      ramp: r.currentRamp,
      effBboNull: r.overlayEffectiveBboForTest() === null,
      bubbles: dbg.bubbles,
      markers: dbg.markers,
      vwap: dbg.vwap,
      hasChannelBbo: dbg.hasChannelBbo,
      cap: live.store.getState().capability,
    } as Captured;
  }, TAGS);
}

/**
 * Drive an equity-keyless-shaped session (SYNTH_PROFILE bid-only density + poll
 * tape + na side + closed market) through the same renderer + bookStore + store.
 */
async function injectEquityKeyless(page: Page): Promise<Captured> {
  return page.evaluate((tags) => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    const r = live.renderer;

    // Equity SYNTH grid: cent tick, re-anchored near AAPL's real price (~$180).
    const rows = 256;
    const tick = 0.01;
    const p0 = 178.72;
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

    // Cumulative volume-at-price: bid-only density (ask EMPTY), POC at center row.
    const pocRow = 128;
    const mkBid = (): Float32Array => {
      const bid = new Float32Array(rows);
      for (let rr = 0; rr < rows; rr += 1) {
        const d = Math.abs(rr - pocRow);
        if (d <= 18) bid[rr] = 40 * (1 - d / 20) + (d === 0 ? 30 : 0);
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
      r.ingestForTest(col); // heatmap
      live.bookStore.ingestForTest(col); // DOM ladder
    }

    // Display-only poll prints (side na) → the tape; NEVER fed to CVD.
    for (let i = 0; i < 3; i += 1) {
      const msg = {
        type: tags.TRADE,
        ts_ns: BigInt(i + 1) * 1_000_000n,
        price: p0 + pocRow * tick,
        size: 1,
        side: tags.SIDE_UNKNOWN,
        side_src: tags.SIDE_SRC_NA,
        venue: 'yahoo',
      };
      r.ingestForTest(msg);
      live.bookStore.ingestForTest(msg);
    }

    // Bars → approx VWAP from 1 m typical×vol.
    for (let c = 0; c < total; c += 2) {
      const k = c / 2 + 1;
      r.ingestForTest({
        type: tags.BAR,
        epoch,
        col_seq: c,
        t0_ns: BigInt(c) * BigInt(params.dt_ns),
        o: p0 + pocRow * tick,
        h: p0 + (pocRow + 1) * tick,
        l: p0 + (pocRow - 1) * tick,
        c: p0 + pocRow * tick,
        vol_buy: 1,
        vol_sell: 0,
        cvd_cum: 0,
        vwap_num_cum: (p0 + pocRow * tick) * k,
        vwap_den_cum: k,
      });
    }

    // Markers: gaps + a session break (the only equity-keyless marker tier).
    r.ingestForTest({ type: tags.MARKER, ts_ns: 3_000_000n, kind: 'gap', text: 'gap', price: null, size: null });
    r.ingestForTest({
      type: tags.MARKER,
      ts_ns: 6_000_000n,
      kind: 'session_break',
      text: 'break',
      price: null,
      size: null,
    });

    // Terminal closed Status (§7.1): warmup profile stays; next open ~90 s out.
    const nextOpenMs = Date.now() + 90_000;
    live.store.setState({
      feedState: 'closed',
      nextOpenTs: BigInt(nextOpenMs) * 1_000_000n,
    });

    const dbg = r.overlayDebugForTest();
    return {
      ramp: r.currentRamp,
      effBboNull: r.overlayEffectiveBboForTest() === null,
      bubbles: dbg.bubbles,
      markers: dbg.markers,
      vwap: dbg.vwap,
      hasChannelBbo: dbg.hasChannelBbo,
      cap: live.store.getState().capability,
    } as Captured;
  }, TAGS);
}

/**
 * Crosshair + replay transport are present in BOTH markets (§7 bottom rows).
 * The crosshair mounts only on hover, so we actively drive it over the canvas and
 * assert the exact price+size readout renders — real evidence, not a static probe.
 */
async function assertCrosshairAndReplay(page: Page): Promise<void> {
  const box = await page.locator('canvas#gl').boundingBox();
  expect(box, 'gl canvas has a box').not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await expect(page.locator('[data-testid="crosshair-readout"]'), 'crosshair readout on hover').toBeVisible({
    timeout: 5_000,
  });
  await page.mouse.move(box!.x - 5, box!.y - 5); // leave → hide, no residual state

  // The transport is now MODE-GATED: replay controls exist only in replay mode.
  // This helper boots `?panels=1`, which never subscribes, so mode is always
  // 'live' — asserting the controls are merely absent would be vacuous and would
  // leave the §7 `replay_controls` matrix cell unevidenced. Flip the store into
  // replay, assert the controls mount, then restore.
  expect(await page.locator('[data-testid="transport"]').count(), 'transport present').toBe(1);
  await page.evaluate(() => {
    const live = (window as unknown as { __flowmapLive: { store: any } }).__flowmapLive;
    const sub = live.store.getState().subscription;
    live.store.setState({
      subscription: { ...(sub ?? { market: 'sim', symbol: 'SIM-DEMO' }), mode: 'replay' },
    });
  });
  await expect(page.locator('[data-testid="speed-cycle"]'), 'replay speed control').toHaveCount(1);
  await expect(page.locator('[data-testid="seek-scrubber"]'), 'replay scrubber').toHaveCount(1);
  await expect(page.locator('[data-testid="transport-play"]'), 'replay play/pause').toHaveCount(1);
  await page.evaluate(() => {
    const live = (window as unknown as { __flowmapLive: { store: any } }).__flowmapLive;
    const sub = live.store.getState().subscription;
    live.store.setState({ subscription: { ...sub, mode: 'live' } });
  });
  // ...and in LIVE they are gone entirely — the point of the simplification.
  await expect(page.locator('[data-testid="speed-cycle"]'), 'no dead speed control in live').toHaveCount(0);
  await expect(page.locator('[data-testid="seek-scrubber"]'), 'no dead scrubber in live').toHaveCount(0);
}

/** Assert the crypto column of the §7 table (full-fidelity L2/tick). */
async function assertCryptoCells(page: Page, cap: Captured): Promise<void> {
  // heatmap: thermal ramp.
  expect(cap.ramp, 'crypto heatmap is RAMP_INFERNO').toBe(RAMP_INFERNO);

  // Wait for the throttled (~10 Hz) bookStore flush to paint the L2 ladder.
  await page.waitForFunction(() => !!document.querySelector('[data-testid="ladder-row"]'), undefined, {
    timeout: 10_000,
  });

  // DOM ladder: full two-sided book, L2 badge, real bid + ask columns.
  await expect(page.locator('[data-testid="ladder-badge"]')).toHaveText('L2');
  expect(await page.locator('.ladder__cell--bid').count(), 'L2 has a bid column').toBeGreaterThan(0);
  expect(await page.locator('.ladder__cell--ask').count(), 'L2 has an ask column').toBeGreaterThan(0);

  // tape: real tick tape.
  await expect(page.locator('[data-testid="tape-badge"]')).toHaveText('TAPE TICK');

  // CVD / side: exchange-stamped side (real).
  const caps = page.locator('[data-testid="capability-badges"]');
  await expect(caps).toContainText('L2');
  await expect(caps).toContainText('TAPE TICK');
  await expect(caps).toContainText('SIDE EXCHANGE');
  expect(cap.cap?.trade_side, 'crypto side is exchange').toBe('exchange');

  // BBO overlay: drawn (real channel quote).
  expect(cap.effBboNull, 'crypto draws a real BBO').toBe(false);
  expect(cap.hasChannelBbo, 'crypto has a channel BBO').toBe(true);

  // VWAP: real — no approx badge (no vwap:'approx' in the descriptor).
  expect(cap.cap?.vwap ?? null, 'crypto VWAP is not approx').not.toBe('approx');
  expect(cap.vwap, 'crypto VWAP has data').toBeGreaterThan(0);

  // bubbles: full (tick tape → no 1m AGG badge).
  expect(cap.cap?.tape, 'crypto tape is tick (bubbles full)').toBe('tick');
  expect(cap.bubbles, 'crypto bubbles ingested').toBeGreaterThanOrEqual(2);

  // markers, crosshair, replay: present.
  expect(cap.markers, 'crypto markers present').toBeGreaterThanOrEqual(2);
  await assertCrosshairAndReplay(page);
}

/** Assert the equity-keyless column of the §7 table (honest reduced fidelity). */
async function assertEquityCells(page: Page, cap: Captured): Promise<void> {
  // heatmap: SYNTH amber ramp.
  expect(cap.ramp, 'equity heatmap is RAMP_SYNTH').toBe(RAMP_SYNTH);

  // Wait for the throttled flush to paint the SYNTH profile ladder.
  await page.waitForFunction(() => !!document.querySelector('[data-testid="ladder-row"]'), undefined, {
    timeout: 10_000,
  });

  // DOM ladder: SYNTH volume-at-price profile, SYNTH badge, NO fabricated book.
  await expect(page.locator('[data-testid="ladder-badge"]')).toHaveText('SYNTH');
  expect(await page.locator('.ladder__profile').count(), 'SYNTH profile rungs render').toBeGreaterThan(0);
  expect(await page.locator('.ladder__cell--bid').count(), 'no fabricated bid column').toBe(0);
  expect(await page.locator('.ladder__cell--ask').count(), 'no fabricated ask column').toBe(0);

  // tape: display-only poll.
  await expect(page.locator('[data-testid="tape-badge"]')).toHaveText('TAPE POLL');

  // CVD / side: explicit N/A (keyless has no aggressor side).
  const caps = page.locator('[data-testid="capability-badges"]');
  await expect(caps).toContainText('SYNTH_PROFILE');
  await expect(caps).toContainText('TAPE POLL');
  await expect(caps).toContainText('SIDE NA');
  expect(cap.cap?.trade_side, 'equity side is na').toBe('na');

  // BBO overlay: NOT fabricated — null for keyless (§7 honesty constraint).
  expect(cap.effBboNull, 'equity draws no fabricated BBO').toBe(true);
  expect(cap.hasChannelBbo, 'equity has no channel BBO').toBe(false);

  // VWAP: approx badge.
  expect(cap.cap?.vwap, 'equity VWAP is approx').toBe('approx');
  expect(cap.vwap, 'equity VWAP has data (from 1m bars)').toBeGreaterThan(0);

  // bubbles: 1m AGG (poll tape drives the honesty badge).
  expect(cap.cap?.tape, 'equity tape is poll (bubbles 1m AGG)').toBe('poll');

  // markers, crosshair, replay: present.
  expect(cap.markers, 'equity markers present').toBeGreaterThanOrEqual(1);
  await assertCrosshairAndReplay(page);

  // Equity-only: the closed-market banner + next-open countdown (weekend state).
  await expect(page.locator('[data-testid="closed-banner"]')).toBeVisible();
  await expect(page.locator('[data-testid="closed-banner"]')).toContainText('MARKET CLOSED');
}

test('§7 parity — crypto column: L2 · TAPE TICK · SIDE EXCHANGE (full fidelity)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootPanels(page);
  const cap = await injectCrypto(page);
  await page.waitForTimeout(250);
  await assertCryptoCells(page, cap);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(join(ARTIFACT_DIR, 'parity-crypto.png'), await page.screenshot());

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('§7 parity — equity keyless column: SYNTH · TAPE POLL · SIDE NA (honest reduced)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootPanels(page);
  const cap = await injectEquityKeyless(page);
  await page.waitForTimeout(250);
  await assertEquityCells(page, cap);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(join(ARTIFACT_DIR, 'parity-equity.png'), await page.screenshot());

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('§7 parity — both markets through ONE renderer: ramps differ + matrix', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootPanels(page);

  // Crypto first through this renderer instance.
  const crypto = await injectCrypto(page);
  await page.waitForFunction(() => !!document.querySelector('[data-testid="ladder-row"]'), undefined, {
    timeout: 10_000,
  });
  await expect(page.locator('[data-testid="ladder-badge"]')).toHaveText('L2');

  // Reset the SAME renderer + book for a new session (the market-switch path),
  // then drive the equity-keyless session through it.
  await page.evaluate(() => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    live.renderer.resetForSession();
    live.bookStore.resetForSession();
  });
  const equity = await injectEquityKeyless(page);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="ladder-badge"]')?.textContent === 'SYNTH' &&
      !!document.querySelector('.ladder__profile'),
    undefined,
    { timeout: 10_000 },
  );

  // The headline honest-parity claim: the SAME renderer paints DIFFERENT ramps.
  expect(crypto.ramp, 'crypto → inferno (real depth)').toBe(RAMP_INFERNO);
  expect(equity.ramp, 'equity → SYNTH amber').toBe(RAMP_SYNTH);
  expect(crypto.ramp, 'ramps differ across markets').not.toBe(equity.ramp);

  // BBO honesty holds across the switch: real for crypto, never fabricated for equity.
  expect(crypto.effBboNull).toBe(false);
  expect(equity.effBboNull).toBe(true);

  // Resolve the §7 matrix and write it as a machine-readable report artifact.
  const matrix = {
    generated_at: new Date().toISOString(),
    spec: '§7 capability model — honest dual-market parity',
    renderer: 'one market-agnostic WebGL2 renderer (crypto + equity, same instance)',
    features: {
      heatmap: { crypto: 'inferno (RAMP_INFERNO)', equity_keyless: 'SYNTH amber (RAMP_SYNTH)', differ: crypto.ramp !== equity.ramp },
      dom_ladder: { crypto: 'L2 full book (bid+ask columns)', equity_keyless: 'SYNTH volume-at-price profile, no bid/ask' },
      tape: { crypto: 'TAPE TICK', equity_keyless: 'TAPE POLL (display-only)' },
      cvd_side: { crypto: 'SIDE EXCHANGE (real)', equity_keyless: 'SIDE NA (explicit N/A)' },
      bbo_overlay: { crypto: 'drawn (channel quote)', equity_keyless: 'null (never fabricated)' },
      vwap: { crypto: 'real (from tape)', equity_keyless: 'approx (1m bars, badged)' },
      bubbles: { crypto: 'full (tick)', equity_keyless: '1m AGG (poll tape)' },
      markers: { crypto: `present (${crypto.markers})`, equity_keyless: `present (${equity.markers})` },
      crosshair: { crypto: 'present', equity_keyless: 'present' },
      replay_controls: { crypto: 'present', equity_keyless: 'present' },
    },
    capabilities: { crypto: crypto.cap, equity_keyless: equity.cap },
  };
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(join(ARTIFACT_DIR, 'parity-matrix.json'), JSON.stringify(matrix, null, 2));
  writeFileSync(join(ARTIFACT_DIR, 'parity-both.png'), await page.screenshot());

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
});
