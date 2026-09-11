/**
 * Theme system barrel (lane CE).
 *
 * Consumers:
 *   - `import { initTheme, attachThemeKey, getCanvasPalette } from './theme'`
 *     — boot (main.tsx), the `T` shortcut (App.tsx), canvas overlay colors.
 *   - `import { useTheme } from './theme'` — React components.
 *   - CSS: themes.css is imported by the boot path (see MOUNT-SNIPPET-CE in
 *     the lane report); it must load AFTER ui/theme.css so theme blocks win
 *     the cascade (they also out-specify `:root`, but keep order tidy).
 */
export {
  CANVAS_VAR_FOR,
  DEFAULT_THEME_ID,
  THEME_IDS,
  THEMES,
  isThemeId,
  nextTheme,
  resolveCanvasPalette,
} from './registry';
export type { CanvasPalette, ThemeId, ThemeMeta } from './registry';
export {
  THEME_STORAGE_KEY,
  attachThemeKey,
  cycleTheme,
  getCanvasPalette,
  getTheme,
  initTheme,
  resetThemeStoreForTest,
  setTheme,
  subscribeTheme,
  useTheme,
} from './useTheme';
