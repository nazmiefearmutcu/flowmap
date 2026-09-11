/**
 * Global (app-level) keyboard routing (§9, T12).
 *
 * App-wide shortcuts that live ABOVE the canvas gestures:
 *   - `Space` → play/pause in replay mode, toggle follow in live mode.
 *   - `/`     → focus the symbol search.
 *   - `E`     → export the chart as a PNG download (ui/exportPng).
 *   - `M`     → toggle the measure tool (ui/MeasureTool).
 *   - `A`     → create a price alert at the crosshair price (ui/PriceAlerts).
 *   - `H`     → toggle the perf-HUD chip (ui/PerfHud).
 *   - `C`     → cycle the depth display channel, contract C2.
 *
 * The canvas keeps its own keys (arrows / +- / F / R — see input/gestures) when it
 * is focused; those are NOT re-handled here, so there is no double-handling. The
 * routing decision is a pure function ({@link routeGlobalKey}) taking only the key
 * and a small target classification, so it is unit-tested without a DOM.
 */

export type GlobalKeyAction =
  | { type: 'space' }
  | { type: 'focus-search' }
  | { type: 'export-png' }
  | { type: 'toggle-measure' }
  | { type: 'create-alert' }
  | { type: 'toggle-hud' }
  | { type: 'cycle-depth-channel' };

/** How the event target is classified for routing (computed from the DOM by the caller). */
export interface KeyTargetContext {
  /** A text-entry surface (input/textarea/select/contenteditable): keys pass through. */
  editable: boolean;
  /** A native button / [role=button]: Space must activate it, not the transport. */
  button: boolean;
  /** Inside a modal dialog (settings drawer / palette): bare app shortcuts yield —
   *  Space on a drawer row must never toggle the chart's follow state behind it. */
  dialog: boolean;
}

/** Modifier state relevant to chord shortcuts (⌘K / Ctrl-K). */
export interface KeyModifiers {
  meta: boolean;
  ctrl: boolean;
}

/**
 * Decide the app action for a key press, or null to let the event proceed
 * normally (typing, canvas gestures, button activation, unhandled keys).
 */
export function routeGlobalKey(
  key: string,
  ctx: KeyTargetContext,
  mods: KeyModifiers = { meta: false, ctrl: false },
): GlobalKeyAction | null {
  // ⌘K / Ctrl-K opens the symbol palette from ANYWHERE — an explicit chord, so it
  // is safe even inside a text field (unlike the bare `/`).
  if ((mods.meta || mods.ctrl) && (key === 'k' || key === 'K')) return { type: 'focus-search' };
  if (ctx.editable) return null; // never hijack plain typing
  if (ctx.dialog) return null; // a modal owns the keyboard while it is open
  if (key === '/') return { type: 'focus-search' };
  if (key === ' ' || key === 'Spacebar') {
    if (ctx.button) return null; // let a focused button take its own Space
    return { type: 'space' };
  }
  // `E` exports the chart as a PNG download. `e` carries no native control
  // semantics (unlike Space on a button), so it is safe to take everywhere the
  // bare shortcuts reach — including a focused chart canvas (gestures.ts only
  // owns arrows / +- / F / P / R and leaves every other bare key to bubble).
  // Chords stay with the browser: Ctrl+E / ⌘E keep their engine semantics,
  // matching gestures.ts's modifier guard on the canvas side.
  if ((key === 'e' || key === 'E') && !mods.meta && !mods.ctrl) {
    return { type: 'export-png' };
  }
  // Feature-tool keys (campaign 3). Same discipline as `E`: bare keys only —
  // any modifier leaves the chord to the browser. Each is consumed by the
  // component that owns the feature (MeasureTool M, PriceAlerts A, PerfHud H,
  // depth-channel cycle C), which routes through THIS function so the
  // editable/dialog guards live in exactly one place.
  if (mods.meta || mods.ctrl) return null;
  if (key === 'm' || key === 'M') return { type: 'toggle-measure' };
  if (key === 'a' || key === 'A') return { type: 'create-alert' };
  if (key === 'h' || key === 'H') return { type: 'toggle-hud' };
  if (key === 'c' || key === 'C') return { type: 'cycle-depth-channel' };
  return null;
}

/** Classify a DOM event target for {@link routeGlobalKey}. */
export function classifyTarget(target: EventTarget | null): KeyTargetContext {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.tagName !== 'string') {
    return { editable: false, button: false, dialog: false };
  }
  const tag = el.tagName.toUpperCase();
  const editable =
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true;
  const button = tag === 'BUTTON' || el.getAttribute?.('role') === 'button';
  const dialog =
    typeof el.closest === 'function' && el.closest('[role="dialog"]') !== null;
  return { editable, button, dialog };
}

export interface GlobalKeyHandlers {
  onSpace: () => void;
  onFocusSearch: () => void;
  /** `E` — export the chart canvas as a PNG download. */
  onExportPng: () => void;
  /** `M` — toggle the measure tool (owned by ui/MeasureTool). */
  onToggleMeasure?: () => void;
  /** `A` — create a price alert at the crosshair (owned by ui/PriceAlerts). */
  onCreateAlert?: () => void;
  /** `H` — toggle the PerfHud chip (owned by ui/PerfHud). */
  onToggleHud?: () => void;
  /** `C` — cycle the depth display channel (contract C2; App-level setting). */
  onCycleDepthChannel?: () => void;
}

/**
 * Attach the global key listener to `target` (default `window`). Returns a
 * disposer. The handler calls preventDefault only when it actually consumes the
 * key, so unrelated shortcuts and typing are untouched. The feature keys
 * (`M`/`A`/`H`/`C`) are optional: components that own them may instead listen
 * for their own action via {@link routeGlobalKey}, in which case App simply
 * does not pass the callback and the routed action is a harmless no-op.
 */
export function attachGlobalKeys(
  handlers: GlobalKeyHandlers,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const action = routeGlobalKey(e.key, classifyTarget(e.target), {
      meta: e.metaKey,
      ctrl: e.ctrlKey,
    });
    if (!action) return;
    e.preventDefault();
    switch (action.type) {
      case 'space':
        handlers.onSpace();
        break;
      case 'export-png':
        handlers.onExportPng();
        break;
      case 'toggle-measure':
        handlers.onToggleMeasure?.();
        break;
      case 'create-alert':
        handlers.onCreateAlert?.();
        break;
      case 'toggle-hud':
        handlers.onToggleHud?.();
        break;
      case 'cycle-depth-channel':
        handlers.onCycleDepthChannel?.();
        break;
      default:
        handlers.onFocusSearch();
    }
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
