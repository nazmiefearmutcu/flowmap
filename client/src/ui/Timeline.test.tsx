/**
 * Timeline transport honesty tests (QA11 H1/H2/M1/M2, F12 lane).
 *
 * The transport pill/readout/controls may describe the CURRENT subscription
 * only after it has ATTACHED (a Hello for it landed + the connection is live).
 * The QA11 repro this locks down: a replay click against a session-capacitated
 * server (close 1013) kept the old pill `REPLAY 1× PLAYING`, printed the dead
 * previous session's span (`00:02:07 / 00:02:07`) and left an enabled, inert
 * pause button over a frozen chart — and the 1003 fallback left a naked
 * `FOLLOWING` over an empty chart with no progress or reason.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Renderer } from '../gl/renderer';
import { useFlowMapStore } from '../state/store';
import { Timeline, transportDisplay } from './Timeline';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 1 s per column keeps the QA11 numbers exact: 127 cols → 00:02:07.000. */
const DT_NS = 1_000_000_000;
const SPAN_COLS = 127;

function fakeTimeline(spanCols = SPAN_COLS) {
  return {
    oldestSeq: 0,
    newestSeq: spanCols,
    viewStartCol: Math.max(0, spanCols - 10),
    viewEndCol: spanCols,
    timeBase: { anchorSeq: 0, anchorT0Ns: 0n, dtNs: DT_NS },
  };
}

function fakeRenderer(spanCols = SPAN_COLS): { following: boolean; timeline: () => ReturnType<typeof fakeTimeline> | null } {
  return { following: true, timeline: () => fakeTimeline(spanCols) };
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(r: ReturnType<typeof fakeRenderer> | null): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <Timeline
        rendererRef={{ current: (r as unknown as Renderer) ?? null }}
        onGoLive={vi.fn()}
      />,
    );
  });
  mounted.push({ container, root });
}

function poll(): void {
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

const q = <T extends Element = Element>(sel: string): T | null =>
  document.body.querySelector<T>(sel);

function setReplay(): void {
  useFlowMapStore.setState({
    subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'replay', band: 'native' },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  useFlowMapStore.setState({
    status: 'idle',
    sessionId: null,
    lastClose: null,
    subscription: null,
    paused: false,
    speed: 1,
  });
});

describe('transportDisplay (pure honesty contract)', () => {
  it('attached wins over everything — only then may the pill describe the clock', () => {
    expect(transportDisplay(true, true, 'live', null)).toBe('attached');
    expect(transportDisplay(true, false, 'live', 1013)).toBe('attached');
  });

  it('idle/closed reads as no-feed for both modes', () => {
    expect(transportDisplay(false, false, 'idle', null)).toBe('no-feed');
    expect(transportDisplay(false, true, 'closed', null)).toBe('no-feed');
  });

  it('a 1013 close on a replay subscription is a REFUSAL, not a generic drop', () => {
    expect(transportDisplay(false, true, 'reconnecting', 1013)).toBe('refused');
    // …but the same code on a LIVE subscription is not a replay refusal.
    expect(transportDisplay(false, false, 'reconnecting', 1013)).toBe('reconnecting');
    // and a plain drop while replaying is not a refusal either.
    expect(transportDisplay(false, true, 'reconnecting', 1006)).toBe('reconnecting');
  });

  it('connecting vs reconnecting follows the connection status', () => {
    expect(transportDisplay(false, true, 'connecting', null)).toBe('connecting');
    expect(transportDisplay(false, false, 'connecting', null)).toBe('connecting');
    expect(transportDisplay(false, false, 'reconnecting', null)).toBe('reconnecting');
  });
});

describe('Timeline attach honesty', () => {
  it('attached replay: pill + readout describe the real replay clock, controls enabled', () => {
    useFlowMapStore.setState({ status: 'live', sessionId: 'sess-1', lastClose: null });
    setReplay();
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('REPLAY 1× PLAYING');
    expect(q('[data-testid="transport-state"]')!.getAttribute('data-transport')).toBe('attached');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:02:07.000 / 00:02:07.000');
    expect((q<HTMLButtonElement>('[data-testid="transport-play"]')!).disabled).toBe(false);
    expect((q<HTMLButtonElement>('[data-testid="speed-cycle"]')!).disabled).toBe(false);
    expect((q<HTMLInputElement>('[data-testid="seek-scrubber"]')!).disabled).toBe(false);
    expect(q('[data-testid="transport-waiting"]')).toBeNull();
    expect(q('[data-testid="transport-progress"]')).toBeNull();
  });

  it('pre-attach replay claim: NO crying "PLAYING" over the previous session frame (QA11 M1)', () => {
    // The exact QA11 shape: the mode toggle ran (sessionId cleared) while the
    // renderer still holds the OLD live session's 127 s extent.
    useFlowMapStore.setState({ status: 'live', sessionId: null, lastClose: null });
    setReplay();
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('REPLAY CONNECTING…');
    expect(q('[data-testid="transport-state"]')!.getAttribute('data-transport')).toBe('connecting');
    // The fabricated 00:02:07 span must NOT render.
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('—');
    expect((q<HTMLButtonElement>('[data-testid="transport-play"]')!).disabled).toBe(true);
    expect((q<HTMLButtonElement>('[data-testid="speed-cycle"]')!).disabled).toBe(true);
    expect((q<HTMLInputElement>('[data-testid="seek-scrubber"]')!).disabled).toBe(true);
    expect(q('[data-testid="transport-progress"]')).not.toBeNull();
    expect(q('[data-testid="transport-waiting"]')!.textContent).toContain('waiting for the feed');
  });

  it('1013 session-cap refusal: honest REFUSED state + reason + muted controls (QA11 H1)', () => {
    useFlowMapStore.setState({
      status: 'reconnecting',
      sessionId: null,
      lastClose: { code: 1013, wasClean: false },
    });
    setReplay();
    render(fakeRenderer());
    poll();
    const pill = q('[data-testid="transport-state"]')!;
    expect(pill.textContent).toBe('REPLAY REFUSED');
    expect(pill.getAttribute('data-transport')).toBe('refused');
    // The reason is surfaced (pill tooltip + waiting line), not just the code.
    expect(pill.getAttribute('title')).toContain('server overloaded');
    expect(q('[data-testid="transport-waiting"]')!.textContent).toContain('server at capacity');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('—');
    expect(q('[data-testid="transport-progress"]')).not.toBeNull();
    expect((q<HTMLButtonElement>('[data-testid="transport-play"]')!).disabled).toBe(true);
    expect((q<HTMLButtonElement>('[data-testid="speed-cycle"]')!).disabled).toBe(true);
    expect((q<HTMLInputElement>('[data-testid="seek-scrubber"]')!).disabled).toBe(true);
  });

  it('1003 fallback while CONNECTING: progress + empty-state, never a fabricated FOLLOWING (QA11 H2)', () => {
    useFlowMapStore.setState({
      status: 'connecting',
      sessionId: null,
      lastClose: { code: 1003, wasClean: false },
      subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'deep' },
    });
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('CONNECTING…');
    expect(q('[data-testid="transport-state"]')!.getAttribute('data-transport')).toBe('connecting');
    // No fabricated 00:00:00.000 — the extent is the dead session's.
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('—');
    expect(q('[data-testid="transport-progress"]')).not.toBeNull();
    expect(q('[data-testid="transport-waiting"]')!.textContent).toContain('waiting for the feed');
    // Live mode: no dead replay chrome at all.
    expect(q('[data-testid="transport-play"]')).toBeNull();
  });

  it('a live drop while reconnecting says RECONNECTING, not FOLLOWING', () => {
    useFlowMapStore.setState({
      status: 'reconnecting',
      sessionId: null,
      lastClose: { code: 1006, wasClean: false },
      subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'deep' },
    });
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('RECONNECTING…');
    expect(q('[data-testid="transport-waiting"]')!.textContent).toContain('connection dropped');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('—');
  });

  it('terminal closed: NO FEED, no progress theatre, no controls', () => {
    useFlowMapStore.setState({
      status: 'closed',
      sessionId: null,
      subscription: { market: 'nosuchmarket', symbol: 'NOSUCH', mode: 'live', band: 'native' },
    });
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('NO FEED');
    expect(q('[data-testid="transport-waiting"]')).toBeNull();
    expect(q('[data-testid="transport-progress"]')).toBeNull();
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('—');
  });

  it('attached live: the pill still speaks about the camera; readout is the extent', () => {
    useFlowMapStore.setState({
      status: 'live',
      sessionId: 'sess-2',
      subscription: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', band: 'native' },
    });
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('FOLLOWING');
    expect(q('[data-testid="time-readout"]')!.textContent).toBe('00:02:07.000');
  });

  it('attached replay while PAUSED: the pill says PAUSED and play is enabled', () => {
    useFlowMapStore.setState({ status: 'live', sessionId: 'sess-3', lastClose: null, paused: true });
    setReplay();
    render(fakeRenderer());
    poll();
    expect(q('[data-testid="transport-state"]')!.textContent).toBe('REPLAY 1× PAUSED');
    const play = q<HTMLButtonElement>('[data-testid="transport-play"]')!;
    expect(play.disabled).toBe(false);
    expect(play.getAttribute('aria-label')).toBe('play');
  });
});
