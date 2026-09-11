import { expect, test, type Page } from '@playwright/test';

/**
 * Campaign 4 (lane E1) — end-to-end coverage for the features shipped by lane
 * C1 (price alerts), lane C2 (watchlist) and lane D (themes + i18n shell),
 * driven through the REAL app against the server+vite stack booted by
 * playwright.config's webServer array.
 *
 * Determinism rules honoured here (contract P8 / rule 6):
 *   - no fixed sleeps; every wait is a condition (expect.poll /
 *     page.waitForFunction);
 *   - the alert-fire spec drives a CONTROLLED book through the existing
 *     `?panels=1` harness contract (no live feed fights injected data) and
 *     injects prints via `bookStore.ingestForTest`, exactly like
 *     tests/e2e/panels.spec.ts;
 *   - the drawings spec uses the real sim feed + real pointer events, and
 *     waits only on observable conditions (toolbar state, canvas ink,
 *     persisted storage).
 *
 * The onboarding wizard (campaign 3) is a first-run modal with a full-viewport
 * scrim; every spec seeds its documented dismissal flag (`flowmap.onboarded=1`)
 * BEFORE the app boots, so the scrim can never intercept a pointer event.
 */

const TRADE = 5;

/** Seed the first-run dismissal (and optionally watchlist favorites) pre-boot. */
async function seedStorage(page: Page, watchlist?: string[]): Promise<void> {
  await page.addInitScript((keys: string[] | null) => {
    try {
      window.localStorage.setItem('flowmap.onboarded', '1');
      if (keys) window.localStorage.setItem('flowmap.watchlist.v1', JSON.stringify(keys));
    } catch {
      /* storage denied — the spec fails loudly on the scrim if so, never silently */
    }
  }, watchlist ?? null);
}

/** Pin the documented theme persistence key before boot (test pre-condition). */
async function seedTheme(page: Page, theme: string): Promise<void> {
  await page.addInitScript((id: string) => {
    try {
      window.localStorage.setItem('flowmap.theme', id);
    } catch {
      /* storage denied — theme resolution falls back to the OS preference */
    }
  }, theme);
}

/** Boot a LIVE sim session (?spy=1, like shell.spec) and wait for the handshake. */
async function bootLive(page: Page): Promise<void> {
  await page.goto('/?spy=1');
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      return !!live && live.store.getState().status === 'live';
    },
    undefined,
    { timeout: 45_000 },
  );
}

/** Boot the synthetic `?panels=1` harness (no live feed) and wait for the tap. */
async function bootPanels(page: Page): Promise<void> {
  await page.goto('/?panels=1');
  await page.waitForFunction(
    () => !!(window as unknown as { __flowmapLive?: any }).__flowmapLive?.bookStore,
    undefined,
    { timeout: 45_000 },
  );
}

/** Wait until the live sim has painted more than a few resident columns. */
async function waitColumns(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      const range = live?.renderer?.residentRange();
      return !!range && range.count > 5;
    },
    undefined,
    { timeout: 45_000 },
  );
}

/** Non-transparent pixel count of the drawings 2D overlay canvas. */
function layerInk(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector('.draw-layer__canvas') as HTMLCanvasElement | null;
    if (!c || c.width === 0 || c.height === 0) return 0;
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d');
    if (!ctx) return 0;
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n += 1;
    return n;
  });
}

async function storeSubscription(page: Page): Promise<{ symbol?: string; mode?: string } | null> {
  return page.evaluate(
    () =>
      (window as unknown as { __flowmapLive: any }).__flowmapLive.store.getState().subscription,
  );
}

// ---------------------------------------------------------------------------
// 1. Drawings persistence
// ---------------------------------------------------------------------------

test('drawings: trendline draw → persist across reload (same symbol)', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await seedStorage(page);
  await bootLive(page);
  await waitColumns(page);

  // Show the drawing toolbar (`D`, its documented toggle) and arm the tool.
  await page.keyboard.press('d');
  await expect(page.locator('[data-testid="draw-toolbar"]')).toBeVisible();
  await page.locator('[data-testid="draw-toolbar"] button[aria-label="Trend line"]').click();
  await expect(page.locator('[data-testid="drawing-mode"]')).toBeVisible();

  // Drag a trendline near the live edge (so reload leaves it in view).
  const layer = page.locator('[data-testid="drawing-layer"]');
  const box = await layer.boundingBox();
  expect(box).not.toBeNull();
  const b = box!;
  const x0 = b.x + b.width * 0.72;
  const y0 = b.y + b.height * 0.42;
  const x1 = b.x + b.width * 0.96;
  const y1 = b.y + b.height * 0.62;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();

  // Finalized: the toolbar's clear-all enables and the overlay paints ink.
  const clearBtn = page.locator(
    '[data-testid="draw-toolbar"] button[aria-label="Clear all drawings"]',
  );
  await expect(clearBtn).toBeEnabled();
  await expect.poll(() => layerInk(page)).toBeGreaterThan(50);

  // Persisted under the documented per-scope key (schema v1).
  const raw = await page.evaluate(() =>
    localStorage.getItem('flowmap.drawings.v1.sim.SIM-DEMO'),
  );
  expect(raw).toBeTruthy();
  const doc = JSON.parse(raw!) as { version: number; drawings: { tool: string }[] };
  expect(doc.version).toBe(1);
  expect(doc.drawings).toHaveLength(1);
  expect(doc.drawings[0].tool).toBe('trendline');

  // Reload on the SAME symbol: the drawing must come back (loaded from storage).
  await page.reload();
  await bootLiveAfterReload(page);
  await expect
    .poll(
      () => page.evaluate(() => localStorage.getItem('flowmap.drawings.v1.sim.SIM-DEMO')),
      { timeout: 15_000 },
    )
    .toBeTruthy();
  await page.keyboard.press('d');
  await expect(clearBtn).toBeEnabled();
  await expect.poll(() => layerInk(page), { timeout: 15_000 }).toBeGreaterThan(50);

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

/** bootLive() but without a fresh goto (page.reload already navigated). */
async function bootLiveAfterReload(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      return !!live && live.store.getState().status === 'live';
    },
    undefined,
    { timeout: 45_000 },
  );
  await waitColumns(page);
}

// ---------------------------------------------------------------------------
// 2. Alert create + deterministic fire + fired marker
// ---------------------------------------------------------------------------

test('alerts: typed level fires deterministically, fired state + marker visible', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await seedStorage(page);
  await bootPanels(page);

  // Point the session metadata at the sim key (PriceAlerts renders nothing
  // without a subscription) and publish an epoch the marker line maps through.
  await page.evaluate(() => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    live.store.setState({
      subscription: { market: 'sim', symbol: 'SIM-DEMO', mode: 'live', band: 'native' },
      epochs: new Map([
        [1, { epoch: 1, tick: 0.1, tick_multiple: 1, dt_ns: 25_000_000, p0: 50, rows: 500 }],
      ]),
      gridEpoch: 1,
    });
  });

  const chip = page.locator('[data-testid="alerts-chip"]');
  await expect(chip).toBeVisible();

  // Controlled book: ONE trade at 100 (no BBO → marketPriceNow() = newest trade).
  await page.evaluate((t) => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    live.bookStore.ingestForTest({
      type: t,
      ts_ns: 1_000_000n,
      price: 100,
      size: 1,
      side: 0,
      side_src: 0,
      venue: 'sim',
    });
  }, TRADE);

  // Type a level BELOW the reference price → the store infers a `below` alert
  // (fires when price <= level). It stays armed at 100.
  await chip.click();
  await expect(page.locator('[data-testid="alerts-popover"]')).toBeVisible();
  await page.locator('[data-testid="alerts-add-input"]').fill('50');
  await page.locator('[data-testid="alerts-add-go"]').click();

  await expect(page.locator('[data-testid="alert-row"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="alert-state"]')).toContainText('armed');
  await expect(page.locator('[data-testid^="alert-line-"]')).toHaveCount(1);
  await expect(chip).toContainText('1');

  // Deterministic crossing: inject a print at 40 <= 50; the next evaluation
  // tick (100 ms cadence) fires it — polled as a CONDITION, never timing-pinned.
  await page.evaluate((t) => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    live.bookStore.ingestForTest({
      type: t,
      ts_ns: 2_000_000n,
      price: 40,
      size: 1,
      side: 1,
      side_src: 0,
      venue: 'sim',
    });
  }, TRADE);

  await expect
    .poll(async () => (await page.locator('[data-testid="alert-state"]').textContent()) ?? '', {
      timeout: 15_000,
    })
    .toContain('fired');
  await expect(page.locator('[data-testid="alerts-clear-fired"]')).toBeVisible();
  await expect(page.locator('[data-testid^="alert-line-"]')).toHaveClass(
    /alert-line--triggered/,
  );

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});

// ---------------------------------------------------------------------------
// 3. Replay-mode alert guard (honest fallback when replay is unavailable)
// ---------------------------------------------------------------------------

test('replay: unavailable fallback asserted; replay alert-guard marked skipped', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await seedStorage(page);
  await bootLive(page);

  // Recording is DISABLED in the e2e config (FLOWMAP_RECORDING_ENABLED=0), so
  // the server is expected to refuse the replay subscribe (close 1003) and the
  // client must surface the honest badge + fall back to LIVE.
  await page.locator('[data-testid="mode-replay"]').click();
  const refused = await page
    .waitForSelector('[data-testid="replay-unavailable"]', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (refused) {
    await expect.poll(async () => (await storeSubscription(page))?.mode, { timeout: 15_000 }).toBe(
      'live',
    );
    await expect(page.locator('[data-testid="replay-unavailable"]')).toBeVisible();
    // SKIPPED (honest): the P7 guard (alerts not evaluated while mode=replay)
    // cannot be entered without a replayable recording, which this harness
    // deliberately disables. The guard itself is pinned by C1's unit tests
    // (PriceAlerts.test.tsx replay no-fire case).
    test.info().annotations.push({
      type: 'skip',
      description:
        'P7 replay alert-guard assertion SKIPPED: e2e server runs with FLOWMAP_RECORDING_ENABLED=0; honest replay-unavailable fallback asserted instead.',
    });
    return;
  }

  // A replayable recording exists on this server (not the default config):
  // entering replay is asserted, but the guard needs a controlled crossing the
  // live replay feed cannot guarantee — mark that sub-assertion skipped.
  await expect
    .poll(async () => (await storeSubscription(page))?.mode, { timeout: 15_000 })
    .toBe('replay');
  test.info().annotations.push({
    type: 'skip',
    description:
      'P7 replay alert-guard scenario SKIPPED: replay was available but no deterministic crossing can be injected into a real replay feed; honest-mode assertion performed instead.',
  });
});

// ---------------------------------------------------------------------------
// 4. Theme flip (paper-deut + contrast)
// ---------------------------------------------------------------------------

test('themes: paper-deut and contrast flip data-theme + --bg', async ({ page }) => {
  test.setTimeout(120_000);
  await seedStorage(page);
  // Pin the pre-condition: a known midnight baseline (the OS color-scheme seed
  // could otherwise resolve to `paper`, whose --bg equals paper-deut's).
  await seedTheme(page, 'midnight');
  await bootPanels(page);

  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="settings-drawer"]')).toBeVisible();

  const themeAttr = (): Promise<string | undefined> =>
    page.evaluate(() => document.documentElement.dataset.theme);
  const bgVar = (): Promise<string> =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    );

  const bg0 = await bgVar();
  expect(bg0).not.toBe('');

  await page.locator('[data-testid="theme-paper-deut"]').click();
  await expect.poll(themeAttr).toBe('paper-deut');
  const bg1 = await bgVar();
  expect(bg1).not.toBe('');
  expect(bg1, 'paper-deut --bg differs from midnight --bg').not.toBe(bg0);

  await page.locator('[data-testid="theme-contrast"]').click();
  await expect.poll(themeAttr).toBe('contrast');
  const bg2 = await bgVar();
  expect(bg2).not.toBe('');
  expect(bg2, 'contrast --bg differs from paper-deut --bg').not.toBe(bg1);

  expect(await page.evaluate(() => localStorage.getItem('flowmap.theme'))).toBe('contrast');
});

// ---------------------------------------------------------------------------
// 5. Locale flip (EN -> TR -> EN)
// ---------------------------------------------------------------------------

test('locale: drawer flips EN -> TR -> EN with a translated shell string', async ({ page }) => {
  test.setTimeout(120_000);
  await seedStorage(page);
  await bootPanels(page);

  await page.locator('[data-testid="settings-open"]').click();
  const title = page.locator('[data-testid="settings-drawer"] .drawer__title');
  await expect(title).toHaveText('Settings');

  await page.locator('[data-testid="locale-tr"]').click();
  await expect(title).toHaveText('Ayarlar');
  expect(await page.evaluate(() => localStorage.getItem('flowmap.locale'))).toBe('tr');

  await page.locator('[data-testid="locale-en"]').click();
  await expect(title).toHaveText('Settings');
  expect(await page.evaluate(() => localStorage.getItem('flowmap.locale'))).toBe('en');
});

// ---------------------------------------------------------------------------
// 6. Watchlist add + row click switches the chart
// ---------------------------------------------------------------------------

test('watchlist: add current, click a second row switches the subscription', async ({ page }) => {
  test.setTimeout(120_000);
  // Seed one favorite so the click target exists; 'Add current' adds the sim key.
  await seedStorage(page, ['binance-spot:BTCUSDT']);
  await bootLive(page);

  await expect(page.locator('[data-testid="watchlist"]')).toBeVisible();
  const seededRow = page.locator('[data-testid="watchlist-row-binance-spot:BTCUSDT"]');
  await expect(seededRow).toBeVisible();

  await page.locator('[data-testid="watchlist-add"]').click();
  await expect(page.locator('[data-testid="watchlist-row-sim:SIM-DEMO"]')).toBeVisible();
  await expect(page.locator('[data-testid="watchlist-count"]')).toHaveText('2');

  // Clicking the OTHER row switches the chart + topbar to that symbol.
  await seededRow.click();
  await expect
    .poll(async () => (await storeSubscription(page))?.symbol, { timeout: 15_000 })
    .toBe('BTCUSDT');
  await expect(page.locator('[data-testid="venue"]')).toContainText('BTCUSDT');

  // Clean up the watched key (fresh contexts get their own storage anyway).
  await page.evaluate(() => localStorage.removeItem('flowmap.watchlist.v1'));
});
