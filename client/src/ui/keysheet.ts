/**
 * The keyboard reference, shared by the settings drawer's "Keyboard" section and
 * the `?` shortcuts overlay (A5). One source of truth so the two surfaces can
 * never drift: every entry is a binding that actually exists in code —
 * input/keys.ts (global), input/gestures.ts (canvas focused), the App-level `?`
 * toggle, the theme key (`T`, theme/useTheme.ts), and the self-listened feature
 * keys of the campaign-3 lanes (`D` DrawToolbar, `I` IndicatorPicker, and the
 * drawings edit chords) — no aspirational ones.
 */

export type KeysheetEntry = Readonly<{ keys: string; actionKey: string }>;

export const KEYSHEET: readonly KeysheetEntry[] = [
  { keys: 'Space', actionKey: 'keysheet.space' },
  { keys: '/', actionKey: 'keysheet.slash' },
  { keys: 'E', actionKey: 'keysheet.export' },
  { keys: 'M', actionKey: 'keysheet.measure' },
  { keys: 'A', actionKey: 'keysheet.alert' },
  { keys: 'H', actionKey: 'keysheet.hud' },
  { keys: 'C', actionKey: 'keysheet.channel' },
  { keys: 'T', actionKey: 'keysheet.theme' },
  { keys: 'D', actionKey: 'keysheet.draw' },
  { keys: 'I', actionKey: 'keysheet.indicator' },
  { keys: 'Del', actionKey: 'keysheet.delete' },
  { keys: 'Ctrl+Z', actionKey: 'keysheet.undo' },
  { keys: '?', actionKey: 'keysheet.help' },
  { keys: '← → ↑ ↓', actionKey: 'keysheet.pan' },
  { keys: '+ / −', actionKey: 'keysheet.zoom' },
  { keys: 'F', actionKey: 'keysheet.follow' },
  { keys: 'P', actionKey: 'keysheet.priceTrack' },
  { keys: 'R', actionKey: 'keysheet.liveEdge' },
  { keys: 'Esc', actionKey: 'keysheet.escape' },
  { keys: 'axis wheel / drag', actionKey: 'keysheet.axis' },
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
