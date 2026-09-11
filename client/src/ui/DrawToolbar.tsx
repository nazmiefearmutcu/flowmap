/**
 * DrawToolbar (campaign 3, lane CF) — the vertical drawing-tools panel,
 * ported from the old branch's ui/DrawingToolbar + ColorSwatches + undo/redo
 * keys, re-grounded on the current store architecture.
 *
 * Contents: the 6 tools (select + trendline / h-line / h-ray / rect / fib /
 * text) as icon buttons (inline SVG — zero icon deps), color swatches (the
 * drawing palette; theme-safe fixed hues are the ALLOWED hardcodes — the
 * chrome around them is all CSS vars), a stroke-width stepper, undo / redo,
 * and clear-all (window.confirm-guarded). A swatch sets the style of NEW
 * drawings, and recolors the SELECTED drawing immediately when one exists.
 *
 * VISIBILITY: the panel mounts hidden; `D` toggles it via the module-level
 * {@link toggleDrawToolbar} export (drawings/store.ts). The `D` listener is
 * SELF-CONTAINED here (bare key, editable/dialog guarded via the shared
 * input/keys classifier) — INT must NOT also bind `D` in keys.ts or the
 * toggle would fire twice. If INT later prefers central routing, delete this
 * component's effect and register the key with `toggleDrawToolbar()` as the
 * action.
 *
 * Placement: render inside the chart's position:relative stage viewport (see
 * lane-CF.md MOUNT-SNIPPET-CF); the panel pins itself to the left edge.
 */

import { useEffect } from 'react';

import { classifyTarget } from '../input/keys';
import { toggleDrawToolbar, useDrawingsStore } from '../drawings/store';
import type { DrawingTool } from '../drawings/types';
import '../drawings/drawings.css';

/**
 * The swatch palette. Fixed hexes are the deliberate exception to the
 * theme-var rule: a drawing must keep ITS color across theme switches (it is
 * user-authored content on the canvas, not chrome), and these six hues are
 * CVD-checked against every theme's near-black surface.
 */
const SWATCHES: readonly string[] = [
  '#33d6c4', // teal (theme accent-bright)
  '#f2f6fa', // paper white
  '#fbbf24', // amber (warn)
  '#e8635f', // red (sell-bright)
  '#60a5fa', // blue
  '#c084fc', // violet
];

/** Stroke-width choices (CSS px) the stepper cycles through. */
const WIDTHS: readonly number[] = [1, 2, 4];

/** Order the buttons render in; `select` is the null tool (select mode). */
const TOOLS: readonly { tool: DrawingTool | 'select'; label: string; icon: JSX.Element }[] = [
  { tool: 'select', label: 'Select / move drawings', icon: <path d="M4 2l8 7-4 .5L6.5 14z" /> },
  {
    tool: 'trendline',
    label: 'Trend line',
    icon: (
      <>
        <path d="M3 13L13 3" />
        <circle cx="3" cy="13" r="1.4" className="fill" />
        <circle cx="13" cy="3" r="1.4" className="fill" />
      </>
    ),
  },
  { tool: 'hline', label: 'Horizontal line', icon: <path d="M2 8h12M8 5.5v5" /> },
  { tool: 'hray', label: 'Horizontal ray (extends right)', icon: <path d="M4 8h10M4 5.5v5" /> },
  { tool: 'rect', label: 'Rectangle', icon: <rect x="3" y="4" width="10" height="8" /> },
  {
    tool: 'fib',
    label: 'Fib retracement',
    icon: (
      <>
        <path d="M2 3.5h12" />
        <path d="M2 6.5h12" opacity=".6" />
        <path d="M2 9.5h12" opacity=".6" />
        <path d="M2 12.5h12" />
      </>
    ),
  },
  {
    tool: 'text',
    label: 'Text label',
    icon: <path d="M3 4h10M8 4v9M6 13h4" />,
  },
];

interface DrawToolbarProps {
  /**
   * Persistence scope label for the clear-all confirm (defaults to the
   * store's loaded scope).
   */
  symbol?: string;
}

export function DrawToolbar({ symbol }: DrawToolbarProps): JSX.Element | null {
  const visible = useDrawingsStore((s) => s.toolbarVisible);
  const tool = useDrawingsStore((s) => s.tool);
  const defaultStyle = useDrawingsStore((s) => s.defaultStyle);
  const itemCount = useDrawingsStore((s) => s.items.length);
  const canUndo = useDrawingsStore((s) => s.undoStack.length > 0);
  const canRedo = useDrawingsStore((s) => s.redoStack.length > 0);

  // `D` toggles the panel. Bare key only, and never while typing / in a
  // dialog — the same guards the app's global router applies.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'd' && e.key !== 'D') return;
      const t = classifyTarget(e.target);
      if (t.editable || t.dialog) return;
      e.preventDefault();
      toggleDrawToolbar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!visible) return null;

  const st = useDrawingsStore.getState();
  const scope = symbol ?? (st.symbol !== null ? st.symbol : 'this chart');

  return (
    <div className="draw-toolbar" role="toolbar" aria-label="Drawing tools" data-testid="draw-toolbar">
      {TOOLS.map(({ tool: t, label, icon }) => (
        <button
          key={t}
          type="button"
          className={`draw-toolbar__btn${(t === 'select' ? tool === null : tool === t) ? ' is-active' : ''}`}
          title={label}
          aria-label={label}
          aria-pressed={t === 'select' ? tool === null : tool === t}
          onClick={() => st.armTool(t === 'select' ? null : t)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            {icon}
          </svg>
        </button>
      ))}

      <div className="draw-toolbar__sep" />

      {SWATCHES.map((color) => (
        <button
          key={color}
          type="button"
          className={`draw-toolbar__swatch${defaultStyle.color === color ? ' is-active' : ''}`}
          style={{ background: color }}
          title={`Color ${color}`}
          aria-label={`Drawing color ${color}`}
          aria-pressed={defaultStyle.color === color}
          onClick={() => st.setDefaultStyle({ color })}
        />
      ))}

      <div className="draw-toolbar__sep" />

      <button
        type="button"
        className="draw-toolbar__btn draw-toolbar__btn--wide"
        title={`Stroke width (${defaultStyle.width}px) — click to change`}
        aria-label="Stroke width"
        onClick={() => {
          const i = WIDTHS.indexOf(defaultStyle.width);
          st.setDefaultStyle({ width: WIDTHS[(i + 1) % WIDTHS.length] });
        }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M2 8h12" style={{ strokeWidth: defaultStyle.width }} />
        </svg>
      </button>

      <div className="draw-toolbar__sep" />

      <button
        type="button"
        className="draw-toolbar__btn"
        title="Undo (Ctrl+Z)"
        aria-label="Undo drawing change"
        disabled={!canUndo}
        onClick={() => st.undo()}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M6 3L2.5 6.5 6 10M3 6.5h6a4 4 0 010 8H6" />
        </svg>
      </button>
      <button
        type="button"
        className="draw-toolbar__btn"
        title="Redo (Ctrl+Shift+Z)"
        aria-label="Redo drawing change"
        disabled={!canRedo}
        onClick={() => st.redo()}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M10 3l3.5 3.5L10 10M13 6.5H7a4 4 0 000 8h3" />
        </svg>
      </button>

      <button
        type="button"
        className="draw-toolbar__btn draw-toolbar__btn--danger"
        title={`Clear all drawings on ${scope}`}
        aria-label="Clear all drawings"
        disabled={itemCount === 0}
        onClick={() => {
          const n = useDrawingsStore.getState().items.length;
          if (n > 0 && window.confirm(`Clear all ${n} drawing${n === 1 ? '' : 's'} on ${scope}?`)) {
            useDrawingsStore.getState().clearAll();
          }
        }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.8 8.5h5.4l.8-8.5M6.8 7l.3 4.5M9.2 7l-.3 4.5" />
        </svg>
      </button>
    </div>
  );
}

export { toggleDrawToolbar };
