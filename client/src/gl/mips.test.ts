import { describe, expect, it } from 'vitest';

import { COLS_PER_TILE, TileRing } from './tileRing';
import { DOWNSAMPLE_FRAG, mipGroupCols, MipChain } from './mips';
import { GL, makeFakeGL, type FakeGL } from './mockGL';
import type { GLContext } from './context';

/**
 * SUM-mip unit tests over the recording fake GL. Pixels stay the browser e2e's
 * job; these pin the pass PLUMBING (which uniforms the validFrom mask gets for
 * each level) and the FBO-completeness fallback. The ring's gap behavior is
 * pinned in tileRing.test.ts — here a col_seq gap is simulated the same way.
 */

const ROWS = 16;
const LAYERS = 1;

function makeChain(opts: { incompleteFBO?: boolean } = {}): {
  chain: MipChain;
  ring: TileRing;
  gl: FakeGL;
} {
  const gl = makeFakeGL({ colorBufferFloat: true, incompleteFBO: opts.incompleteFBO });
  const ctx: GLContext = {
    gl,
    caps: {
      maxTextureImageUnits: 16,
      maxArrayTextureLayers: 2048,
      maxTextureSize: 8192,
      colorBufferFloat: true,
    },
  };
  const ring = new TileRing(gl, ROWS, LAYERS);
  const chain = new MipChain(ctx, COLS_PER_TILE, ROWS, LAYERS);
  return { chain, ring, gl };
}

function append(ring: TileRing, seq: number): void {
  ring.append(seq, 0, new Float32Array(ROWS), new Float32Array(ROWS), ROWS);
}

/** The u_validFrom / u_groupNewest values of the LAST downsample pass. */
function lastMaskUniforms(gl: FakeGL): { validFrom: number; groupNewest: number } {
  const validFromLocs = gl.callsOf('uniform1i').filter((c) => c.args[0] !== null && (c.args[0] as { uniform?: string }).uniform === 'u_validFrom');
  const groupLocs = gl.callsOf('uniform1i').filter((c) => c.args[0] !== null && (c.args[0] as { uniform?: string }).uniform === 'u_groupNewest');
  const last = <T,>(a: T[]): T | undefined => a[a.length - 1];
  return {
    validFrom: last(validFromLocs)!.args[1] as number,
    groupNewest: last(groupLocs)!.args[1] as number,
  };
}

/** The uniform set of each downsample pass, in draw order (u_rowOnly included). */
function passes(gl: FakeGL): Array<Record<string, number>> {
  const out: Array<Record<string, number>> = [];
  let cur: Record<string, number> = {};
  for (const c of gl.callsOf('uniform1i')) {
    const name = (c.args[0] as { uniform?: string } | null)?.uniform;
    if (name === 'u_src') {
      if (Object.keys(cur).length > 0) out.push(cur);
      cur = {};
    }
    if (name !== undefined) cur[name] = c.args[1] as number;
  }
  if (Object.keys(cur).length > 0) out.push(cur);
  return out;
}

describe('mipGroupCols (the group the SUM covers)', () => {
  it('is the 4 consecutive columns ending at groupNewest', () => {
    expect(mipGroupCols(3)).toEqual([0, 1, 2, 3]);
    expect(mipGroupCols(19)).toEqual([16, 17, 18, 19]);
  });
});

describe('validFrom gating of the downsample (B-2)', () => {
  it('passes the ring validFrom + the appended group into the level-1 pass', () => {
    const { chain, ring, gl } = makeChain();
    for (let s = 0; s <= 3; s++) append(ring, s);
    // A col_seq GAP forward growth: the slots between 3 and 10 still hold the
    // previous session's texels (tileRing.test.ts pins the Residency part).
    for (let s = 10; s <= 11; s++) append(ring, s);
    expect(ring.validFromSeq()).toBe(10);

    // Column 11 completes the group [8..11]: two of its four source columns
    // (8, 9) are pre-gap slots the level-0 path masks away — the pass must get
    // the gate so the SUM masks them too.
    chain.updateFrom(ring, 11);
    expect(mipGroupCols(11).filter((c) => c >= ring.validFromSeq())).toEqual([10, 11]);

    const { validFrom, groupNewest } = lastMaskUniforms(gl);
    expect(validFrom).toBe(10);
    expect(groupNewest).toBe(11);
    // Row-only pass + level-1 pass (11 % 16 !== 15). The row pass runs FIRST
    // (every append) and carries the same validFrom gate for its single column.
    expect(gl.callsOf('drawArrays').length).toBe(2);
    const rowPass = passes(gl).find((p) => p.u_rowOnly === 1);
    expect(rowPass).toBeDefined();
    expect(rowPass!.u_validFrom).toBe(10);
    expect(rowPass!.u_groupNewest).toBe(11);
  });

  it('the shader masks each source column against u_validFrom before summing', () => {
    // The mask itself is GLSL; pin its presence and shape so the sum can never
    // silently regress to the unguarded fetch. gn reconstructs each fragment's
    // group end from u_groupNewest/u_xEnd (single-group passes pass u_xEnd = ox
    // so gn === u_groupNewest exactly).
    expect(DOWNSAMPLE_FRAG).toContain('u_validFrom');
    expect(DOWNSAMPLE_FRAG).toContain('u_groupNewest');
    expect(DOWNSAMPLE_FRAG).toContain('u_xEnd');
    expect(DOWNSAMPLE_FRAG).toMatch(/int\s+gn\s*=\s*u_groupNewest\s*-\s*\(u_xEnd\s*-\s*ox\)\s*\*\s*4/);
    expect(DOWNSAMPLE_FRAG).toMatch(/gn\s*-\s*3\s*\+\s*i\s*>=\s*u_validFrom/);
  });

  it('disables the mask on the level-1 → level-2 pass (source is pre-masked)', () => {
    const { chain, ring, gl } = makeChain();
    for (let s = 0; s <= 15; s++) append(ring, s);
    expect(ring.validFromSeq()).toBe(0);
    // In-tile x0 = 15 → both the level-1 group AND the level-2 group complete.
    chain.updateFrom(ring, 15);
    // Row-only pass + level-1 + level-2 (row first, then the completed groups).
    expect(gl.callsOf('drawArrays').length).toBe(3);
    // The LAST pass (level-2) runs with the gate disabled: tex1 columns were
    // already validFrom-masked when they were built.
    expect(lastMaskUniforms(gl).validFrom).toBe(-0x7fffffff);
  });

  it('skips the level-2 bake while the 16-group straddles a gap boundary (R2 H-1)', () => {
    const { chain, ring, gl } = makeChain();
    for (let s = 0; s <= 5; s++) append(ring, s);
    // Gap: slots 6..49 still hold whatever the previous session left there.
    for (let s = 50; s <= 51; s++) append(ring, s);
    expect(ring.validFromSeq()).toBe(50);

    // Column 63 completes the level-2 group [48..63] — but 48 and 49 are
    // pre-gap slots, and the level-1 columns covering them were masked with
    // the OLD validFrom (0), i.e. they still carry pre-gap data. Baking them
    // would smear the gap into level-2, so the pass must NOT run.
    append(ring, 63);
    chain.updateFrom(ring, 63);
    expect(gl.callsOf('drawArrays').length).toBe(2); // row-only + level-1

    // 16 clean appends later the next group [64..79] is fully post-gap and
    // the level-2 bake resumes.
    for (let s = 64; s <= 79; s++) append(ring, s);
    chain.updateFrom(ring, 79);
    expect(gl.callsOf('drawArrays').length).toBe(5); // row + level-1 + level-2
  });
});

describe('FBO completeness fallback (B-7c)', () => {
  it('an incomplete FBO disables the chain instead of baking broken mips', () => {
    const { chain, ring, gl } = makeChain({ incompleteFBO: true });
    expect(chain.usable).toBe(true);
    append(ring, 3);
    chain.updateFrom(ring, 3); // group complete → the pass finds the FBO broken
    expect(chain.usable).toBe(false);
    expect(gl.callsOf('drawArrays').length).toBe(0);

    // And it stays disabled — no further passes, no throw.
    append(ring, 7);
    expect(() => chain.updateFrom(ring, 7)).not.toThrow();
    expect(gl.callsOf('drawArrays').length).toBe(0);
  });

  it('a complete FBO renders the pass and stays usable', () => {
    const { chain, ring, gl } = makeChain();
    append(ring, 3);
    chain.updateFrom(ring, 3);
    expect(chain.usable).toBe(true);
    const draws = gl.callsOf('drawArrays');
    expect(draws.length).toBe(2); // row-only + level-1
    expect(draws[0].args[0]).toBe(GL.TRIANGLE_STRIP);
    // The default framebuffer is restored so the display draw targets the screen.
    expect(gl.callsOf('bindFramebuffer').at(-1)!.args[1]).toBeNull();
  });
});

describe('updateRange — batched history-page splices (survey #6b)', () => {
  it('bakes a whole aligned 256-column page in ONE pass per level (was ~80 viewports)', () => {
    const { chain, ring, gl } = makeChain();
    for (let s = 0; s < 256; s++) append(ring, s);
    const before = gl.callsOf('drawArrays').length;

    chain.updateRange(ring, 0, 255);

    const draws = gl.callsOf('drawArrays');
    expect(draws.length - before).toBe(3); // one layer: row-only + level-1 + level-2

    const ps = passes(gl);
    expect(ps.length).toBe(3);
    // Row-only first: the WHOLE spliced range in one pass per segment (the
    // row-mip has no 4-alignment), masked with the ring's validFrom.
    expect(ps[0].u_rowOnly).toBe(1);
    expect(ps[0].u_validFrom).toBe(ring.validFromSeq());
    expect(ps[0].u_groupNewest).toBe(255);
    expect(ps[0].u_xEnd).toBe(255); // source columns are 1:1, not /4
    // level-0 → level-1: masked with the ring's validFrom, group end = 255.
    expect(ps[1].u_rowOnly).toBe(0);
    expect(ps[1].u_validFrom).toBe(ring.validFromSeq());
    expect(ps[1].u_groupNewest).toBe(255);
    expect(ps[1].u_xEnd).toBe(63); // last level-1 destination column
    // level-1 → level-2: sources pre-masked at their own build → gate disabled.
    expect(ps[2].u_validFrom).toBe(-0x7fffffff);
    expect(ps[2].u_groupNewest).toBe(255);
    expect(ps[2].u_xEnd).toBe(15);
    // The default framebuffer is restored for the display draw.
    expect(gl.callsOf('bindFramebuffer').at(-1)!.args[1]).toBeNull();
  });

  it('handles a ring wrap: per-level layer segments, every pass within the resident window', () => {
    const { chain, ring, gl } = makeChain();
    // One 256-col layer; a contiguous window that WRAPS the ring capacity.
    for (let s = 240; s <= 300; s++) append(ring, s);
    expect(ring.validFromSeq()).toBe(240);

    chain.updateRange(ring, 240, 300);

    const ps = passes(gl);
    // hi = 300 → b0 = 299 (largest group end ≤ resident newest). Level-1
    // segments cut at ABSOLUTE multiples of 256 (tile-layer edges): [240..255]
    // and [256..299] — two passes; level-2 covers the whole 16-groups
    // [240..255], [256..271], [272..287] in two segment passes ([240..255] and
    // [256..287]). The row-only chain cuts the same way at [240..255] and
    // [256..300] (its own last column IS a group end).
    const row = ps.filter((p) => p.u_rowOnly === 1);
    const level1 = ps.filter((p) => p.u_rowOnly === 0 && p.u_validFrom !== -0x7fffffff);
    const level2 = ps.filter((p) => p.u_validFrom === -0x7fffffff);
    expect(row.length).toBe(2);
    expect(level1.length).toBe(2);
    expect(level2.length).toBe(2);
    for (const p of row) expect(p.u_validFrom).toBe(240);
    for (const p of level1) expect(p.u_validFrom).toBe(240);
    // No pass reads past the resident newest (row ends ≤ newest=300, 4-groups ≤ 299).
    for (const p of ps) expect(p.u_groupNewest).toBeLessThanOrEqual(300);
  });

  it('skips level-2 groups that straddle validFrom (R2 H-1 at range granularity)', () => {
    const { chain, ring, gl } = makeChain();
    for (let s = 0; s <= 5; s++) append(ring, s);
    for (let s = 50; s <= 51; s++) append(ring, s);
    expect(ring.validFromSeq()).toBe(50);

    chain.updateRange(ring, 50, 51);

    // Row-only bakes [50..51]; level-1 bakes the (partially masked) group
    // [48..51]; the first 16-aligned start ≥ max(a0=48, align16(50)=64) is
    // 64 > last start 32 → no level-2.
    const ps = passes(gl);
    expect(ps.length).toBe(2);
    expect(ps[0].u_rowOnly).toBe(1);
    expect(ps[0].u_validFrom).toBe(50);
    expect(ps[0].u_groupNewest).toBe(51);
    expect(ps[1].u_rowOnly).toBe(0);
    expect(ps[1].u_validFrom).toBe(50);
    expect(ps[1].u_groupNewest).toBe(51);
  });

  it('bakes level-2 in the same call once the full 16-group is in range and post-gap', () => {
    const { chain, ring, gl } = makeChain();
    for (let s = 64; s <= 79; s++) append(ring, s);

    chain.updateRange(ring, 64, 79);

    // b0 = 79; row-only [64..79] + level-1 pass [64..79]; 16-group [64..79] is
    // fully inside and fully ≥ validFrom=64 → one level-2 pass in the same call.
    const ps = passes(gl);
    expect(ps.length).toBe(3);
    expect(ps[0].u_rowOnly).toBe(1);
    expect(ps[1].u_validFrom).toBe(64);
    expect(ps[2].u_validFrom).toBe(-0x7fffffff);
    expect(ps[2].u_groupNewest).toBe(79);
  });

  it('is a no-op for degenerate ranges and stays inert after an FBO failure', () => {
    const { chain, ring, gl } = makeChain({ incompleteFBO: true });
    append(ring, 3);
    chain.updateRange(ring, 0, 255);
    expect(chain.usable).toBe(false);
    expect(gl.callsOf('drawArrays').length).toBe(0);

    const ok = makeChain();
    ok.chain.updateRange(ok.ring, 5, 5); // empty ring: no resident rows to bake
    ok.chain.updateRange(ok.ring, 9, 3); // reversed
    expect(ok.gl.callsOf('drawArrays').length).toBe(0);
  });
});

describe('row-only mip chain (R2-M1: decoupled row grouping at deep time zoom)', () => {
  it('writes one row-only column on EVERY append (1xrows/4 viewport, group-aligned by column)', () => {
    const { chain, ring, gl } = makeChain();
    for (let s = 0; s <= 2; s++) append(ring, s);
    chain.updateFrom(ring, 2); // 2 % 4 !== 3 → row-only pass only

    expect(gl.callsOf('drawArrays').length).toBe(1);
    const ps = passes(gl);
    expect(ps.length).toBe(1);
    expect(ps[0].u_rowOnly).toBe(1);
    expect(ps[0].u_validFrom).toBe(0);
    expect(ps[0].u_groupNewest).toBe(2);
    expect(ps[0].u_xEnd).toBe(2); // destination column === source column
    // The pass renders rows/4 destination rows of exactly one column.
    const vp = gl.callsOf('viewport').at(-1)!;
    expect(vp.args).toEqual([2, 0, 1, ROWS / 4]);
  });

  it('masks the single source column against u_validFrom before summing', () => {
    // The mask is GLSL; pin its shape (the SUM path's 4-wide gn formula stays).
    expect(DOWNSAMPLE_FRAG).toContain('uniform int u_rowOnly;');
    expect(DOWNSAMPLE_FRAG).toMatch(/int\s+col\s*=\s*u_groupNewest\s*-\s*\(u_xEnd\s*-\s*ox\)/);
    expect(DOWNSAMPLE_FRAG).toMatch(/if\s*\(col\s*>=\s*u_validFrom\)/);
    expect(DOWNSAMPLE_FRAG).toMatch(/texelFetch\(u_src,\s*ivec3\(ox,\s*by\s*\+\s*j,\s*u_srcLayer\),\s*0\)/);
    // The historical SUM-path mask is untouched.
    expect(DOWNSAMPLE_FRAG).toMatch(/gn\s*-\s*3\s*\+\s*i\s*>=\s*u_validFrom/);
  });

  it('updateRange bakes the whole spliced range per tile-layer segment (no 4-alignment)', () => {
    const { chain, ring, gl } = makeChain();
    for (let s = 0; s <= 10; s++) append(ring, s);

    chain.updateRange(ring, 3, 9); // ragged: fromSeq 3 (not 4-aligned)

    const ps = passes(gl);
    const row = ps.filter((p) => p.u_rowOnly === 1);
    expect(row.length).toBe(1);
    expect(row[0].u_validFrom).toBe(0);
    expect(row[0].u_groupNewest).toBe(9);
    expect(row[0].u_xEnd).toBe(9);
    // level-1, in contrast, bakes the inward-aligned group [0..11]? No: b0 = 7
    // (largest group end ≤ hi=9), a0 = 0 → [0..7].
    const level1 = ps.filter((p) => p.u_rowOnly === 0);
    expect(level1.length).toBe(1);
    expect(level1[0].u_groupNewest).toBe(7);
    expect(level1[0].u_xEnd).toBe(1);
  });

  it('disables the row chain with the shared FBO verdict', () => {
    const { chain, ring } = makeChain({ incompleteFBO: true });
    append(ring, 0);
    chain.updateFrom(ring, 0);
    expect(chain.rowUsable).toBe(false);
    expect(chain.usable).toBe(false);
  });
});
