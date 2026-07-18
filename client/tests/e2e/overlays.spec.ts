import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * T10 verification — overlays (trade bubbles, BBO, VWAP, volume profile, markers,
 * price/time axes) render OVER the heatmap, locked to the camera, driven through
 * the REAL renderer on ANGLE/SwiftShader (software GL, headless).
 *
 * The page opens with `?overlays=1` (no live feed). `preloadOverlayScenario()`
 * builds a fresh depth ring (persistent wall band + ladder) and frames a recent
 * window; the spec then publishes the epoch + L2/tick capability to the store,
 * enables the profile, and injects KNOWN Trade/BBO/BarColumn/Marker events via
 * `ingestForTest` (the real live path). It asserts:
 *   (a) a big BUY trade renders a TEAL dot at its (ts→col, price→row) screen pos;
 *   (b) a big SELL trade renders a RED dot at its screen pos;
 *   (c) the BBO bid/ask render as teal/red horizontal lines at their prices;
 *   (d) the VWAP polyline renders (violet) at the session VWAP row;
 *   (e) a liquidation marker renders an orange glyph at its price;
 *   (f) the volume profile computed a POC in the wall band (max row);
 *   (g) the price axis (right) + time axis (bottom) gutter canvases carry labels;
 *   (h) no console errors / no GL errors (checkGLError throws → pageerror).
 *
 * Colors are sampled by copying the WebGL canvas to a 2D canvas (reliable with
 * preserveDrawingBuffer) and scanning a small box around each expected point.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

// Msg-type wire tags (proto/types MsgType).
const TRADE = 5;
const BBO = 6;
const BAR = 4;
const MARKER = 7;
const SIDE_BUY = 0;
const SIDE_SELL = 1;

interface Probe {
  name: string;
  x: number;
  y: number;
  kind: 'teal' | 'red' | 'violet' | 'orange';
}

test('§8.3 T10: overlays render over the heatmap, locked to the camera', async ({ page }) => {
  test.setTimeout(120_000);

  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/?overlays=1');
  await page.waitForFunction(
    () => !!(window as unknown as { __flowmapLive?: any }).__flowmapLive?.renderer,
    undefined,
    { timeout: 45_000 },
  );

  // Preload depth + publish epoch/capability + inject the known overlay events.
  const probes: Probe[] = await page.evaluate(
    (tags) => {
      const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
      const r = live.renderer;
      const sc = r.preloadOverlayScenario();
      live.store.setState({
        epochs: new Map([[sc.epoch, sc.params]]),
        gridEpoch: sc.epoch,
        capability: { depth: 'L2', tape: 'tick', trade_side: 'exchange', markers: ['liquidation', 'gap'] },
      });
      r.setOverlayVisibility({ profile: true });

      const dt = sc.dtNs;
      const tsOf = (col: number): bigint => BigInt(col) * BigInt(dt);

      // Big BUY (teal) at price 107, big SELL (red) at price 93 — away from the
      // wall band and each other so their dots sit on a dim background.
      const buy = { col: 300, price: 107, size: 60 };
      const sell = { col: 320, price: 93, size: 60 };
      r.ingestForTest({
        type: tags.TRADE, ts_ns: tsOf(buy.col), price: buy.price, size: buy.size,
        side: tags.SIDE_BUY, side_src: 0, venue: 'sim',
      });
      r.ingestForTest({
        type: tags.TRADE, ts_ns: tsOf(sell.col), price: sell.price, size: sell.size,
        side: tags.SIDE_SELL, side_src: 0, venue: 'sim',
      });

      // BBO with a wide, clearly-separated spread.
      const bidPx = 88;
      const askPx = 112;
      r.ingestForTest({ type: tags.BBO, ts_ns: tsOf(390), bid_px: bidPx, bid_sz: 15, ask_px: askPx, ask_sz: 9 });

      // Bars for VWAP: constant session VWAP = 96 across the visible columns.
      const vwapPrice = 96;
      for (let c = sc.view.colOffset; c <= sc.newest; c += 4) {
        const k = c - sc.view.colOffset + 1;
        r.ingestForTest({
          type: tags.BAR, epoch: sc.epoch, col_seq: c, t0_ns: tsOf(c),
          o: 96, h: 97, l: 95, c: 96, vol_buy: 1, vol_sell: 1, cvd_cum: 0,
          vwap_num_cum: vwapPrice * k, vwap_den_cum: k,
        });
      }

      // Liquidation marker (orange) at price 104, and a gap (vertical).
      const liq = { col: 280, price: 104 };
      r.ingestForTest({ type: tags.MARKER, ts_ns: tsOf(liq.col), kind: 'liquidation', text: 'liq', price: liq.price, size: 25 });
      r.ingestForTest({ type: tags.MARKER, ts_ns: tsOf(250), kind: 'gap', text: 'gap', price: null, size: null });
      // Regression: cold-JSON markers deliver ts_ns as a NUMBER (< 2^53). Storing
      // it into the BigInt64Array ring must NOT throw (the live-sim crash).
      r.ingestForTest({ type: tags.MARKER, ts_ns: Number(tsOf(265)), kind: 'liquidation', text: 'liq2', price: 96, size: 12 });

      const buyPos = r.overlayPointCss(tsOf(buy.col), buy.price);
      const sellPos = r.overlayPointCss(tsOf(sell.col), sell.price);
      const liqPos = r.overlayPointCss(tsOf(liq.col), liq.price);
      const cssW = (document.querySelector('canvas#gl') as HTMLCanvasElement).clientWidth;
      const bidY = r.overlayRowCss((bidPx - sc.p0) / sc.step);
      const askY = r.overlayRowCss((askPx - sc.p0) / sc.step);
      const vwapY = r.overlayRowCss((vwapPrice - sc.p0) / sc.step);

      return [
        { name: 'buy', x: buyPos.x, y: buyPos.y, kind: 'teal' },
        { name: 'sell', x: sellPos.x, y: sellPos.y, kind: 'red' },
        { name: 'bbo-bid', x: cssW * 0.5, y: bidY, kind: 'teal' },
        { name: 'bbo-ask', x: cssW * 0.5, y: askY, kind: 'red' },
        { name: 'vwap', x: cssW * 0.5, y: vwapY, kind: 'violet' },
        { name: 'liquidation', x: liqPos.x, y: liqPos.y, kind: 'orange' },
      ] as Probe[];
    },
    { TRADE, BBO, BAR, MARKER, SIDE_BUY, SIDE_SELL },
  );

  // Let a couple of dirty frames draw the overlays.
  await page.waitForTimeout(300);

  // Save the overlay frame as the report artifact.
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const shot = await page.locator('canvas#gl').screenshot();
  writeFileSync(join(ARTIFACT_DIR, 'overlays.png'), shot);

  // Count matching pixels in a ±R css-px box around each expected point.
  const counts: Record<string, number> = await page.evaluate((ps) => {
    const c = document.querySelector('canvas#gl') as HTMLCanvasElement;
    const dpr = c.width / Math.max(1, c.clientWidth);
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    const img = ctx.getImageData(0, 0, off.width, off.height).data;
    const R = 8; // css px

    const match = (kind: string, r: number, g: number, b: number): boolean => {
      switch (kind) {
        case 'teal':
          return g > 90 && r < 110 && b > 55 && g > b - 40;
        case 'red':
          return r > 110 && r > g + 40 && r > b + 40;
        case 'violet':
          return b > 140 && r > 100 && b > g + 30;
        case 'orange':
          return r > 150 && g > 60 && g < 175 && b < 95;
        default:
          return false;
      }
    };

    const out: Record<string, number> = {};
    for (const p of ps as any[]) {
      let n = 0;
      const cx = Math.round(p.x * dpr);
      const cy = Math.round(p.y * dpr);
      const rad = Math.round(R * dpr);
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const px = cx + dx;
          const py = cy + dy;
          if (px < 0 || py < 0 || px >= off.width || py >= off.height) continue;
          const i = (py * off.width + px) * 4;
          if (match(p.kind, img[i], img[i + 1], img[i + 2])) n++;
        }
      }
      out[p.name] = n;
    }
    return out;
  }, probes);

  // (a)-(f) each overlay glyph rendered its expected color at its expected place.
  expect(counts['buy'], 'buy trade → teal dot').toBeGreaterThan(4);
  expect(counts['sell'], 'sell trade → red dot').toBeGreaterThan(4);
  expect(counts['bbo-bid'], 'best bid → teal line').toBeGreaterThan(3);
  expect(counts['bbo-ask'], 'best ask → red line').toBeGreaterThan(3);
  expect(counts['vwap'], 'VWAP → violet polyline').toBeGreaterThan(3);
  expect(counts['liquidation'], 'liquidation → orange glyph').toBeGreaterThan(3);

  // Deterministic overlay state: data ingested + profile POC in the wall band.
  const dbg = await page.evaluate(() =>
    (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.overlayDebugForTest(),
  );
  expect(dbg.bubbles, 'both trades ingested').toBeGreaterThanOrEqual(2);
  expect(dbg.markers, 'markers ingested (incl. number-ts_ns)').toBeGreaterThanOrEqual(3);
  expect(dbg.vwap, 'VWAP bars ingested').toBeGreaterThan(0);
  expect(dbg.hasChannelBbo, 'BBO channel print seen').toBe(true);
  expect(dbg.profileMax, 'profile accumulated volume').toBeGreaterThan(0);
  // The persistent wall band sits at rows 98-102 (mid = row 100) → POC there.
  expect(dbg.profilePoc, `profile POC row ${dbg.profilePoc}`).toBeGreaterThanOrEqual(96);
  expect(dbg.profilePoc).toBeLessThanOrEqual(104);

  // (g) Axis gutters carry tick labels (non-empty ink in each gutter canvas).
  const axisInk = await page.evaluate(() => {
    const ink = (sel: string): number => {
      const el = document.querySelector(sel) as HTMLCanvasElement | null;
      if (!el || el.width === 0) return 0;
      const off = document.createElement('canvas');
      off.width = el.width;
      off.height = el.height;
      const ctx = off.getContext('2d')!;
      ctx.drawImage(el, 0, 0);
      const d = ctx.getImageData(0, 0, off.width, off.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; // alpha channel
      return n;
    };
    return { price: ink('.price-axis .axis-canvas'), time: ink('.time-axis .axis-canvas') };
  });
  expect(axisInk.price, 'price axis has labels').toBeGreaterThan(50);
  expect(axisInk.time, 'time axis has labels').toBeGreaterThan(50);

  // (h) Clean run — no console/page errors, no GL errors.
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
