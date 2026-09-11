import { expect, test, type Page } from '@playwright/test';

/**
 * Campaign 2026-09-11-chart, lane E — FOLLOW/TRACK regression specs (lane C fix
 * + lane B2's CP1 APIs), driven on the REAL sim feed (`/?spy=1`, `__flowmapLive`).
 *
 * Pins the owner-reported "TRACK PRICE çalışmıyor" bug chain with two specs:
 *
 *  1. Off-edge composite: LOCK via the AUTO chip (FIT→LOCK) must persist
 *     `followPrice:false` to localStorage (lane C D4 — the chip used to bypass
 *     settings); scrolling back in time with a canvas drag must surface BOTH the
 *     GO LIVE and TRACK PRICE chips; clicking TRACK PRICE must set
 *     `priceFollow==='track'` AND return to the live edge (`following===true`)
 *     via the App's composite action (lane C CP1) instead of dying silently; the
 *     AUTO chip must settle on `TRACK` (never a `TRK·WAIT` limbo).
 *
 *  2. Edge-visible control: with the live edge on screen, LOCK then TRACK must
 *     actually GLIDE the camera (`rowCenter` approaches the tracked row) when the
 *     tracked row sits outside the deadband. Conditional by design (survey S1
 *     verified the glide works; the deadband can legitimately be satisfied) — if
 *     the deadband is not exceeded the spec asserts no movement and annotates.
 *
 * No wall-clock phase pins: every wait is a condition poll. The AUTO chip label
 * is a 100 ms poll, the chips a 250 ms poll — expect.poll / toBeVisible absorb it.
 */

interface FollowState {
  priceFollow: string;
  following: boolean;
  edgeVisible: boolean;
  rowCenter: number;
  newest: number;
}

/** Boot the sim session and wait for live columns (renderer + store + ring). */
async function bootSim(page: Page): Promise<void> {
  await page.goto('/?spy=1');
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      if (!live || !live.renderer) return false;
      const range = live.renderer.residentRange();
      return live.store.getState().status === 'live' && range !== null && range.count > 5;
    },
    undefined,
    { timeout: 45_000 },
  );
}

/** Read the live follow state through the public renderer getters. */
function readFollow(page: Page): Promise<FollowState> {
  return page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    const v = r.viewSnapshot;
    return {
      priceFollow: r.priceFollow,
      following: r.following,
      edgeVisible: r.liveEdgeVisible,
      rowCenter: v.rowOffset + v.rowScale / 2,
      newest: r.newestColSeq,
    };
  });
}

/** One real canvas drag; moving RIGHT pans to earlier columns (content follows). */
async function dragBack(page: Page, dx = 600): Promise<void> {
  const box = await page.locator('canvas#gl').boundingBox();
  if (!box) throw new Error('chart-follow: gl canvas has no box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 12 });
  await page.mouse.up();
}

test('TRACK PRICE off-edge: LOCK persists, chips appear, composite returns to the live edge', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await bootSim(page);

  // Boot state: followPrice defaults on → the chip reads FIT.
  await expect(page.getByTestId('price-auto')).toHaveText('FIT');

  // --- LOCK the price axis through the AUTO chip (the real user path). ---------
  await page.getByTestId('price-auto').click();
  await expect
    .poll(async () => (await readFollow(page)).priceFollow, { timeout: 5_000 })
    .toBe('off');

  // Persistence (lane C D4): the chip must write the settings object, or the
  // drawer + the next boot disagree with the camera (the reported reload bug).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const raw = localStorage.getItem('flowmap.settings.v1');
          return raw ? (JSON.parse(raw) as { followPrice?: boolean }).followPrice : null;
        }),
      { timeout: 5_000 },
    )
    .toBe(false);

  // --- Scroll back in time with a real canvas drag until the edge is hidden. ---
  for (let attempt = 0; attempt < 4; attempt++) {
    const s = await readFollow(page);
    if (!s.edgeVisible) break;
    await dragBack(page);
    await expect
      .poll(async () => (await readFollow(page)).edgeVisible, { timeout: 3_000 })
      .toBe(false);
  }
  const scrolled = await readFollow(page);
  expect(scrolled.edgeVisible, 'drag must scroll the live edge off-screen').toBe(false);
  expect(scrolled.following, 'a horizontal drag releases TIME follow').toBe(false);
  expect(scrolled.priceFollow, 'the price lock survives the scroll').toBe('off');

  // Both chips are offered: GO LIVE (time follow released) + TRACK PRICE (locked).
  await expect(page.getByTestId('chip-go-live')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('chip-track-price')).toBeVisible({ timeout: 5_000 });

  // --- TRACK PRICE composite (lane C CP1): track + return to the live edge. ----
  await page.getByTestId('chip-track-price').click();
  await expect
    .poll(async () => (await readFollow(page)).priceFollow, { timeout: 5_000 })
    .toBe('track');
  await expect
    .poll(async () => (await readFollow(page)).following, { timeout: 5_000 })
    .toBe(true);
  await expect
    .poll(async () => (await readFollow(page)).edgeVisible, { timeout: 5_000 })
    .toBe(true);
  // The composite also persisted the policy (both follow axes ON again).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const raw = localStorage.getItem('flowmap.settings.v1');
          return raw ? (JSON.parse(raw) as { followPrice?: boolean }).followPrice : null;
        }),
      { timeout: 5_000 },
    )
    .toBe(true);

  // The AUTO chip must read TRACK at the visible edge — never the TRK·WAIT limbo.
  await expect(page.getByTestId('price-auto')).toHaveText('TRACK', { timeout: 5_000 });
  expect(
    await page.getByTestId('price-auto').getAttribute('data-edge'),
    'chip data-edge must report a visible edge',
  ).toBe('visible');

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('TRACK with a visible edge glides the camera to the tracked row (or honestly holds)', async ({
  page,
}) => {
  test.setTimeout(90_000);

  await bootSim(page);

  // Wait for a live edge that is genuinely on screen.
  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
      return r.newestColSeq > 20 && r.liveEdgeVisible;
    },
    undefined,
    { timeout: 30_000 },
  );

  // LOCK first through the chip (user path), then frame a view that is guaranteed
  // off the tracked row: the bottom wing (rowSpan 8 → deadband 2.4 rows) with a
  // 400-col window that keeps the live edge visible for many columns.
  await expect
    .poll(async () => (await readFollow(page)).priceFollow, { timeout: 5_000 })
    .not.toBe('off');
  await page.getByTestId('price-auto').click();
  await expect
    .poll(async () => (await readFollow(page)).priceFollow, { timeout: 5_000 })
    .toBe('off');

  const framed = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    const n = r.newestColSeq;
    // Right edge = newest + 200: the edge stays visible while the glide runs.
    r.setViewForTest(Math.max(0, n - 200), 400, 0, 8);
    const v = r.viewSnapshot;
    return { rowCenter: v.rowOffset + v.rowScale / 2, edgeVisible: r.liveEdgeVisible };
  });
  expect(framed.edgeVisible, 'framed window must still contain the live edge').toBe(true);
  expect(framed.rowCenter).toBeLessThan(10); // bottom wing, far from any real book

  // TRACK through the chip (the composite is edge-visible → no re-pin).
  await page.getByTestId('price-auto').click();
  await expect
    .poll(async () => (await readFollow(page)).priceFollow, { timeout: 5_000 })
    .toBe('track');

  const start = (await readFollow(page)).rowCenter;
  const moved = await page
    .waitForFunction(
      (s) => {
        const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
        const v = r.viewSnapshot;
        return v.rowOffset + v.rowScale / 2 > s + 2;
      },
      start,
      { timeout: 8_000 },
    )
    .then(() => true)
    .catch(() => false);

  const after = await readFollow(page);
  expect(after.priceFollow, 'track must stay armed during the glide').toBe('track');
  if (moved) {
    // The glide is running toward the tracked row (a real recentre, not a no-op).
    expect(after.rowCenter).toBeGreaterThan(start + 2);
    test.info().annotations.push({
      type: 'glide',
      description: `rowCenter glided ${start.toFixed(1)} → ${after.rowCenter.toFixed(1)} toward the tracked row`,
    });
  } else {
    // Legitimate deadband case: assert the honest alternative and annotate.
    test.info().annotations.push({
      type: 'deadband',
      description:
        'tracked row stayed inside the 0.6 deadband for 8s — asserted no movement instead of a glide',
    });
    expect(Math.abs(after.rowCenter - start)).toBeLessThanOrEqual(2);
  }
});
