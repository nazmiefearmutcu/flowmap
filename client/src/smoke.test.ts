import { describe, expect, it } from 'vitest';

// Trivial smoke test so the vitest runner has a deterministic non-empty suite.
// Real proto/view-math tests arrive in later M2 tasks.
describe('smoke', () => {
  it('arithmetic works', () => {
    expect(1 + 1).toBe(2);
  });
});
