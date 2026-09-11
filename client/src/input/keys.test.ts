import { describe, expect, it, vi } from 'vitest';

import { attachGlobalKeys, classifyTarget, routeGlobalKey } from './keys';

const PLAIN = { editable: false, button: false, dialog: false };

describe('routeGlobalKey', () => {
  it('routes `/` to focus-search when not typing', () => {
    expect(routeGlobalKey('/', PLAIN)).toEqual({ type: 'focus-search' });
  });

  it('routes Space to the transport when not on a button', () => {
    expect(routeGlobalKey(' ', PLAIN)).toEqual({ type: 'space' });
    expect(routeGlobalKey('Spacebar', PLAIN)).toEqual({ type: 'space' });
  });

  it('never hijacks keys while typing in an editable target', () => {
    expect(routeGlobalKey('/', { ...PLAIN, editable: true })).toBeNull();
    expect(routeGlobalKey(' ', { ...PLAIN, editable: true })).toBeNull();
  });

  it('lets a focused button take its own Space, but still focuses search on `/`', () => {
    expect(routeGlobalKey(' ', { ...PLAIN, button: true })).toBeNull();
    expect(routeGlobalKey('/', { ...PLAIN, button: true })).toEqual({ type: 'focus-search' });
  });

  it('ignores unrelated keys', () => {
    for (const k of ['ArrowLeft', 'ArrowRight', '+', '-', 'x', 'q', 'k']) {
      expect(routeGlobalKey(k, PLAIN)).toBeNull();
    }
  });

  it('routes the follow keys globally (S4 D3: they used to be dead when blurred)', () => {
    expect(routeGlobalKey('f', PLAIN)).toEqual({ type: 'toggle-follow' });
    expect(routeGlobalKey('F', PLAIN)).toEqual({ type: 'toggle-follow' });
    expect(routeGlobalKey('p', PLAIN)).toEqual({ type: 'toggle-price-follow' });
    // Shift+P needs the MODIFIER, not just the shifted character (R2-L1):
    // CapsLock produces 'P' with no shift and must TOGGLE, not auto-fit.
    expect(routeGlobalKey('P', PLAIN, { meta: false, ctrl: false, shift: true })).toEqual({
      type: 'price-auto-fit',
    });
    expect(routeGlobalKey('P', PLAIN)).toEqual({ type: 'toggle-price-follow' });
    expect(routeGlobalKey('r', PLAIN)).toEqual({ type: 'go-live' });
    expect(routeGlobalKey('R', PLAIN)).toEqual({ type: 'go-live' });
    // Alt combos belong to the OS/browser.
    expect(
      routeGlobalKey('P', PLAIN, { meta: false, ctrl: false, shift: true, alt: true }),
    ).toBeNull();
    expect(routeGlobalKey('f', PLAIN, { meta: false, ctrl: false, alt: true })).toBeNull();
  });

  it('yields the follow keys to the chart canvas (gestures.ts owns F/P/Shift+P/R there)', () => {
    const onCanvas = { ...PLAIN, canvas: true };
    for (const k of ['f', 'F', 'p', 'P', 'r', 'R']) {
      expect(routeGlobalKey(k, onCanvas)).toBeNull();
    }
    // Non-follow keys still reach the global router on the canvas: gestures
    // leaves everything else to bubble (pinned below for `e`).
    expect(routeGlobalKey('e', onCanvas)).toEqual({ type: 'export-png' });
  });

  it('never hijacks the follow keys while typing, in a dialog, or with a chord', () => {
    for (const k of ['f', 'p', 'P', 'r']) {
      expect(routeGlobalKey(k, { ...PLAIN, editable: true })).toBeNull();
      expect(routeGlobalKey(k, { ...PLAIN, dialog: true })).toBeNull();
      expect(routeGlobalKey(k, PLAIN, { meta: true, ctrl: false })).toBeNull();
      expect(routeGlobalKey(k.toUpperCase(), PLAIN, { meta: false, ctrl: true })).toBeNull();
    }
  });

  it('routes the bare feature keys M / A / H / C (campaign 3)', () => {
    expect(routeGlobalKey('m', PLAIN)).toEqual({ type: 'toggle-measure' });
    expect(routeGlobalKey('M', PLAIN)).toEqual({ type: 'toggle-measure' });
    expect(routeGlobalKey('a', PLAIN)).toEqual({ type: 'create-alert' });
    expect(routeGlobalKey('A', PLAIN)).toEqual({ type: 'create-alert' });
    expect(routeGlobalKey('h', PLAIN)).toEqual({ type: 'toggle-hud' });
    expect(routeGlobalKey('H', PLAIN)).toEqual({ type: 'toggle-hud' });
    expect(routeGlobalKey('c', PLAIN)).toEqual({ type: 'cycle-depth-channel' });
    expect(routeGlobalKey('C', PLAIN)).toEqual({ type: 'cycle-depth-channel' });
  });

  it('never hijacks the feature keys while typing or inside a dialog', () => {
    for (const k of ['m', 'a', 'h', 'c']) {
      expect(routeGlobalKey(k, { ...PLAIN, editable: true })).toBeNull();
      expect(routeGlobalKey(k, { ...PLAIN, dialog: true })).toBeNull();
      expect(routeGlobalKey(k, PLAIN, { meta: true, ctrl: false })).toBeNull();
      expect(routeGlobalKey(k.toUpperCase(), PLAIN, { meta: false, ctrl: true })).toBeNull();
    }
  });

  it('routes `E` to export-png (bare key; no native button semantics to shadow)', () => {
    expect(routeGlobalKey('e', PLAIN)).toEqual({ type: 'export-png' });
    expect(routeGlobalKey('E', PLAIN)).toEqual({ type: 'export-png' });
  });

  it('`E` still works with the chart canvas focused (a plain target here)', () => {
    // gestures.ts owns arrows / +- / F / P / R on the canvas and leaves every
    // other bare key to bubble up to this router — 'e' among them.
    expect(routeGlobalKey('e', { editable: false, button: false, dialog: false })).toEqual({
      type: 'export-png',
    });
  });

  it('never hijacks `E` while typing or while a dialog owns the keyboard', () => {
    expect(routeGlobalKey('e', { ...PLAIN, editable: true })).toBeNull();
    expect(routeGlobalKey('e', { ...PLAIN, dialog: true })).toBeNull();
  });

  it('yields bare shortcuts to an open modal dialog (Space must not flip chart state behind it)', () => {
    expect(routeGlobalKey(' ', { ...PLAIN, dialog: true })).toBeNull();
    expect(routeGlobalKey('/', { ...PLAIN, dialog: true })).toBeNull();
  });

  it('⌘K still works inside a dialog (explicit chord)', () => {
    expect(routeGlobalKey('k', { ...PLAIN, dialog: true }, { meta: true, ctrl: false })).toEqual({
      type: 'focus-search',
    });
  });

  it('opens search on ⌘K / Ctrl-K, even while typing (an explicit chord)', () => {
    expect(routeGlobalKey('k', PLAIN, { meta: true, ctrl: false })).toEqual({ type: 'focus-search' });
    expect(routeGlobalKey('K', PLAIN, { meta: false, ctrl: true })).toEqual({ type: 'focus-search' });
    expect(routeGlobalKey('k', { ...PLAIN, editable: true }, { meta: true, ctrl: false })).toEqual({
      type: 'focus-search',
    });
    // plain k (no modifier) is not a shortcut
    expect(routeGlobalKey('k', PLAIN)).toBeNull();
  });
});

describe('classifyTarget', () => {
  const el = (tag: string, extra: Record<string, unknown> = {}): EventTarget =>
    ({ tagName: tag, getAttribute: () => null, ...extra }) as unknown as EventTarget;

  it('flags text-entry surfaces as editable', () => {
    expect(classifyTarget(el('INPUT')).editable).toBe(true);
    expect(classifyTarget(el('TEXTAREA')).editable).toBe(true);
    expect(classifyTarget(el('SELECT')).editable).toBe(true);
    expect(classifyTarget(el('DIV', { isContentEditable: true })).editable).toBe(true);
    expect(classifyTarget(el('DIV')).editable).toBe(false);
  });

  it('flags buttons (tag or role)', () => {
    expect(classifyTarget(el('BUTTON')).button).toBe(true);
    expect(
      classifyTarget(el('DIV', { getAttribute: (a: string) => (a === 'role' ? 'button' : null) })).button,
    ).toBe(true);
    expect(classifyTarget(el('CANVAS')).button).toBe(false);
  });

  it('flags targets inside a modal dialog via closest("[role=dialog]")', () => {
    const inDrawer = el('DIV', {
      closest: (sel: string) => (sel === '[role="dialog"]' ? { role: 'dialog' } : null),
    });
    expect(classifyTarget(inDrawer).dialog).toBe(true);
    expect(classifyTarget(el('DIV')).dialog).toBe(false);
  });

  it('tolerates a null / non-element target', () => {
    expect(classifyTarget(null)).toEqual({
      editable: false,
      button: false,
      dialog: false,
      canvas: false,
    });
  });

  it('flags the chart canvas (follow keys yield to input/gestures there)', () => {
    expect(classifyTarget(el('CANVAS')).canvas).toBe(true);
    expect(classifyTarget(el('DIV')).canvas).toBe(false);
  });
});

describe('attachGlobalKeys', () => {
  function fakeTarget() {
    let handler: ((e: Event) => void) | null = null;
    return {
      addEventListener: (_t: string, h: EventListenerOrEventListenerObject) => {
        handler = h as (e: Event) => void;
      },
      removeEventListener: () => {
        handler = null;
      },
      fire: (
        key: string,
        target: Partial<EventTarget> & { tagName?: string },
        extra: Record<string, unknown> = {},
      ) => {
        const preventDefault = vi.fn();
        handler?.({ key, target, preventDefault, ...extra } as unknown as Event);
        return preventDefault;
      },
      get handler() {
        return handler;
      },
    };
  }

  it('invokes onSpace / onFocusSearch and preventDefaults consumed keys', () => {
    const onSpace = vi.fn();
    const onFocusSearch = vi.fn();
    const onExportPng = vi.fn();
    const t = fakeTarget();
    const dispose = attachGlobalKeys({ onSpace, onFocusSearch, onExportPng }, t as never);

    const pd1 = t.fire(' ', { tagName: 'CANVAS', getAttribute: () => null } as never);
    expect(onSpace).toHaveBeenCalledOnce();
    expect(pd1).toHaveBeenCalledOnce();

    const pd2 = t.fire('/', { tagName: 'BODY', getAttribute: () => null } as never);
    expect(onFocusSearch).toHaveBeenCalledOnce();
    expect(pd2).toHaveBeenCalledOnce();

    dispose();
    expect(t.handler).toBeNull();
  });

  it('routes the bare `E` key to onExportPng (the TopBar button shares the handler)', () => {
    const onExportPng = vi.fn();
    const t = fakeTarget();
    const dispose = attachGlobalKeys(
      { onSpace: vi.fn(), onFocusSearch: vi.fn(), onExportPng },
      t as never,
    );

    // The canvas is focused: not editable, not a button, no dialog open.
    const pd = t.fire('e', { tagName: 'CANVAS', getAttribute: () => null } as never);
    expect(onExportPng).toHaveBeenCalledOnce();
    expect(pd).toHaveBeenCalledOnce();

    // Shift+"e" is still just the key 'E' to this router.
    t.fire('E', { tagName: 'CANVAS', getAttribute: () => null } as never);
    expect(onExportPng).toHaveBeenCalledTimes(2);

    dispose();
  });

  it('does not fire while typing in an input', () => {
    const onSpace = vi.fn();
    const onFocusSearch = vi.fn();
    const onExportPng = vi.fn();
    const t = fakeTarget();
    attachGlobalKeys({ onSpace, onFocusSearch, onExportPng }, t as never);

    const pd = t.fire(' ', { tagName: 'INPUT', getAttribute: () => null } as never);
    expect(onSpace).not.toHaveBeenCalled();
    expect(pd).not.toHaveBeenCalled();

    const pdE = t.fire('e', { tagName: 'INPUT', getAttribute: () => null } as never);
    expect(onExportPng).not.toHaveBeenCalled();
    expect(pdE).not.toHaveBeenCalled();
  });

  it('routes feature keys to their optional handlers and no-ops when App does not pass them', () => {
    const onToggleMeasure = vi.fn();
    const onToggleHud = vi.fn();
    const t = fakeTarget();
    const dispose = attachGlobalKeys(
      { onSpace: vi.fn(), onFocusSearch: vi.fn(), onExportPng: vi.fn(), onToggleMeasure, onToggleHud },
      t as never,
    );

    t.fire('m', { tagName: 'CANVAS', getAttribute: () => null } as never);
    expect(onToggleMeasure).toHaveBeenCalledOnce();
    t.fire('H', { tagName: 'CANVAS', getAttribute: () => null } as never);
    expect(onToggleHud).toHaveBeenCalledOnce();

    // `c` and `a` have NO handler here (the owning components self-listen):
    // the key is consumed (prevented) but dispatches nothing.
    const pdC = t.fire('c', { tagName: 'CANVAS', getAttribute: () => null } as never);
    expect(pdC).toHaveBeenCalledOnce();
    t.fire('a', { tagName: 'CANVAS', getAttribute: () => null } as never);

    dispose();
  });

  it('dispatches the follow keys (F / P / Shift+P / R) to their handlers from a blurred target', () => {
    const onToggleFollow = vi.fn();
    const onTogglePriceFollow = vi.fn();
    const onPriceAutoFit = vi.fn();
    const onGoLive = vi.fn();
    const t = fakeTarget();
    const dispose = attachGlobalKeys(
      {
        onSpace: vi.fn(),
        onFocusSearch: vi.fn(),
        onExportPng: vi.fn(),
        onToggleFollow,
        onTogglePriceFollow,
        onPriceAutoFit,
        onGoLive,
      },
      t as never,
    );

    const body = { tagName: 'BODY', getAttribute: () => null } as never;
    const pdF = t.fire('f', body);
    expect(onToggleFollow).toHaveBeenCalledOnce();
    expect(pdF).toHaveBeenCalledOnce();
    t.fire('p', body);
    expect(onTogglePriceFollow).toHaveBeenCalledOnce();
    // CapsLock 'P' (no shift modifier) toggles; a real Shift+P auto-fits.
    t.fire('P', body);
    expect(onTogglePriceFollow).toHaveBeenCalledTimes(2);
    expect(onPriceAutoFit).not.toHaveBeenCalled();
    t.fire('P', body, { shiftKey: true });
    expect(onPriceAutoFit).toHaveBeenCalledOnce();
    t.fire('r', body);
    expect(onGoLive).toHaveBeenCalledOnce();

    // On the chart canvas the router yields: the canvas listener owns them, and
    // a double-handled toggle would cancel itself out.
    const pdCanvas = t.fire('f', { tagName: 'CANVAS', getAttribute: () => null } as never);
    expect(onToggleFollow).toHaveBeenCalledOnce();
    expect(pdCanvas).not.toHaveBeenCalled();

    dispose();
  });
});
