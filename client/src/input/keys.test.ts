import { describe, expect, it, vi } from 'vitest';

import { attachGlobalKeys, classifyTarget, routeGlobalKey } from './keys';

const PLAIN = { editable: false, button: false };

describe('routeGlobalKey', () => {
  it('routes `/` to focus-search when not typing', () => {
    expect(routeGlobalKey('/', PLAIN)).toEqual({ type: 'focus-search' });
  });

  it('routes Space to the transport when not on a button', () => {
    expect(routeGlobalKey(' ', PLAIN)).toEqual({ type: 'space' });
    expect(routeGlobalKey('Spacebar', PLAIN)).toEqual({ type: 'space' });
  });

  it('never hijacks keys while typing in an editable target', () => {
    expect(routeGlobalKey('/', { editable: true, button: false })).toBeNull();
    expect(routeGlobalKey(' ', { editable: true, button: false })).toBeNull();
  });

  it('lets a focused button take its own Space, but still focuses search on `/`', () => {
    expect(routeGlobalKey(' ', { editable: false, button: true })).toBeNull();
    expect(routeGlobalKey('/', { editable: false, button: true })).toEqual({ type: 'focus-search' });
  });

  it('ignores unrelated keys (canvas keeps arrows / F / R)', () => {
    for (const k of ['ArrowLeft', 'f', 'R', '+', '-', 'a']) {
      expect(routeGlobalKey(k, PLAIN)).toBeNull();
    }
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

  it('tolerates a null / non-element target', () => {
    expect(classifyTarget(null)).toEqual({ editable: false, button: false });
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
    const t = fakeTarget();
    const dispose = attachGlobalKeys({ onSpace, onFocusSearch }, t as never);

    const pd1 = t.fire(' ', { tagName: 'CANVAS', getAttribute: () => null } as never);
    expect(onSpace).toHaveBeenCalledOnce();
    expect(pd1).toHaveBeenCalledOnce();

    const pd2 = t.fire('/', { tagName: 'BODY', getAttribute: () => null } as never);
    expect(onFocusSearch).toHaveBeenCalledOnce();
    expect(pd2).toHaveBeenCalledOnce();

    dispose();
    expect(t.handler).toBeNull();
  });

  it('does not fire while typing in an input', () => {
    const onSpace = vi.fn();
    const onFocusSearch = vi.fn();
    const t = fakeTarget();
    attachGlobalKeys({ onSpace, onFocusSearch }, t as never);

    const pd = t.fire(' ', { tagName: 'INPUT', getAttribute: () => null } as never);
    expect(onSpace).not.toHaveBeenCalled();
    expect(pd).not.toHaveBeenCalled();
  });
});
