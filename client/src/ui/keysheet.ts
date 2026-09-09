/**
 * The keyboard reference, shared by the settings drawer's "Keyboard" section and
 * the `?` shortcuts overlay (A5). One source of truth so the two surfaces can
 * never drift: every entry is a binding that actually exists in code —
 * input/keys.ts (global), input/gestures.ts (canvas focused), and the App-level
 * `?` toggle — no aspirational ones.
 */

export type KeysheetEntry = Readonly<{ keys: string; action: string }>;

export const KEYSHEET: readonly KeysheetEntry[] = [
  { keys: 'Space', action: 'follow live edge · play/pause in replay' },
  { keys: '/', 'action': '⌘K / Ctrl-K — symbol search' },
  { keys: 'E', action: 'export the chart as a PNG download' },
  { keys: '?', action: 'toggle this shortcuts overlay' },
  { keys: '← → ↑ ↓', action: 'pan time / price (chart focused)' },
  { keys: '+ / −', action: 'zoom time (chart focused)' },
  { keys: 'F', action: 'toggle time follow (chart focused)' },
  { keys: 'P', action: 'price track on/off · Shift+P re-fit' },
  { keys: 'R', action: 'return to the live edge' },
  { keys: 'Esc', action: 'close dialogs (search · settings · this overlay)' },
  { keys: 'axis wheel / drag', action: 'price zoom / scale · dbl-click re-fit' },
] as const;

/** Target classification subset needed to judge a help toggle (mirrors input/keys.ts). */
export interface HelpKeyContext {
  /** A text-entry surface: `?` is a legitimate typed character (e.g. in the palette). */
  editable: boolean;
  /** Inside a modal dialog: the dialog owns the keyboard. */
  dialog: boolean;
}

/**
 * Pure routing decision for the `?` shortcuts toggle. `?` is Shift+`/`, so it is
 * handled at the App level next to the global keys — but it must never fire while
 * the user is typing (a '?' typed into search is a search character) or while a
 * dialog is open (the dialog owns Escape and everything else; the overlay itself
 * handles its own Escape).
 */
export function isHelpToggle(key: string, ctx: HelpKeyContext): boolean {
  if (key !== '?') return false;
  if (ctx.editable || ctx.dialog) return false;
  return true;
}
