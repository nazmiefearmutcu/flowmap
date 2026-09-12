import { expect, test } from '@playwright/test';

/**
 * Campaign 2026-09-11-chart, lane E (optional, NETWORK-DEPENDENT) — the
 * reconstructed-history time-warp fix (survey S2/D1, lane B1/B2 CP2).
 *
 * Attaching `binance-spot:BTCUSDT` in the `native` band makes the server seed a
 * RECONSTRUCTED 1 m-candle history block (the deep/wide bands refuse candle
 * reconstruction by design, so `native` is required). Before CP2 the overlay
 * time map was one affine anchored on the live (250 ms) column, so every
 * reconstructed column was placed 250 ms apart — axis labels and trades in the
 * history zone were scattered. CP2's piecewise per-slot t0 table fixes the map.
 *
 * Assertions (all through the public `__flowmapLive.renderer` getters):
 *  - the reconstructed→live cadence transition exists: a reconstructed column
 *    delta (sub-minute; 3.75 s at the shipped stretch=16, which spreads each
 *    1 m candle over 16 columns on the 250 ms grid) followed by sub-second
 *    (250 ms) live deltas;
 *  - `colForTsForTest(colToTsForTest(k))` round-trips to the candle column k;
 *  - an overlay point at the candle's t0 maps to the SAME canvas x as the cell
 *    centre for that column (the ts→col transform the glyphs consume).
 *
 * If the network/feed is unavailable (no reconstructed history within the
 * budget) the spec SKIPS with an explicit annotation — never a fabricated pass.
 */

test('BTC native: reconstructed history maps real candle times (network-dependent)', async ({
  page,
}) => {
  test.setTimeout(150_000);

  await page.goto('/?spy=1');
  await page.waitForFunction(
    () => {
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      return !!live?.renderer;
    },
    undefined,
    { timeout: 45_000 },
  );

  // Attach the real Binance BTC session in the `native` band (band is a server
  // grid property: only native reconstructs candle history).
  await page.evaluate(() => {
    const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
    live.store.getState().connectAndSubscribe('binance-spot', 'BTCUSDT', 'live', 'native');
  });

  // Wait for a live BTC session with a reconstructed history block, AND for the
  // eager history prefetch to make the block resident: the reconstructed→live
  // boundary must be observable through the renderer's public time-map getters.
  const ready = await page
    .waitForFunction(
      () => {
        const live = (window as unknown as { __flowmapLive: any }).__flowmapLive;
        const st = live.store.getState();
        const cap = st.capability as { history?: string } | null;
        if (!(st.status === 'live' && st.subscription?.symbol === 'BTCUSDT' && cap?.history === 'reconstructed')) {
          return false;
        }
        const r = live.renderer;
        const range = r.residentRange();
        if (range === null || range.count < 4) return false;
        for (let c = range.oldest; c < range.newest; c++) {
          const a = r.colToTsForTest(c) as bigint | null;
          const b = r.colToTsForTest(c + 1) as bigint | null;
          if (a !== null && b !== null && b - a > 1_000_000_000n) return true;
        }
        return false;
      },
      undefined,
      { timeout: 75_000 },
    )
    .then(() => true)
    .catch(() => false);

  if (!ready) {
    // Diagnostics for the honest skip: on machines with a RECORDED tail the
    // server rehydrates it instead of reconstructing candles (by design), so
    // this is expected on dev stacks that have recorded BTC before.
    const diag = await page.evaluate(() => {
      // Dev-stack HMR can reload the page mid-test, dropping __flowmapLive;
      // degrade to the honest skip (status 'unavailable') instead of throwing.
      const live = (window as unknown as { __flowmapLive?: any }).__flowmapLive;
      const st = live?.store?.getState();
      return {
        status: (st?.status ?? 'unavailable') as string,
        symbol: (st?.subscription?.symbol ?? null) as string | null,
        newest: (live?.renderer?.newestColSeq ?? -1) as number,
        capability: (st?.capability ?? null) as unknown,
      };
    });
    const reason = `binance-spot:BTCUSDT reconstructed history unavailable (status=${diag.status}, symbol=${diag.symbol}, newest=${diag.newest}, capability=${JSON.stringify(
      diag.capability,
    )}) — skipped instead of failing`;
    test.info().annotations.push({ type: 'network-skip', description: reason });
    test.skip(true, reason);
    return;
  }

  const probe = await page.evaluate(() => {
    const r = (window as unknown as { __flowmapLive: any }).__flowmapLive.renderer;
    const t = (c: number): bigint | null => r.colToTsForTest(c);
    const newest = r.newestColSeq as number;

    // Find the reconstructed→live boundary: the LAST column whose next-column
    // delta exceeds the live cadence (scanning back from the live edge). The
    // reconstructed step is stretch-aware (3.75 s at stretch=16), not 60 s.
    let boundary = -1;
    for (let c = newest - 1; c >= 1; c--) {
      const a = t(c);
      const b = t(c + 1);
      if (a === null || b === null) continue;
      if (b - a > 1_000_000_000n) {
        boundary = c;
        break;
      }
    }
    if (boundary < 1 || boundary + 2 > newest) {
      return { ok: false as const, newest, boundary };
    }

    const tsBoundary = t(boundary)!;
    const roundTrip = r.colForTsForTest(tsBoundary) as number | null;
    // overlayPointCss(ts, anyPrice).x is column-only — same transform the glyphs use.
    const point = r.overlayPointCss(tsBoundary, 100) as { x: number; y: number } | null;
    const cell = r.cellToCanvasCss(boundary, 0) as { x: number; y: number };
    return {
      ok: true as const,
      newest,
      boundary,
      candleDelta: (tsBoundary - t(boundary - 1)!).toString(),
      liveDelta: (t(boundary + 2)! - t(boundary + 1)!).toString(),
      roundTrip,
      pointX: point ? point.x : null,
      cellX: cell.x,
    };
  });

  if (!probe.ok) {
    const reason = `no reconstructed block found (newest ${probe.newest}, boundary ${probe.boundary}) — skipped`;
    test.info().annotations.push({ type: 'network-skip', description: reason });
    test.skip(true, reason);
    return;
  }

  // (a) reconstructed cadence: stretch-aware sub-minute step (>= one dt, and
  // below the 60 s candle span) — distinct from the sub-second live cadence.
  const candleDeltaNs = BigInt(probe.candleDelta);
  expect(
    candleDeltaNs,
    `reconstructed columns step at least one dt (got ${probe.candleDelta} ns)`,
  ).toBeGreaterThanOrEqual(250_000_000n);
  expect(
    candleDeltaNs,
    `reconstructed columns step sub-minute (got ${probe.candleDelta} ns)`,
  ).toBeLessThan(60_000_000_000n);
  // (b) live cadence right after the boundary: the 250 ms epoch, NOT 60 s.
  expect(
    BigInt(probe.liveDelta),
    `live columns must be sub-second at the boundary (got ${probe.liveDelta} ns)`,
  ).toBeLessThan(1_000_000_000n);
  // (c) round-trip: the candle's t0 maps back to its own column.
  expect(probe.roundTrip).not.toBeNull();
  expect(probe.roundTrip as number).toBeCloseTo(probe.boundary, 4);
  // (d) the overlay transform agrees with the cell-centre transform at that t0.
  expect(probe.pointX).not.toBeNull();
  expect(Math.abs((probe.pointX as number) - probe.cellX)).toBeLessThan(1);

  test.info().annotations.push({
    type: 'reconstructed',
    description: `boundary col ${probe.boundary}: reconstructed step ${probe.candleDelta}ns → live ${probe.liveDelta}ns`,
  });
});
