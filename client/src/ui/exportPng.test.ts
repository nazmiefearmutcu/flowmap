import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadPng, pngFilename, pngStamp, runPngExport } from './exportPng';

/** A fixed local Date: 2026-09-09 14:30:05 (calendar fields, tz-independent). */
const NOW = new Date(2026, 8, 9, 14, 30, 5);

function fakeDoc() {
  const anchors: Array<Record<string, unknown> & { click: ReturnType<typeof vi.fn> }> = [];
  const makeElement = (tag: string) => {
    expect(tag).toBe('a');
    const a = { href: '', download: '', click: vi.fn() };
    anchors.push(a);
    return a;
  };
  return { makeElement, anchors };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pngStamp / pngFilename', () => {
  it('stamps LOCAL time as YYYYMMDD-HHMMSS', () => {
    expect(pngStamp(NOW)).toBe('20260909-143005');
  });

  it('zero-pads single-digit months, days and clock parts', () => {
    expect(pngStamp(new Date(2027, 0, 3, 5, 6, 7))).toBe('20270103-050607');
  });

  it('builds flowmap-<market>-<symbol>-<stamp>.png', () => {
    expect(pngFilename('binance-usdm', 'BTCUSDT', NOW)).toBe(
      'flowmap-binance-usdm-BTCUSDT-20260909-143005.png',
    );
  });
});

describe('downloadPng', () => {
  it('creates an anchor with the data URL + filename and clicks it', () => {
    const { makeElement, anchors } = fakeDoc();
    const a = downloadPng('data:image/png;base64,AAA', 'flowmap-x.png', makeElement);
    expect(a).toBe(anchors[0]);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].href).toBe('data:image/png;base64,AAA');
    expect(anchors[0].download).toBe('flowmap-x.png');
    expect(anchors[0].click).toHaveBeenCalledOnce();
  });
});

describe('runPngExport', () => {
  it('downloads the snapshot under the expected filename and reports success', () => {
    const { makeElement, anchors } = fakeDoc();
    const filename = runPngExport('data:image/png;base64,XYZ', 'sim', 'SIM-DEMO', NOW, makeElement);
    expect(filename).toBe('flowmap-sim-SIM-DEMO-20260909-143005.png');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].download).toBe('flowmap-sim-SIM-DEMO-20260909-143005.png');
    expect(anchors[0].click).toHaveBeenCalledOnce();
  });

  it('refuses a null snapshot with NO anchor and NO download (honest failure)', () => {
    const { makeElement, anchors } = fakeDoc();
    const filename = runPngExport(null, 'sim', 'SIM-DEMO', NOW, makeElement);
    expect(filename).toBeNull();
    expect(anchors).toHaveLength(0);
  });
});
