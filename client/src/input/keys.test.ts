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

  it('ignores unrelated keys (canvas keeps arrows / F / R / P)', () => {
    for (const k of ['ArrowLeft', 'f', 'R', 'P', '+', '-', 'a']) {
      expect(routeGlobalKey(k, PLAIN)).toBeNull();
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
    expect(classifyTarget(null)).toEqual({ editable: false, button: false, dialog: false });
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
      fire: (key: string, target: Partial<EventTarget> & { tagName?: string }) => {
        const preventDefault = vi.fn();
        handler?.({ key, target, preventDefault } as unknown as Event);
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
});
