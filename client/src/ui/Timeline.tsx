/**
 * Timeline minimap + replay transport (§9 bottom strip, T12).
 *
 * **Mode-gated, deliberately.** The transport used to render a play/pause button
 * plus a six-rung speed ladder plus a scrubber unconditionally, every one of
 * them `disabled` in LIVE — eight dead controls in the mode the user is in
 * almost all the time, which is exactly what made the tool read as confusing.
 * Now:
 *   - LIVE   → one state pill, plus a GO LIVE button that appears ONLY when the
 *              camera has actually been scrolled back off the live edge.
 *   - REPLAY → play/pause + ONE cycling speed button (the 1–100× ladder is
 *              unchanged as the DOMAIN, only its presentation collapses) + the
 *              seek scrubber + the time readout.
 *
 * The pill replaces — rather than adds to — the old minimap LIVE/REPLAY label,
 * and is phrased about the CAMERA (FOLLOWING / SCROLLED BACK), because the top
 * bar's connection chip already owns feed health and a second widget saying
 * "LIVE" in a different sense would make the word meaningless.
 *
 * Right: a minimap of the loaded session extent with the current viewport window
 * marked, and — in replay — a seek scrubber over it. Geometry is polled off the
 * renderer at ≤5 Hz (never per-frame / per-column), so this stays clear of the
 * GL loop and the React high-frequency path; `following` and the behind-readout
 * ride that SAME poll rather than adding a timer.
 */

import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { colsBehind } from '../gl/follow';
import { useFlowMapStore } from '../state/store';
import {
  behindNs,
  formatDurationCoarseNs,
  formatDurationNs,
  fractionOfExtent,
  nextSpeed,
  phaseLabel,
  seekTargetNs,
  transportPhase,
  type TimeExtent,
} from './replay';

/** Minimap poll interval (ms). */
const POLL_MS = 200;

interface MinimapGeom {
  leftPct: number;
  widthPct: number;
  extent: TimeExtent | null;
}

const EMPTY_GEOM: MinimapGeom = { leftPct: 0, widthPct: 100, extent: null };

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

interface TimelineProps {
  rendererRef: RefObject<Renderer | null>;
  /** Return the chart to the live edge and re-arm the persisted follow flags. */
  onGoLive: () => void;
}

export function Timeline({ rendererRef, onGoLive }: TimelineProps): JSX.Element {
  const mode = useFlowMapStore((s) => s.subscription?.mode ?? 'live');
  const paused = useFlowMapStore((s) => s.paused);
  const speed = useFlowMapStore((s) => s.speed);
  const pause = useFlowMapStore((s) => s.pause);
  const resume = useFlowMapStore((s) => s.resume);
  const setSpeed = useFlowMapStore((s) => s.setSpeed);
  const seek = useFlowMapStore((s) => s.seek);

  const [geom, setGeom] = useState<MinimapGeom>(EMPTY_GEOM);
  const [scrub, setScrub] = useState(0); // 0..1000 scrubber position (replay)
  // Camera follow state + how far behind the live edge it sits, from the SAME
  // ≤5 Hz poll as the minimap (a plain boolean getter and a subtraction).
  const [following, setFollowing] = useState(true);
  const [behind, setBehind] = useState('');
  const geomRef = useRef<MinimapGeom>(EMPTY_GEOM);
  const draggingRef = useRef(false); // true while the user actively scrubs
  const seekTimerRef = useRef<number | null>(null); // trailing-throttle handle
  const pendingFracRef = useRef(0); // latest scrub fraction awaiting a seek
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const isReplay = mode === 'replay';

  // ≤5 Hz poll of the renderer's timeline geometry → minimap extent + window box.
  useEffect(() => {
    const id = window.setInterval(() => {
      const r = rendererRef.current;
      const tl = r?.timeline();
      if (r) setFollowing((f) => (f === r.following ? f : r.following));
      if (!tl) {
        if (geomRef.current !== EMPTY_GEOM) {
          geomRef.current = EMPTY_GEOM;
          setGeom(EMPTY_GEOM);
        }
        setBehind((b) => (b === '' ? b : ''));
        return;
      }
      const span = Math.max(1, tl.newestSeq - tl.oldestSeq);
      const leftPct = clamp01((tl.viewStartCol - tl.oldestSeq) / span) * 100;
      const rightPct = clamp01((tl.viewEndCol - tl.oldestSeq) / span) * 100;
      let extent: TimeExtent | null = null;
      let toNs: ((col: number) => bigint) | null = null;
      if (tl.timeBase) {
        const { anchorSeq, anchorT0Ns, dtNs } = tl.timeBase;
        toNs = (col: number): bigint =>
          anchorT0Ns + BigInt(Math.round((col - anchorSeq) * dtNs));
        extent = { startNs: toNs(tl.oldestSeq), endNs: toNs(tl.newestSeq) };
      }
      // How far the right edge trails the newest column, as HH:MM:SS.
      const dtNs = tl.timeBase?.dtNs ?? 0;
      const lag = colsBehind(
        { colOffset: tl.viewStartCol, colScale: tl.viewEndCol - tl.viewStartCol, rowOffset: 0, rowScale: 1 },
        tl.newestSeq,
      );
      const nextBehind = lag > 0 && dtNs > 0 ? formatDurationCoarseNs(behindNs(lag, dtNs)) : '';
      setBehind((b) => (b === nextBehind ? b : nextBehind));
      // Advance the playhead: map the newest column to ns and drive the scrubber
      // from its fraction of the session extent — unless the user is scrubbing.
      // Also self-corrects a stale thumb across session/symbol switches.
      if (extent && toNs && !draggingRef.current) {
        const f = fractionOfExtent(toNs(tl.newestSeq), extent);
        const nv = Math.round(f * 1000);
        setScrub((prev) => (prev === nv ? prev : nv));
      }
      const next: MinimapGeom = {
        leftPct,
        widthPct: Math.max(0.6, rightPct - leftPct),
        extent,
      };
      const prev = geomRef.current;
      // Skip a re-render unless something moved perceptibly.
      if (
        Math.abs(prev.leftPct - next.leftPct) > 0.3 ||
        Math.abs(prev.widthPct - next.widthPct) > 0.3 ||
        (prev.extent === null) !== (next.extent === null)
      ) {
        geomRef.current = next;
        setGeom(next);
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [rendererRef]);

  // Reset the scrub gate on a mode switch, and drop any pending throttled seek.
  // Keyed on `isReplay` — NOT `[]` — because Timeline never unmounts (App renders
  // it unconditionally): a replay→live switch mid-drag would otherwise leak a
  // Seek onto a LIVE subscription and leave draggingRef stuck true, freezing the
  // playhead for the rest of the session.
  useEffect(() => {
    return () => {
      draggingRef.current = false;
      if (seekTimerRef.current !== null) {
        window.clearTimeout(seekTimerRef.current);
        seekTimerRef.current = null;
      }
    };
  }, [isReplay]);

  // Emit a Seek at the given scrubber fraction. Early-return on a null extent so
  // no bogus Seek{0} (1970 epoch) is sent before a session's timebase is known.
  const commitSeek = (fraction: number): void => {
    const extent = geomRef.current.extent;
    if (!extent) return;
    seek(seekTargetNs(fraction, extent));
  };

  // While dragging: immediate thumb feedback (setScrub) but only a trailing,
  // throttled seek so we don't spam the connection with a Seek per input event.
  const onScrub = (e: ChangeEvent<HTMLInputElement>): void => {
    const v = Number(e.target.value);
    setScrub(v);
    draggingRef.current = true;
    pendingFracRef.current = v / 1000;
    if (seekTimerRef.current === null) {
      seekTimerRef.current = window.setTimeout(() => {
        seekTimerRef.current = null;
        commitSeek(pendingFracRef.current);
      }, 120);
    }
  };

  // Pointer/key release: flush any pending throttled seek and release the drag
  // gate so the poll effect resumes driving the playhead.
  const onScrubCommit = (): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (seekTimerRef.current !== null) {
      window.clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
    }
    commitSeek(pendingFracRef.current);
  };

  // Read the speed at CLICK time, not from the render closure, so a fast
  // double-click steps 1→2→5 instead of emitting SetSpeed(2) twice.
  const onCycleSpeed = (e: React.MouseEvent): void => {
    const current = useFlowMapStore.getState().speed;
    setSpeed(nextSpeed(current, e.shiftKey ? -1 : 1));
  };

  // GO LIVE unmounts itself the moment it succeeds, so move focus somewhere
  // sane first or the browser drops it to <body>.
  const onGoLiveClick = (): void => {
    pillRef.current?.focus();
    onGoLive();
    setFollowing(true); // optimistic; the poll confirms within 200 ms
  };

  const extent = geom.extent;
  const durationNs = extent ? extent.endNs - extent.startNs : 0n;
  const positionNs = extent ? seekTargetNs(scrub / 1000, extent) - extent.startNs : 0n;
  const playing = isReplay && !paused;
  const phase = transportPhase(isReplay, paused, following);

  return (
    <footer className="timeline" data-testid="timeline">
      <div className="transport" data-testid="transport">
        {isReplay && (
          <>
            <button
              type="button"
              className={`transport__play${playing ? ' is-playing' : ''}`}
              data-testid="transport-play"
              aria-label={playing ? 'pause' : 'play'}
              aria-pressed={playing}
              title={playing ? 'pause' : 'play'}
              onClick={() => (paused ? resume() : pause())}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <button
              type="button"
              className="speed-cycle"
              data-testid="speed-cycle"
              data-speed={speed}
              aria-label={`replay speed ${speed}×, click to change`}
              title="replay speed — click to step up, shift-click to step down"
              onClick={onCycleSpeed}
            >
              {speed}×
            </button>
          </>
        )}
        {!following && (
          <button
            type="button"
            className="go-live"
            data-testid="go-live"
            title="return the chart to the live edge (R)"
            onClick={onGoLiveClick}
          >
            <span aria-hidden="true">⏭</span> GO LIVE
            {behind && <span className="go-live__behind">−{behind}</span>}
          </button>
        )}
      </div>

      <div className={`minimap${isReplay ? ' minimap--replay' : ''}`}>
        <div className="minimap__label">
          <span
            ref={pillRef}
            tabIndex={-1}
            className={`state-pill state-pill--${phase}`}
            data-testid="transport-state"
          >
            {phaseLabel(phase, speed)}
          </span>
          <span
            className="minimap__readout"
            data-testid="time-readout"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {isReplay
              ? `${formatDurationNs(positionNs)} / ${formatDurationNs(durationNs)}`
              : formatDurationNs(durationNs)}
          </span>
        </div>
        <div className="minimap__track" data-testid="minimap-track">
          <div className="minimap__extent" style={{ left: 0, width: '100%' }} />
          <div
            className="minimap__window"
            data-testid="minimap-window"
            style={{ left: `${geom.leftPct}%`, width: `${geom.widthPct}%` }}
          />
          {isReplay && (
            <input
              type="range"
              className="minimap__scrub"
              min={0}
              max={1000}
              step={1}
              value={scrub}
              data-testid="seek-scrubber"
              aria-label="replay seek"
              onChange={onScrub}
              onPointerUp={onScrubCommit}
              onKeyUp={onScrubCommit}
              onBlur={onScrubCommit}
            />
          )}
        </div>
      </div>
    </footer>
  );
}
