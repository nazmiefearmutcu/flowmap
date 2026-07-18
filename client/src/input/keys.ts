/**
 * Global (app-level) keyboard routing (§9, T12).
 *
 * Two app-wide shortcuts that live ABOVE the canvas gestures:
 *   - `Space` → play/pause in replay mode, toggle follow in live mode.
 *   - `/`     → focus the symbol search.
 *
 * The canvas keeps its own keys (arrows / +- / F / R — see input/gestures) when it
 * is focused; those are NOT re-handled here, so there is no double-handling. The
 * routing decision is a pure function ({@link routeGlobalKey}) taking only the key
 * and a small target classification, so it is unit-tested without a DOM.
 */

export type GlobalKeyAction = { type: 'space' } | { type: 'focus-search' };

/** How the event target is classified for routing (computed from the DOM by the caller). */
export interface KeyTargetContext {
  /** A text-entry surface (input/textarea/select/contenteditable): keys pass through. */
  editable: boolean;
  /** A native button / [role=button]: Space must activate it, not the transport. */
  button: boolean;
}

/**
 * Decide the app action for a key press, or null to let the event proceed
 * normally (typing, canvas gestures, button activation, unhandled keys).
 */
export function routeGlobalKey(key: string, ctx: KeyTargetContext): GlobalKeyAction | null {
  if (ctx.editable) return null; // never hijack typing
  if (key === '/') return { type: 'focus-search' };
  if (key === ' ' || key === 'Spacebar') {
    if (ctx.button) return null; // let a focused button take its own Space
    return { type: 'space' };
  }
  return null;
}

/** Classify a DOM event target for {@link routeGlobalKey}. */
export function classifyTarget(target: EventTarget | null): KeyTargetContext {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.tagName !== 'string') return { editable: false, button: false };
  const tag = el.tagName.toUpperCase();
  const editable =
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true;
  const button = tag === 'BUTTON' || el.getAttribute?.('role') === 'button';
  return { editable, button };
}

export interface GlobalKeyHandlers {
  onSpace: () => void;
  onFocusSearch: () => void;
}

/**
 * Attach the global key listener to `target` (default `window`). Returns a
 * disposer. The handler calls preventDefault only when it actually consumes the
 * key, so unrelated shortcuts and typing are untouched.
 */
export function attachGlobalKeys(
  handlers: GlobalKeyHandlers,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const action = routeGlobalKey(e.key, classifyTarget(e.target));
    if (!action) return;
    e.preventDefault();
    if (action.type === 'space') handlers.onSpace();
    else handlers.onFocusSearch();
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
