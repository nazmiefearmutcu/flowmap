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

/** Compact size formatting — integers big, a couple of decimals small, "—" null. */
function fmtSize(v: number | null): string {
  if (v === null) return '—';
  if (v === 0) return '0';
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

function fmtPrice(r: CrosshairReadout): string {
  return r.price === null ? '—' : r.price.toFixed(r.priceDecimals);
}

/** ns → HH:MM:SS.mmm (UTC; sim columns are session-relative so this reads T+). */
function fmtTime(ns: bigint | null): string {
  if (ns === null) return '—';
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toISOString().substring(11, 23);
  } catch {
    return '—';
  }
}

export function Crosshair({ canvasRef, rendererRef }: CrosshairProps): JSX.Element | null {
  const [hover, setHover] = useState<HoverState | null>(null);
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
            <span className="crosshair__val crosshair__val--bid" data-testid="crosshair-bid">
              {fmtSize(readout.bid)}
            </span>
          </div>
          <div className="crosshair__line">
            <span className="crosshair__key crosshair__key--ask">ask</span>
            <span className="crosshair__val crosshair__val--ask" data-testid="crosshair-ask">
              {fmtSize(readout.ask)}
            </span>
          </div>
          {readout.group > 1 && (
            <div className="crosshair__line crosshair__line--dim">
              <span className="crosshair__key">grp</span>
              <span className="crosshair__val" data-testid="crosshair-group">
                {readout.group}×
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
