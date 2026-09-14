import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PointBatch, SolidBatch } from './primitives';
import { GL, makeFakeGL } from '../mockGL';

/**
 * Overlay batch blend-state tests (B-5) over the recording fake GL. The visual
 * fix — premultiplied-alpha over-compositing so translucent overlays cannot
 * double-composite with the page when dst alpha < 1 — is two halves: the
 * blendFuncSeparate STATE (asserted here) and the shaders premultiplying their
 * output (pinned below so state and output cannot drift apart).
 */

const LAST_BLEND = [GL.ONE, GL.ONE_MINUS_SRC_ALPHA, GL.ONE, GL.ONE_MINUS_SRC_ALPHA];

const SOURCE = readFileSync(join(process.cwd(), 'src/gl/overlays/primitives.ts'), 'utf8');

describe('SolidBatch blend state (premultiplied over)', () => {
  it('flushes with blendFuncSeparate(ONE, 1-srcAlpha, ONE, 1-srcAlpha)', () => {
    const gl = makeFakeGL();
    const batch = new SolidBatch(gl);
    batch.begin();
    batch.addTri(0, 0, 1, 0, 0, 1, [1, 0.5, 0.25, 0.5]);
    batch.flush();

    expect(gl.callsOf('blendFuncSeparate').length).toBe(1);
    expect(gl.callsOf('blendFuncSeparate')[0].args).toEqual(LAST_BLEND);
    expect(gl.callsOf('blendFunc').length).toBe(0); // the plain call is gone
    // Blending on, depth off — same discipline as before.
    expect(gl.callsOf('enable').some((c) => c.args[0] === GL.BLEND)).toBe(true);
    expect(gl.callsOf('disable').some((c) => c.args[0] === GL.DEPTH_TEST)).toBe(true);
  });

  it('a flush of zero vertices never touches GL state', () => {
    const gl = makeFakeGL();
    new SolidBatch(gl).flush();
    expect(gl.callsOf('blendFuncSeparate').length).toBe(0);
  });

  it('the solid fragment shader premultiplies rgb by alpha (matches the factors)', () => {
    expect(SOURCE).toMatch(/vec4\(v_color\.rgb \* v_color\.a,\s*v_color\.a\)/);
  });

  it('the point fragment shader premultiplies through its softened alpha', () => {
    expect(SOURCE).toMatch(/vec4\(v_color\.rgb \* a,\s*a\)/);
  });

  it('the point program carries the Bookmap sphere shading (soft fill, rim, gated gloss)', () => {
    // F25: soft spherical fill (core → translucent edge)…
    expect(SOURCE).toMatch(/float fill = mix\(0\.62, 1\.0/);
    // …a darker outer rim…
    expect(SOURCE).toMatch(/RIM_DARKEN/);
    // …and a top-left specular glint gated to dots ≥ ~10 px via the size varying
    // (the 6 px floor dots stay flat), all inside the single POINTS pass.
    expect(SOURCE).toMatch(/out float v_size/);
    expect(SOURCE).toMatch(/smoothstep\(7\.0, 12\.0, v_size\)/);
    expect(SOURCE).toMatch(/mix\(o_color\.rgb, vec3\(a\), 0\.55 \* spec\)/);
    // The glint must stay premultiplied: mixing two premultiplied values with a
    // scalar keeps rgb ≤ a, and the rim darkens after.
    expect(SOURCE).toMatch(/o_color\.rgb \*= \(1\.0 - RIM_DARKEN \* rim\)/);
  });
});

describe('PointBatch blend state (premultiplied over)', () => {
  it('flushes with the same premultiplied blendFuncSeparate', () => {
    const gl = makeFakeGL();
    const batch = new PointBatch(gl);
    batch.begin();
    batch.add(0.5, 0.5, 6, [0.2, 0.4, 0.8, 0.75]);
    batch.flush();

    expect(gl.callsOf('blendFuncSeparate').length).toBe(1);
    expect(gl.callsOf('blendFuncSeparate')[0].args).toEqual(LAST_BLEND);
    expect(gl.callsOf('drawArrays')[0].args[0]).toBe(GL.POINTS);
  });
});
