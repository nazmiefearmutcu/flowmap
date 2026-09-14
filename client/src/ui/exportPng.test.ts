/**
 * Export composition tests (QA13 H1+H2, F11): the exported PNG must carry the
 * WHOLE chart — GL heat + 2D ink + both gutters + legend chips + provenance —
 * at native DPR, and the honest null path must still refuse a download.
 *
 * jsdom has no 2D canvas, so the composition runs against a recording 2D mock
 * (like gl/textLayer.test.ts) and fake layer canvases; the live bitmaps are
 * proven in the swarm kit (swarm2/F11-*.json).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_EXPORT_CHROME,
  collectExportLayers,
  composeExportLayers,
  downloadPng,
  exportProvenanceNotes,
  exportRampStops,
  pngDisplayStamp,
  pngFilename,
  pngStamp,
  runPngExport,
  type ExportLayers,
} from './exportPng';
import { RAMP_FLOW } from '../gl/lut';

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

interface Rec {
  op: string;
  args: unknown[];
}

/** Recording 2D context: every draw op lands in `calls` (deterministic widths). */
function recording2d(): CanvasRenderingContext2D & { calls: Rec[] } {
  const calls: Rec[] = [];
  const push = (op: string) => (...args: unknown[]) => calls.push({ op, args });
  const ctx = {
    calls,
    font: '',
    fillStyle: '' as unknown,
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    setTransform: push('setTransform'),
    fillRect: push('fillRect'),
    strokeRect: push('strokeRect'),
    beginPath: push('beginPath'),
    moveTo: push('moveTo'),
    lineTo: push('lineTo'),
    stroke: push('stroke'),
    arc: push('arc'),
    fill: push('fill'),
    drawImage: push('drawImage'),
    fillText: push('fillText'),
    createLinearGradient: (...args: unknown[]) => {
      calls.push({ op: 'createLinearGradient', args });
      return {
        addColorStop: (t: number, c: string) => calls.push({ op: 'addColorStop', args: [t, c] }),
      };
    },
    measureText: (s: string) => ({ width: s.length * 6 }),
  };
  return ctx as unknown as CanvasRenderingContext2D & { calls: Rec[] };
}

/** The composed output canvas (factory seam) + its recording context. */
function fakeOutCanvas() {
  const ctx = recording2d();
  const canvas = {
    width: 0,
    height: 0,
    getContext: (id: string) => (id === '2d' ? ctx : null),
    toDataURL: (_t: string) => 'data:image/png;base64,COMPOSED',
  } as unknown as HTMLCanvasElement;
  return { canvas, ctx };
}

/** A layer stand-in: only width/height/clientWidth are read. */
function layer(w: number, h: number, cw = w): HTMLCanvasElement {
  return { width: w, height: h, clientWidth: cw, clientHeight: h } as unknown as HTMLCanvasElement;
}

function texts(ctx: ReturnType<typeof recording2d>): string[] {
  return ctx.calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
}

afterEach(() => {
  document.body.innerHTML = '';
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

  it('the footer display stamp is the same instant, readable', () => {
    expect(pngDisplayStamp(NOW)).toBe('2026-09-09 14:30:05');
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

describe('exportProvenanceNotes', () => {
  it('is empty for a plain live, reconstructed-free state', () => {
    expect(exportProvenanceNotes({ following: true, mode: 'live', capability: { depth: 'L2', tape: 'tick' } })).toEqual([]);
  });

  it('flags scrolled-back, replay, reconstructed history, synth depth and aggregated tape', () => {
    expect(
      exportProvenanceNotes({
        following: false,
        mode: 'replay',
        capability: { depth: 'SYNTH_CL', tape: 'agg', history: 'reconstructed' },
      }),
    ).toEqual(['replay', 'scrolled back', 'history ≈ reconstructed', 'synthetic depth', 'tape agg']);
  });
});

describe('exportRampStops', () => {
  it('parses the shared CSS gradient into canvas stops (endpoints intact)', () => {
    const stops = exportRampStops(RAMP_FLOW);
    expect(stops.length).toBeGreaterThan(4);
    expect(stops[0]).toEqual({ css: 'rgb(5, 8, 14)', t: 0 });
    expect(stops[stops.length - 1]).toEqual({ css: 'rgb(255, 225, 90)', t: 1 });
  });
});

describe('composeExportLayers', () => {
  const baseLayers = (): ExportLayers => ({
    gl: layer(1118, 672),
    ink: layer(1118, 672),
    priceAxis: layer(61, 672),
    timeAxis: layer(1118, 21),
  });

  it('composes at GL + gutters + footer size and pastes every layer 1:1', () => {
    const { canvas, ctx } = fakeOutCanvas();
    const layers = baseLayers();
    const out = composeExportLayers(layers, {
      createCanvas: () => canvas,
      meta: { market: 'sim', symbol: 'SIM-DEMO', mode: 'live', at: NOW },
      notes: ['scrolled back'],
      legend: { colormap: 'theme', tier: 'L2' },
    });
    expect(out).toBe(canvas);
    // 1118 + 61 wide; 672 + 21 + 20 (footer, DPR1) high.
    expect(canvas.width).toBe(1179);
    expect(canvas.height).toBe(713);
    const draws = ctx.calls.filter((c) => c.op === 'drawImage');
    expect(draws.map((c) => c.args)).toEqual([
      [layers.gl, 0, 0],
      [layers.ink, 0, 0],
      [layers.priceAxis, 1118, 0],
      [layers.timeAxis, 0, 672],
    ]);
  });

  it('draws the price-family legend chip, the ramp chip and the provenance footer', () => {
    const { canvas, ctx } = fakeOutCanvas();
    composeExportLayers(baseLayers(), {
      createCanvas: () => canvas,
      meta: { market: 'binance-spot', symbol: 'BTCUSDT', mode: 'live', at: NOW },
      notes: ['history ≈ reconstructed'],
      legend: { colormap: 'theme', tier: 'L2' },
    });
    const t = texts(ctx);
    for (const label of ['Last price', 'VWAP', 'BBO', 'Trades', 'more', 'less', 'L2']) {
      expect(t).toContain(label);
    }
    expect(t).toContain('flowmap · binance-spot:BTCUSDT · live · 2026-09-09 14:30:05');
    expect(t).toContain('history ≈ reconstructed');
    // The ramp chip paints a real gradient from the shared stop list.
    const stops = ctx.calls.filter((c) => c.op === 'addColorStop');
    expect(stops.length).toBeGreaterThan(4);
  });

  it('keeps the footer honest when there is no meta (notes only)', () => {
    const { canvas, ctx } = fakeOutCanvas();
    const out = composeExportLayers(baseLayers(), {
      createCanvas: () => canvas,
      notes: ['scrolled back'],
    });
    expect(out?.height).toBe(672 + 21 + 20);
    expect(texts(ctx)).toContain('scrolled back');
  });

  it('is DPR2-native: every size doubles and the pastes stay 1:1', () => {
    const { canvas, ctx } = fakeOutCanvas();
    const layers: ExportLayers = {
      gl: layer(2236, 1344, 1118),
      ink: layer(2236, 1344, 1118),
      priceAxis: layer(122, 1344, 61),
      timeAxis: layer(2236, 42, 1118),
    };
    const out = composeExportLayers(layers, {
      createCanvas: () => canvas,
      meta: { market: 'sim', symbol: 'SIM-DEMO', mode: 'live', at: NOW },
      legend: { colormap: 'flow' },
    });
    expect(out?.width).toBe(2236 + 122);
    expect(out?.height).toBe(1344 + 42 + 40); // footer scales to 20 * 2
    const draws = ctx.calls.filter((c) => c.op === 'drawImage');
    expect(draws.map((c) => c.args)).toEqual([
      [layers.gl, 0, 0],
      [layers.ink, 0, 0],
      [layers.priceAxis, 2236, 0],
      [layers.timeAxis, 0, 1344],
    ]);
  });

  it('refuses to compose without a GL layer or a 2D context (honest null)', () => {
    expect(composeExportLayers(null)).toBeNull();
    expect(composeExportLayers({ gl: layer(0, 0) })).toBeNull();
    const { canvas } = fakeOutCanvas();
    (canvas as unknown as { getContext: (id: string) => null }).getContext = () => null;
    expect(composeExportLayers(baseLayers(), { createCanvas: () => canvas })).toBeNull();
  });

  it('defaults the chrome to the midnight chart-island literals', () => {
    const { canvas } = fakeOutCanvas();
    const out = composeExportLayers(baseLayers(), { createCanvas: () => canvas });
    expect(out).not.toBeNull();
    expect(DEFAULT_EXPORT_CHROME.gutterBg).toBe('#0e121a');
    expect(DEFAULT_EXPORT_CHROME.chartBg).toBe('#05080e');
  });
});

describe('collectExportLayers', () => {
  function installDom(): void {
    document.body.innerHTML = `
      <div class="stage__viewport">
        <canvas id="gl" class="gl-canvas"></canvas>
        <canvas class="overlay-text"></canvas>
      </div>
      <div class="price-axis"><canvas class="axis-canvas"></canvas></div>
      <div class="time-axis"><canvas class="axis-canvas"></canvas></div>`;
  }

  it('forces the frame through snapshot() and gathers the four layer canvases', () => {
    installDom();
    const renderer = { snapshot: vi.fn(() => 'data:image/png;base64,GL') };
    const layers = collectExportLayers(renderer, document);
    expect(renderer.snapshot).toHaveBeenCalledOnce();
    expect(layers?.gl).toBe(document.getElementById('gl'));
    expect(layers?.ink).toBe(document.querySelector('.overlay-text'));
    expect(layers?.priceAxis).toBe(document.querySelector('.price-axis canvas'));
    expect(layers?.timeAxis).toBe(document.querySelector('.time-axis canvas'));
  });

  it('returns null on a lost GL context (snapshot null) — no fake success', () => {
    installDom();
    const renderer = { snapshot: vi.fn(() => null) };
    expect(collectExportLayers(renderer, document)).toBeNull();
  });

  it('returns null without a renderer, a document or a GL canvas', () => {
    expect(collectExportLayers(null, document)).toBeNull();
    expect(collectExportLayers({ snapshot: () => 'x' }, null)).toBeNull();
    expect(collectExportLayers({ snapshot: () => 'x' }, document)).toBeNull(); // empty body
  });
});

describe('runPngExport', () => {
  it('keeps the raw-snapshot string path (legacy/fallback)', () => {
    const { makeElement, anchors } = fakeDoc();
    const filename = runPngExport('data:image/png;base64,XYZ', 'sim', 'SIM-DEMO', NOW, makeElement);
    expect(filename).toBe('flowmap-sim-SIM-DEMO-20260909-143005.png');
    expect(anchors[0].download).toBe('flowmap-sim-SIM-DEMO-20260909-143005.png');
    expect(anchors[0].click).toHaveBeenCalledOnce();
  });

  it('composes gathered layers, then downloads the composed bitmap', () => {
    const { makeElement, anchors } = fakeDoc();
    const { canvas } = fakeOutCanvas();
    const layers: ExportLayers = {
      gl: layer(1118, 672),
      priceAxis: layer(61, 672),
      timeAxis: layer(1118, 21),
    };
    const filename = runPngExport(layers, 'sim', 'SIM-DEMO', NOW, makeElement, {
      createCanvas: () => canvas,
      notes: ['scrolled back'],
      legend: { colormap: 'theme', tier: 'L2' },
    });
    expect(filename).toBe('flowmap-sim-SIM-DEMO-20260909-143005.png');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].href).toBe('data:image/png;base64,COMPOSED');
    expect(anchors[0].download).toBe('flowmap-sim-SIM-DEMO-20260909-143005.png');
    expect(anchors[0].click).toHaveBeenCalledOnce();
  });

  it('refuses a null snapshot with NO anchor and NO download (honest failure)', () => {
    const { makeElement, anchors } = fakeDoc();
    const filename = runPngExport(null, 'sim', 'SIM-DEMO', NOW, makeElement);
    expect(filename).toBeNull();
    expect(anchors).toHaveLength(0);
  });

  it('refuses when composition yields nothing (no anchor)', () => {
    const { makeElement, anchors } = fakeDoc();
    const filename = runPngExport({ gl: layer(0, 0) }, 'sim', 'SIM-DEMO', NOW, makeElement);
    expect(filename).toBeNull();
    expect(anchors).toHaveLength(0);
  });
});
