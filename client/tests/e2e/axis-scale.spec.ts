import { expect, test, type Page } from '@playwright/test';

/**
 * §9 price-axis control surface — the TradingView/Bookmap interaction the chart
 * canvas cannot provide (there, an unmodified wheel is TIME zoom).
 *
 * Driven through the REAL renderer against the real sim feed, with real input
 * events on the gutter, asserting the camera uniforms the shader actually reads:
 *   (a) wheel over the gutter scales PRICE only — colScale untouched, and the
 *       right edge stays pinned to now (`following` stays true);
 *   (b) the row under the cursor is preserved across the zoom (anchoring);
 *   (c) a vertical DRAG scales price (an axis drag stretches the axis; it does
 *       not pan it);
 *   (d) a plain CLICK does not scale and does not claim the axis (the deadzone);
 *   (e) double-click restores auto-FIT;
 *   (f) the AUTO chip toggles the mode and does not start a drag;
 *   (g) no console / page errors throughout.
 *
 * `?spy=1` matches shell.spec's bootLive VERBATIM — a bare `/` happens to work
 * only because playwright.config boots `npm run dev`, so it would break silently
 * on a switch to `vite preview`.
 */

const GUTTER = '.price-axis .axis-canvas';

interface View {
  colOffset: number;
  colScale: number;
  rowOffset: number;
  rowScale: number;
}

const view = (page: Page): Promise<View> =>
  page.evaluate(() => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.viewSnapshot);

const follow = (page: Page): Promise<{ following: boolean; priceFollow: string }> =>
  page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    return { following: r.following, priceFollow: r.priceFollow };
  });

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
  // Wait for a real column so the camera has a fitted frame to scale.
  await page.waitForFunction(
    () => (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer.newestColSeq >= 0,
    undefined,
    { timeout: 30_000 },
  );
  await settleTimeFrame(page);
  return consoleErrors;
}

/**
 * Wait until the auto-follow TIME frame stops widening.
 *
 * `applyTimeFollowFrame` derives the visible column count as
 * `min(cssW/columnPx, cap, range.count)`, so early in a session colScale GROWS
 * on its own with every arriving column until the ring holds a full screen. Any
 * "time zoom was untouched" assertion taken before that saturates would be
 * measuring the feed, not the gesture.
 */
async function settleTimeFrame(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const a = (await view(page)).colScale;
        await page.waitForTimeout(350);
        const b = (await view(page)).colScale;
        return a === b;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

test('§9 price gutter scales price like TradingView, and never touches time', async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors = await bootLive(page);

  const box = await page.locator(GUTTER).boundingBox();
  expect(box, 'price gutter has a box').not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height * 0.5;

  // --- (a) wheel over the gutter scales PRICE and adopts the user's span -----
  const boot = await view(page);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await view(page)).rowScale < boot.rowScale * 0.95).toBe(true);

  // The right edge is STILL pinned to now — scaling price must not detach time.
  expect((await follow(page)).following, 'time follow survives a price scale').toBe(true);
  // ...and the price axis adopted the user's span rather than switching off.
  expect((await follow(page)).priceFollow, 'fit is promoted to track').toBe('track');

  // --- (b) a SECOND wheel is exactly cursor-anchored, and time is untouched ---
  // Measured now that priceFollow is 'track': the price frame is user-owned, so
  // nothing but this gesture can move it between the two samples.
  const before = await view(page);
  const anchorBefore = before.rowOffset + before.rowScale * 0.5;
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await view(page)).rowScale < before.rowScale * 0.95).toBe(true);

  const after = await view(page);
  expect(after.colScale, 'time zoom untouched by a price-gutter wheel').toBe(before.colScale);
  const anchorAfter = after.rowOffset + after.rowScale * 0.5;
  expect(Math.abs(anchorAfter - anchorBefore), 'the row under the cursor is preserved')
    .toBeLessThan(1e-6);

  // --- (d) a plain click does not scale and does not claim the axis ----------
  const preClick = await view(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 1); // 1px tremor — inside the deadzone
  await page.mouse.up();
  expect((await view(page)).rowScale, 'a click never scales the axis').toBe(preClick.rowScale);
  expect((await follow(page)).priceFollow, 'a click never claims the axis').toBe('track');

  // --- (c) a vertical drag scales price, leaving time alone ------------------
  const preDrag = await view(page);
  await page.mouse.move(cx, cy - 60);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(cx, cy - 60 + i * 10);
  await page.mouse.up();
  const postDrag = await view(page);
  expect(postDrag.rowScale, 'dragging DOWN compresses the price axis')
    .toBeGreaterThan(preDrag.rowScale * 1.05);
  expect(postDrag.colScale, 'a gutter drag never pans/zooms time').toBe(preDrag.colScale);

  // --- (e) double-click restores auto-fit ------------------------------------
  await page.locator(GUTTER).dblclick({ position: { x: box!.width / 2, y: box!.height / 2 } });
  await expect.poll(async () => (await follow(page)).priceFollow).toBe('fit');

  // --- (f) the AUTO chip toggles the mode ------------------------------------
  const chip = page.locator('[data-testid="price-auto"]');
  await expect(chip).toHaveText('FIT');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await chip.click();
  await expect(chip).toHaveText('LOCK');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  expect((await follow(page)).priceFollow).toBe('off');
  await chip.click();
  await expect(chip).toHaveText('FIT');
  expect((await follow(page)).priceFollow).toBe('fit');

  // --- (g) clean run ---------------------------------------------------------
  expect(consoleErrors, `console/page errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('§9 a horizontal canvas drag detaches TIME but keeps price tracking', async ({ page }) => {
  test.setTimeout(120_000);
  await bootLive(page);

  const box = await page.locator('canvas#gl').boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height * 0.5;

  await page.mouse.move(box!.x + box!.width * 0.65, y);
  await page.mouse.down();
  // Deliberately horizontal: well past the 6px release threshold on x, nothing on y.
  for (let i = 1; i <= 20; i++) await page.mouse.move(box!.x + box!.width * 0.65 + i * 12, y);
  await page.mouse.up();

  const f = await follow(page);
  expect(f.following, 'a horizontal drag detaches the live edge').toBe(false);
  // The whole point of the per-axis release: scrolling back through time must
  // not cost you price tracking, and the fitted span is kept rather than lost.
  expect(f.priceFollow, 'price keeps tracking after a horizontal drag').toBe('track');

  // GO LIVE is the visible way back, and it restores BOTH axes.
  await page.locator('[data-testid="go-live"]').click();
  await expect.poll(async () => (await follow(page)).following).toBe(true);
  expect((await follow(page)).priceFollow).toBe('fit');
});
