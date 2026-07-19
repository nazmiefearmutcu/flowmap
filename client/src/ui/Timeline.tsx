/**
 * Timeline minimap + replay transport (§9 bottom strip, T12).
 *
 * Left: the replay transport — play/pause, a 1–100× speed ladder, all wired to
 * the store's replay controls (which send `Pause`/`Resume`/`SetSpeed`/`Seek` on
 * the connection). Right: a minimap of the loaded session extent with the current
 * viewport window marked, and — in replay — a seek scrubber over it.
 *
 * In LIVE mode the transport is inert (disabled) and the minimap just tracks the
 * view; in REPLAY mode the transport drives the server's replay clock. The minimap
 * geometry is polled off the renderer at ≤5 Hz (never per-frame / per-column), so
 * this stays clear of the GL loop and the React high-frequency path.
 */

import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { useFlowMapStore } from '../state/store';
import {
  SPEED_STEPS,
  formatDurationNs,
  fractionOfExtent,
  seekTargetNs,
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
}

export function Timeline({ rendererRef }: TimelineProps): JSX.Element {
  const mode = useFlowMapStore((s) => s.subscription?.mode ?? 'live');
  const paused = useFlowMapStore((s) => s.paused);
  const speed = useFlowMapStore((s) => s.speed);
  const pause = useFlowMapStore((s) => s.pause);
  const resume = useFlowMapStore((s) => s.resume);
  const setSpeed = useFlowMapStore((s) => s.setSpeed);
  const seek = useFlowMapStore((s) => s.seek);

  const [geom, setGeom] = useState<MinimapGeom>(EMPTY_GEOM);
  const [scrub, setScrub] = useState(0); // 0..1000 scrubber position (replay)
  const geomRef = useRef<MinimapGeom>(EMPTY_GEOM);
  const draggingRef = useRef(false); // true while the user actively scrubs
  const seekTimerRef = useRef<number | null>(null); // trailing-throttle handle
  const pendingFracRef = useRef(0); // latest scrub fraction awaiting a seek
  const isReplay = mode === 'replay';

  // ≤5 Hz poll of the renderer's timeline geometry → minimap extent + window box.
  useEffect(() => {
    const id = window.setInterval(() => {
      const tl = rendererRef.current?.timeline();
      if (!tl) {
        if (geomRef.current !== EMPTY_GEOM) {
          geomRef.current = EMPTY_GEOM;
          setGeom(EMPTY_GEOM);
        }
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

  // Drop any pending trailing-throttle seek if we unmount mid-drag.
  useEffect(() => {
    return () => {
      if (seekTimerRef.current !== null) {
        window.clearTimeout(seekTimerRef.current);
        seekTimerRef.current = null;
      }
    };
  }, []);

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

  const extent = geom.extent;
  const durationNs = extent ? extent.endNs - extent.startNs : 0n;
  const positionNs = extent ? seekTargetNs(scrub / 1000, extent) - extent.startNs : 0n;
  const playing = isReplay && !paused;

  return (
    <footer className="timeline" data-testid="timeline">
      <div className="transport" data-testid="transport">
        <button
          type="button"
          className={`transport__play${playing ? ' is-playing' : ''}`}
          disabled={!isReplay}
          data-testid="transport-play"
          aria-label={playing ? 'pause' : 'play'}
          aria-pressed={playing}
          title={isReplay ? (playing ? 'pause' : 'play') : 'replay only'}
          onClick={() => (paused ? resume() : pause())}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="speeds" role="group" aria-label="replay speed" data-testid="speeds">
          {SPEED_STEPS.map((s) => (
            <button
              type="button"
              key={s}
              className={`speeds__btn${speed === s ? ' is-on' : ''}`}
              disabled={!isReplay}
              data-testid={`speed-${s}`}
              data-speed={s}
              aria-pressed={speed === s}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <div className={`minimap${isReplay ? ' minimap--replay' : ''}`}>
        <div className="minimap__label">
          <span>SESSION</span>
          <span className={isReplay ? 'is-replay' : 'is-live'}>
            {isReplay ? `REPLAY ${speed}× ${paused ? 'PAUSED' : 'PLAYING'}` : 'LIVE'}
          </span>
        </div>
        <div className="minimap__track" data-testid="minimap-track">
          <div className="minimap__extent" style={{ left: 0, width: '100%' }} />
          <div
            className="minimap__window"
            data-testid="minimap-window"
            style={{ left: `${geom.leftPct}%`, width: `${geom.widthPct}%` }}
          />
          <input
            type="range"
            className="minimap__scrub"
            min={0}
            max={1000}
            step={1}
            value={scrub}
            disabled={!isReplay}
            data-testid="seek-scrubber"
            aria-label="replay seek"
            onChange={onScrub}
            onPointerUp={onScrubCommit}
            onKeyUp={onScrubCommit}
            onBlur={onScrubCommit}
          />
        </div>
        <div
          className="minimap__readout"
          data-testid="time-readout"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {formatDurationNs(positionNs)} / {formatDurationNs(durationNs)}
        </div>
      </div>
    </footer>
  );
}
