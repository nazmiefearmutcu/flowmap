/**
 * The renderer's per-session column gate (gl/sessionGate.ts).
 *
 * The bug this pins shut: `Renderer.resetForSession()` tears the GL ring down to
 * null, but the OLD session's columns are still in flight. With no gate the first
 * of them recreates the ring at the PREVIOUS symbol's row count (the store's
 * epoch table was cleared, so `rows` falls back to `col.bid.length`), and then
 * every column of the NEW geometry mismatches the ring and is skipped — forever.
 * Crypto/sim grids are 2048 rows and equity 4096, so crypto→equity was a
 * permanently blank heatmap.
 */

import { describe, expect, it } from 'vitest';

import { planDepthColumn, sessionGateOpen } from './sessionGate';

const CRYPTO_ROWS = 2048;
const EQUITY_ROWS = 4096;

describe('sessionGateOpen', () => {
  it('stays shut while the new session has neither announced itself nor its geometry', () => {
    // connectAndSubscribe() cleared sessionId + epochs; the Hello has not landed.
    expect(sessionGateOpen(null, null, undefined)).toBe(false);
  });

  it('opens the moment the store reports a DIFFERENT, non-null session id', () => {
    expect(sessionGateOpen(null, 'sess-2', undefined)).toBe(true);
    expect(sessionGateOpen('sess-1', 'sess-2', undefined)).toBe(true);
  });

  it('keeps the gate shut while the store still reports the OLD session id', () => {
    expect(sessionGateOpen('sess-1', 'sess-1', undefined)).toBe(false);
  });

  it('also opens on authoritative epoch geometry — the anti-deadlock escape', () => {
    // If the column's epoch is in the store's table, its row count is a FACT and
    // not a guess off bid.length, so there is nothing left to wait for. Without
    // this the gate could latch shut and the renderer would never draw again.
    expect(sessionGateOpen(null, null, EQUITY_ROWS)).toBe(true);
    expect(sessionGateOpen('sess-1', 'sess-1', CRYPTO_ROWS)).toBe(true);
  });
});

describe('planDepthColumn', () => {
  it('drops an unattributable column while the gate is shut', () => {
    // A leftover from the old session: no epoch params, no new Hello. Sizing the
    // ring off its bid.length is exactly how the wrong-geometry ring got built.
    expect(
      planDepthColumn({
        awaitingSession: true,
        epochRows: undefined,
        colRows: CRYPTO_ROWS,
        ringRows: null,
      }),
    ).toEqual({ action: 'drop', reason: 'unattributed' });
  });

  it('creates the ring from AUTHORITATIVE epoch rows once the gate is open', () => {
    expect(
      planDepthColumn({
        awaitingSession: false,
        epochRows: EQUITY_ROWS,
        colRows: EQUITY_ROWS,
        ringRows: null,
      }),
    ).toEqual({ action: 'create', rows: EQUITY_ROWS });
  });

  it('still creates lazily off bid.length when no session switch is pending', () => {
    // The pre-existing path (first-ever column, and the ?perf / ?normalize test
    // harnesses, which push columns with no store epochs at all).
    expect(
      planDepthColumn({
        awaitingSession: false,
        epochRows: undefined,
        colRows: CRYPTO_ROWS,
        ringRows: null,
      }),
    ).toEqual({ action: 'create', rows: CRYPTO_ROWS });
  });

  it('REBUILDS the ring on a row-count change instead of skipping forever', () => {
    // The old code warned and returned here, with nothing left to ever recreate
    // the ring — a blank heatmap for the rest of the session.
    expect(
      planDepthColumn({
        awaitingSession: false,
        epochRows: EQUITY_ROWS,
        colRows: EQUITY_ROWS,
        ringRows: CRYPTO_ROWS,
      }),
    ).toEqual({ action: 'rebuild', rows: EQUITY_ROWS });
  });

  it('writes a column whose geometry matches the ring', () => {
    expect(
      planDepthColumn({
        awaitingSession: false,
        epochRows: CRYPTO_ROWS,
        colRows: CRYPTO_ROWS,
        ringRows: CRYPTO_ROWS,
      }),
    ).toEqual({ action: 'write', rows: CRYPTO_ROWS });
  });

  it('drops a column that disagrees with its OWN epoch params', () => {
    // Self-inconsistent: uploading it would corrupt the texture. Not a geometry
    // change, so it must not trigger a rebuild either.
    expect(
      planDepthColumn({
        awaitingSession: false,
        epochRows: EQUITY_ROWS,
        colRows: CRYPTO_ROWS,
        ringRows: EQUITY_ROWS,
      }),
    ).toEqual({ action: 'drop', reason: 'row-mismatch' });
  });
});

describe('crypto → equity switch (the exposed case)', () => {
  /** Walk a column through the gate exactly as Renderer.onDepthColumn does. */
  function step(
    state: { awaiting: boolean; gateId: string | null; ringRows: number | null },
    storeSessionId: string | null,
    epochRows: number | undefined,
    colRows: number,
  ) {
    if (state.awaiting && sessionGateOpen(state.gateId, storeSessionId, epochRows)) {
      state.awaiting = false;
    }
    const plan = planDepthColumn({
      awaitingSession: state.awaiting,
      epochRows,
      colRows,
      ringRows: state.ringRows,
    });
    if (plan.action === 'create' || plan.action === 'rebuild') state.ringRows = plan.rows;
    return plan;
  }

  it('never sizes the ring off a pre-Hello column of the OLD session', () => {
    // resetForSession(): ring torn down, sessionId + epochs already cleared.
    const state = { awaiting: true, gateId: null as string | null, ringRows: null as number | null };

    // Two 2048-row crypto columns still in flight land first.
    expect(step(state, null, undefined, CRYPTO_ROWS).action).toBe('drop');
    expect(step(state, null, undefined, CRYPTO_ROWS).action).toBe('drop');
    expect(state.ringRows).toBeNull();

    // The equity session's Hello lands: new session id + 4096-row epoch params.
    expect(step(state, 'equity-sess', EQUITY_ROWS, EQUITY_ROWS)).toEqual({
      action: 'create',
      rows: EQUITY_ROWS,
    });
    expect(state.ringRows).toBe(EQUITY_ROWS);
    expect(step(state, 'equity-sess', EQUITY_ROWS, EQUITY_ROWS).action).toBe('write');
  });

  it('self-heals even if a stale column DID build the ring at the old size', () => {
    // Belt and braces: no gate state at all (awaiting already false), a 2048 ring
    // built from a leftover column. The heatmap must still come back.
    const state = { awaiting: false, gateId: null as string | null, ringRows: null as number | null };
    expect(step(state, null, undefined, CRYPTO_ROWS).action).toBe('create');
    expect(state.ringRows).toBe(CRYPTO_ROWS);

    expect(step(state, 'equity-sess', EQUITY_ROWS, EQUITY_ROWS).action).toBe('rebuild');
    expect(state.ringRows).toBe(EQUITY_ROWS);
    expect(step(state, 'equity-sess', EQUITY_ROWS, EQUITY_ROWS).action).toBe('write');
  });
});
