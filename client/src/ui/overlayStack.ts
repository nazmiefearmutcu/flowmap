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
