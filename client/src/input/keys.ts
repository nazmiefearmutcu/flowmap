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
 *   - `F` / `P` / `Shift+P` / `R` → follow-axis keys, global like Space (they
 *     used to be dead unless the chart canvas was focused — survey S4 D3).
 *
 * The canvas keeps its own keys (arrows / +- / F / P / Shift+P / R — see
 * input/gestures) when it is focused, so the follow keys YIELD to it (the target
 * classification carries `canvas`); double-handling them would toggle twice.
 * The routing decision is a pure function ({@link routeGlobalKey}) taking only
 * the key and a small target classification, so it is unit-tested without a DOM.
 */

export type GlobalKeyAction =
  | { type: 'space' }
  | { type: 'focus-search' }
  | { type: 'export-png' }
  | { type: 'toggle-measure' }
  | { type: 'create-alert' }
  | { type: 'toggle-hud' }
  | { type: 'cycle-depth-channel' }
  | { type: 'toggle-follow' }
  | { type: 'toggle-price-follow' }
  | { type: 'price-auto-fit' }
  | { type: 'go-live' };

/** How the event target is classified for routing (computed from the DOM by the caller). */
export interface KeyTargetContext {
  /** A text-entry surface (input/textarea/select/contenteditable): keys pass through. */
  editable: boolean;
  /** A native button / [role=button]: Space must activate it, not the transport. */
  button: boolean;
  /** Inside a modal dialog (settings drawer / palette): bare app shortcuts yield —
   *  Space on a drawer row must never toggle the chart's follow state behind it. */
  dialog: boolean;
  /** The event target is the chart canvas: input/gestures.ts owns the bare keys
   *  there (arrows / +- / F / P / Shift+P / R), so the global router yields the
   *  follow keys to it instead of double-handling a toggle. */
  canvas?: boolean;
}

/** Modifier state relevant to chord shortcuts (⌘K / Ctrl-K) and CapsLock-safe
 *  follow keys (R2-L1: a bare Shift-less 'P' can come from CapsLock, so the
 *  router distinguishes it from a real Shift+P by the modifier flags). */
export interface KeyModifiers {
  meta: boolean;
  ctrl: boolean;
  shift?: boolean;
  alt?: boolean;
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
  // Bare-key shortcuts below all yield when a browser/app chord owns the key:
  // Ctrl+R reload, Ctrl+P print, Ctrl+F find must keep their engine semantics;
  // Alt combos are reserved for the OS/browser (R2-L1).
  if (mods.meta || mods.ctrl || mods.alt) return null;
  // Follow keys (S4 D3): F = toggle time follow, P = toggle price follow,
  // Shift+P = price auto-fit, R = go live. Global like Space (a blurred chart
  // used to make them dead), but never inside an input/dialog (guarded above)
  // and never over the chart canvas, where input/gestures.ts owns them — a
  // double-handled toggle would cancel itself out. Shift is consulted so
  // CapsLock's 'P' cannot masquerade as Shift+P (R2-L1).
  if (key === 'f' || key === 'F' || key === 'p' || key === 'P' || key === 'r' || key === 'R') {
    if (ctx.canvas) return null;
    if (key === 'f' || key === 'F') return { type: 'toggle-follow' };
    if (key === 'p') return { type: 'toggle-price-follow' };
    if (key === 'P' && mods.shift) return { type: 'price-auto-fit' };
    if (key === 'r' || key === 'R') return { type: 'go-live' };
    return { type: 'toggle-price-follow' }; // bare 'P' (e.g. CapsLock) toggles
  }
  // `E` exports the chart as a PNG download. `e` carries no native control
  // semantics (unlike Space on a button), so it is safe to take everywhere the
  // bare shortcuts reach — including a focused chart canvas (gestures.ts only
  // owns arrows / +- / F / P / Shift+P / R and leaves every other bare key to
  // bubble). Chords stay with the browser: the modifier guard above already let
  // Ctrl+E / ⌘E through to the engine, matching gestures.ts's canvas-side guard.
  if (key === 'e' || key === 'E') {
    return { type: 'export-png' };
  }
  // Feature-tool keys (campaign 3). Same discipline as `E`: bare keys only —
  // any modifier leaves the chord to the browser (guard above). Each is consumed
  // by the component that owns the feature (MeasureTool M, PriceAlerts A,
  // PerfHud H, depth-channel cycle C), which routes through THIS function so the
  // editable/dialog guards live in exactly one place.
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
    return { editable: false, button: false, dialog: false, canvas: false };
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
  const canvas = tag === 'CANVAS';
  return { editable, button, dialog, canvas };
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
  /** `F` — toggle TIME follow (live-edge auto-follow). */
  onToggleFollow?: () => void;
  /** `P` — toggle the PRICE axis auto-follow ('off' ↔ 'track'). */
  onTogglePriceFollow?: () => void;
  /** `Shift+P` — restore price AUTO-FIT (same as a gutter double-click). */
  onPriceAutoFit?: () => void;
  /** `R` — go live (re-pin the live edge). */
  onGoLive?: () => void;
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
      shift: e.shiftKey,
      alt: e.altKey,
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
      case 'toggle-follow':
        handlers.onToggleFollow?.();
        break;
      case 'toggle-price-follow':
        handlers.onTogglePriceFollow?.();
        break;
      case 'price-auto-fit':
        handlers.onPriceAutoFit?.();
        break;
      case 'go-live':
        handlers.onGoLive?.();
        break;
      default:
        handlers.onFocusSearch();
    }
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
