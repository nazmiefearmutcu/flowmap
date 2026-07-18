import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * T12 verification — the UI shell (§9) over the real server (playwright.config's
 * webServer boots flowmap-server + vite). The page loads with `?spy=1`, which
 * installs a control tap: every outbound control frame is decoded into
 * `window.__flowmapControls`, so the specs assert the EXACT messages the transport
 * sends (Subscribe / Unsubscribe / SetSpeed / Pause / Resume / Seek) rather than
 * relying on an un-exercised replay data source.
 *
 * Covered: the shell renders as a trading terminal (screenshot artifact); symbol
 * search queries /api/symbols and switching a symbol re-subscribes; the live/replay
 * toggle + play/pause + speed + seek send the correct control messages; settings
 * persist across a reload; Space + `/` keyboard work.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(__dirname, '__artifacts__');

// MsgType wire tags (proto/types MsgType) for the client→server control frames.
const SUBSCRIBE = 0x40;
const UNSUBSCRIBE = 0x41;
const SEEK = 0x42;
const SET_SPEED = 0x43;
const PAUSE = 0x44;
const RESUME = 0x45;

interface Ctrl {
  type: number;
  market?: string;
  symbol?: string;
  mode?: string;
  x?: number;
  t?: string;
}

/** The decoded control-frame log the spy tap captured. */
const controls = (page: Page): Promise<Ctrl[]> =>
  page.evaluate(() => (window as unknown as { __flowmapControls?: Ctrl[] }).__flowmapControls ?? []);

const storeState = (page: Page): Promise<any> =>
  page.evaluate(() => (window as unknown as { __flowmapLive: any }).__flowmapLive.store.getState());

async function bootLive(page: Page): Promise<string[]> {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto('/?spy=1');
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      return !!live && live.store.getState().status === 'live';
    },
    undefined,
    { timeout: 45_000 },
  );
  return consoleErrors;
}

test('shell renders as a trading terminal + screenshot', async ({ page }) => {
  const errors = await bootLive(page);

  // The core chrome is present and framed around the heatmap.
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('[data-testid="symbol-search-input"]')).toBeVisible();
  await expect(page.locator('[data-testid="venue"]')).toContainText('Sim');
  await expect(page.locator('[data-testid="capability-badges"]')).toBeVisible();
  await expect(page.locator('[data-testid="mode-toggle"]')).toBeVisible();
  await expect(page.locator('[data-testid="clock"]')).toBeVisible();
  await expect(page.locator('[data-testid="timeline"]')).toBeVisible();
  await expect(page.locator('canvas#gl')).toBeVisible();
  await expect(page.locator('[data-testid="right-rail"]')).toBeVisible();

  // Let a couple of seconds of live sim paint the heatmap for the screenshot.
  await page.waitForTimeout(1500);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const shot = await page.screenshot();
  writeFileSync(join(ARTIFACT_DIR, 'shell.png'), shot);

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('symbol search queries /api/symbols and switching re-subscribes', async ({ page }) => {
  await bootLive(page);

  // Type a crypto query; the dropdown populates from /api/symbols.
  await page.locator('[data-testid="symbol-search-input"]').click();
  await page.locator('[data-testid="symbol-search-input"]').fill('btc');
  const row = page.locator('[data-testid="symbol-row"][data-symbol="BTCUSDT"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toHaveAttribute('data-market', 'binance-spot');

  await row.click();

  // The store swapped to the new symbol...
  await expect
    .poll(async () => (await storeState(page)).subscription?.symbol)
    .toBe('BTCUSDT');

  // ...and the transport re-subscribed: an Unsubscribe then a Subscribe(BTCUSDT).
  await expect
    .poll(async () => {
      const log = await controls(page);
      return log.some(
        (c) => c.type === SUBSCRIBE && c.symbol === 'BTCUSDT' && c.market === 'binance-spot',
      );
    })
    .toBe(true);
  const log = await controls(page);
  expect(log.some((c) => c.type === UNSUBSCRIBE)).toBe(true);
});

test('replay toggle + transport send the correct control messages', async ({ page }) => {
  await bootLive(page);

  // Enter replay: Unsubscribe(live) → Subscribe(mode=replay).
  await page.locator('[data-testid="mode-replay"]').click();
  await expect.poll(async () => (await storeState(page)).subscription?.mode).toBe('replay');
  await expect
    .poll(async () => {
      const log = await controls(page);
      return log.some((c) => c.type === SUBSCRIBE && c.mode === 'replay');
    })
    .toBe(true);

  // Pause → Resume via the play button (replay starts playing).
  await page.locator('[data-testid="transport-play"]').click(); // pause
  await expect.poll(async () => (await storeState(page)).paused).toBe(true);
  await page.locator('[data-testid="transport-play"]').click(); // resume
  await expect.poll(async () => (await storeState(page)).paused).toBe(false);

  // Speed 5×.
  await page.locator('[data-testid="speed-5"]').click();
  await expect.poll(async () => (await storeState(page)).speed).toBe(5);

  // Seek: set the scrubber and dispatch a native input so React's onChange fires.
  await page.locator('[data-testid="seek-scrubber"]').evaluate((el) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '500');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const log = await controls(page);
  const types = log.map((c) => c.type);
  expect(types).toContain(PAUSE);
  expect(types).toContain(RESUME);
  expect(types).toContain(SEEK);
  const setSpeed = log.find((c) => c.type === SET_SPEED);
  expect(setSpeed?.x).toBe(5);
  // The Seek carries a bigint ns (serialized to a string by the tap).
  const seek = log.find((c) => c.type === SEEK);
  expect(typeof seek?.t).toBe('string');
});

test('settings persist across a reload', async ({ page }) => {
  await bootLive(page);

  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="settings-drawer"]')).toBeVisible();

  // Change the colormap and flip follow off.
  await page.locator('[data-testid="colormap-alt"]').click();
  await page.locator('[data-testid="toggle-follow"]').click();

  // Written straight to localStorage.
  const stored = await page.evaluate(() => localStorage.getItem('flowmap.settings.v1'));
  expect(stored).toBeTruthy();
  const parsed = JSON.parse(stored as string);
  expect(parsed.colormap).toBe('alt');
  expect(parsed.follow).toBe(false);

  // Reload → the choice survives.
  await page.reload();
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      return !!live && live.store.getState().status === 'live';
    },
    undefined,
    { timeout: 45_000 },
  );
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="colormap-alt"]')).toHaveAttribute('aria-pressed', 'true');
});

test('Space toggles follow and `/` focuses the symbol search', async ({ page }) => {
  await bootLive(page);

  // `/` focuses the symbol search from anywhere.
  await page.locator('canvas#gl').click();
  await page.keyboard.press('/');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('symbol-search-input');

  // Blur the input, focus the canvas, then Space toggles follow (live mode).
  await page.keyboard.press('Escape');
  await page.locator('canvas#gl').click();
  const before = await page.evaluate(
    () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.following,
  );
  await page.keyboard.press('Space');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.following,
      ),
    )
    .toBe(!before);
});
