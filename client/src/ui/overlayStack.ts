/**
 * A last-mounted-wins registry of the open modal surfaces (settings drawer,
 * `?` shortcuts overlay, symbol palette). Window-level Escape handlers consult
 * it so one keystroke closes only the TOP surface: `stopPropagation` cannot do
 * that between two listeners on the SAME window target (it gates propagation to
 * other NODES, never sibling listeners), so without an ordering the drawer and
 * the overlay both slammed shut on a single Escape.
 *
 * Membership follows mount order (each overlay pushes in its open-effect and
 * pops in the cleanup), which is exactly the visual z-order React portals give.
 * Pure and dependency-free so the ordering rules are unit-testable.
 *
 * SECOND half of the contract (QA12 M-1): the stack alone cannot order a
 * surface that closes itself inside its own REACT keydown handler (the symbol
 * palette): React 18 flushes that discrete update — including the effect
 * cleanup that pops this stack — before the same native event reaches the
 * drawer's window listener. Such a handler must `preventDefault()` the
 * keystroke (symbol palette and `?` overlay already do), and window-level
 * handlers below the top must ignore `e.defaultPrevented` — see
 * SettingsDrawer's Escape listener. Window-listener-only surfaces need no
 * flag: they run in registration order, so the lower one always sees the
 * later-pushed entry still on the stack.
 */

const stack: string[] = [];

/**
 * Register an open overlay. Returns the deregister function — call it from the
 * effect cleanup so closing (even unmount-during-close) restores the previous
 * top.
 */
export function pushOverlay(id: string): () => void {
  stack.push(id);
  return () => {
    const i = stack.lastIndexOf(id);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** True when `id` is the topmost open overlay — only it may act on a global key. */
export function isTopOverlay(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** Test seam: force-clear (a real app pops via effect cleanup, LIFO). */
export function resetOverlays(): void {
  stack.length = 0;
}
