import { describe, it, expect } from "vite-plus/test";

import { isStableMeta, markStableMeta, metaVariant, stableMeta } from "../meta/meta-cache";

describe("meta-cache", () => {
  it("frozen alone is not stable; stableMeta deep-freezes and marks", () => {
    const frozen = Object.freeze({ crud: { query: ["$limit"] } });
    expect(isStableMeta(frozen)).toBe(false);
    const marked = stableMeta({ crud: { query: ["$limit"] } });
    expect(isStableMeta(marked)).toBe(true);
    expect(Object.isFrozen(marked.crud.query)).toBe(true);
  });

  it("one budget per root envelope across chained layers", () => {
    const root = markStableMeta<Record<string, number>>({ n: 0 });
    const variants = new WeakMap();
    let memoized = 0;
    // 20 × 20 two-layer variants of one envelope: at most 128 are kept.
    for (let a = 0; a < 20; a++) {
      const first = metaVariant(variants, root, `a${a}`, () => ({ a }));
      for (let b = 0; b < 20; b++) {
        const second = metaVariant(variants, first, `b${b}`, () => ({ a, b }));
        if (metaVariant(variants, first, `b${b}`, () => ({ a, b })) === second) memoized++;
      }
    }
    expect(memoized).toBeGreaterThan(0);
    expect(memoized).toBeLessThan(128);
    // an unrelated envelope has its own budget
    const other = markStableMeta<Record<string, number>>({ n: 1 });
    const v = metaVariant(variants, other, "x", () => ({ x: 1 }));
    expect(metaVariant(variants, other, "x", () => ({ x: 2 }))).toBe(v);
  });
});
