/**
 * ui/overlayStack — the ordering that lets window-level Escape handlers close
 * only the TOPMOST modal. `stopPropagation` cannot do this between two
 * listeners on the same window target; every Escape consumer defers to
 * `isTopOverlay` instead.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isTopOverlay, pushOverlay, resetOverlays } from './overlayStack';

afterEach(() => resetOverlays());

describe('overlayStack', () => {
  it('is empty at rest — nothing may claim the top', () => {
    expect(isTopOverlay('settings')).toBe(false);
    expect(isTopOverlay('shortcuts')).toBe(false);
  });

  it('the only open overlay is the top', () => {
    const off = pushOverlay('settings');
    expect(isTopOverlay('settings')).toBe(true);
    expect(isTopOverlay('shortcuts')).toBe(false);
    off();
    expect(isTopOverlay('settings')).toBe(false);
  });

  it('last-mounted wins — an overlay opened above the drawer outranks it', () => {
    const offDrawer = pushOverlay('settings');
    const offHelp = pushOverlay('shortcuts');
    expect(isTopOverlay('shortcuts')).toBe(true);
    expect(isTopOverlay('settings')).toBe(false);
    // Closing the top restores the drawer's claim.
    offHelp();
    expect(isTopOverlay('settings')).toBe(true);
    offDrawer();
  });

  it('pops the right entry when the same id is stacked twice (re-open before close)', () => {
    const off1 = pushOverlay('palette');
    const off2 = pushOverlay('palette');
    off1();
    // lastIndexOf removes the MOST RECENT registration: id2 — the top stays 'palette'.
    expect(isTopOverlay('palette')).toBe(true);
    off2();
    expect(isTopOverlay('palette')).toBe(false);
  });

  it('a foreign id can never claim the top', () => {
    pushOverlay('settings');
    expect(isTopOverlay('palette')).toBe(false);
  });

  // NOTE (QA12 M-1): the drawer's own Escape listener also honors
  // `e.defaultPrevented` for the React-handled palette close; that half of the
  // contract is pinned in SettingsDrawer.test.tsx ("escape ordering").
});
