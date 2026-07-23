/**
 * Crosshair liquidity readout (§8.3 / §9, M2 T9).
 *
 * A pointer-events-none overlay over the GL canvas: on pointer-move it maps the
 * cursor back through the camera inverse to a `(col_seq, row)` cell (via the
 * renderer's {@link Renderer.probeAt}, which reads the EXACT CPU column cache —
 * never the GPU/mip texels) and draws a thin crosshair line pair plus a compact
 * monospace readout box: session time, price (from the epoch's row→price
 * mapping), and the exact summed bid/ask resting size at that cell. Over a cell
 * with no cached data (deep history not fetched) it shows the price but "—" for
 * size. Trading-terminal look — thin lines, near-black box (see Crosshair.css).
 *
 * It attaches its OWN passive `pointermove` listener to the canvas (it does not
 * wrap or capture the pointer), so the T6 pan/zoom gestures on the same canvas
 * are untouched. Probes are rAF-coalesced (≤ one per frame) so fast mouse motion
 * never storms React.
 */

import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';

import type { CrosshairReadout, Renderer } from '../gl/renderer';
import { getSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { depthTier } from './DomLadder';
import './Crosshair.css';

interface CrosshairProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  rendererRef: MutableRefObject<Renderer | null>;
}

interface HoverState {
  x: number;
  y: number;
  readout: CrosshairReadout | null;
}

/** Thousands-grouped integers for the mid band (1e3..1e4). */
const GROUP = new Intl.NumberFormat('en-US', { useGrouping: true, maximumFractionDigits: 0 });

/**
 * Compact size formatting — integers big, a couple of decimals small, "—" null.
 * A non-finite density is over-range/unusable (e.g. an upstream f16-overflowed
 * SYNTH volume bucket): show the honest over-range glyph, never "Infinity"/"NaN"
 * (mirrors DomLadder's `fmtSz` guard, §7 honesty). Large sizes are thousands-
 * grouped, then K/M-compacted past 10k, keeping the small-size decimal bands.
 */
export function fmtSize(v: number | null): string {
  if (v === null) return '—';
  if (v !== null && !Number.isFinite(v)) return v > 0 ? '∞' : '—';
  if (v === 0) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K`;
  if (v >= 1000) return GROUP.format(Math.round(v));
  if (v >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

function fmtPrice(r: CrosshairReadout): string {
  return r.price === null ? '—' : r.price.toFixed(r.priceDecimals);
}

/**
 * The grouped cell's true price EXTENT, e.g. ` 59488.0–59490.0`.
 *
 * A group of N covers N ROWS, and on a non-uniform price grid that is not
 * `N × step` of price — in the log wings one row can be worth hundreds of ticks.
 * Printing just `N×` there would imply a uniform width the grid does not have,
 * so the real span is shown alongside it. Empty when the extent is unknown or
 * the grid is uniform enough that the span is exactly the obvious one.
 */
function fmtBand(r: CrosshairReadout): string {
  if (r.priceLo === null || r.priceHi === null) return '';
  const d = r.priceDecimals;
  return `  ${r.priceLo.toFixed(d)}–${r.priceHi.toFixed(d)}`;
}

/** ns → HH:MM:SS.mmmz (UTC; the trailing `z` makes the zone explicit). */
export function fmtTime(ns: bigint | null): string {
  if (ns === null) return '—';
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return '—';
  try {
    return `${new Date(ms).toISOString().substring(11, 23)}z`;
  } catch {
    return '—';
  }
}

export function Crosshair({ canvasRef, rendererRef }: CrosshairProps): JSX.Element | null {
  const [hover, setHover] = useState<HoverState | null>(null);
  const capability = useFlowMapStore((s) => s.capability);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (rafRef.current) return; // coalesce to ≤ one probe per frame
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const renderer = rendererRef.current;
        setHover({ x, y, readout: renderer ? renderer.probeAt(x, y) : null });
      });
    };
    const onLeave = (): void => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      setHover(null);
    };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [canvasRef, rendererRef]);

  if (!hover) return null;
  const { x, y, readout } = hover;

  // Depth-source provenance for the readout header (§7 honesty). SYNTH must never
  // read as real — its size values are marked amber alongside the SYNTH tag.
  const bookMode = getSnapshot().book?.mode ?? null;
  const tier = depthTier(capability, bookMode);
  const isSynth = tier === 'SYNTH';
  const sizeSynthCls = isSynth ? ' crosshair__val--synth' : '';

  // Place the readout box near the cursor, flipping away from the near edge.
  const canvas = canvasRef.current;
  const cw = canvas?.clientWidth ?? 0;
  const ch = canvas?.clientHeight ?? 0;
  const flipX = x > cw - 180;
  const flipY = y > ch - 110;
  const boxStyle: React.CSSProperties = {
    left: flipX ? undefined : `${x + 14}px`,
    right: flipX ? `${cw - x + 14}px` : undefined,
    top: flipY ? undefined : `${y + 14}px`,
    bottom: flipY ? `${ch - y + 14}px` : undefined,
  };

  return (
    <div className="crosshair" aria-hidden="true">
      <div className="crosshair__vline" style={{ left: `${x}px` }} />
      <div className="crosshair__hline" style={{ top: `${y}px` }} />
      {readout && (
        <div className="crosshair__box" data-testid="crosshair-readout" style={boxStyle}>
          {tier && (
            <div className="crosshair__line crosshair__line--head">
              <span className="crosshair__key">src</span>
              <span
                className={`crosshair__tag${isSynth ? ' crosshair__tag--synth' : ''}`}
                data-testid="crosshair-src"
              >
                {tier}
              </span>
            </div>
          )}
          <div className="crosshair__line">
            <span className="crosshair__key">t</span>
            <span className="crosshair__val" data-testid="crosshair-time">
              {fmtTime(readout.timeNs)}
            </span>
          </div>
          <div className="crosshair__line">
            <span className="crosshair__key">px</span>
            <span className="crosshair__val crosshair__val--price" data-testid="crosshair-price">
              {fmtPrice(readout)}
            </span>
          </div>
          <div className="crosshair__line">
            <span className="crosshair__key crosshair__key--bid">bid</span>
            <span
              className={`crosshair__val crosshair__val--bid${sizeSynthCls}`}
              data-testid="crosshair-bid"
            >
              {fmtSize(readout.bid)}
            </span>
          </div>
          <div className="crosshair__line">
            <span className="crosshair__key crosshair__key--ask">ask</span>
            <span
              className={`crosshair__val crosshair__val--ask${sizeSynthCls}`}
              data-testid="crosshair-ask"
            >
              {fmtSize(readout.ask)}
            </span>
          </div>
          {readout.group > 1 && (
            <div className="crosshair__line crosshair__line--dim">
              <span className="crosshair__key">grp</span>
              <span className="crosshair__val" data-testid="crosshair-group">
                {readout.group}×{fmtBand(readout)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
