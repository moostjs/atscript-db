import { describe, it, expect } from "vite-plus/test";

import { sortRows, projectRow } from "../index";

/**
 * These exercise the pure engine functions DIRECTLY (they became independently
 * testable only once extracted from `MemoryAdapter`). Each test name states the
 * invariant it encodes. Step 2 (moost-db value-help) reuses exactly these.
 */

describe("sortRows", () => {
  it("no $sort returns the SAME input array reference unchanged (fast path)", () => {
    const rows = [{ a: 3 }, { a: 1 }, { a: 2 }];
    expect(sortRows(rows)).toBe(rows);
    expect(sortRows(rows, {})).toBe(rows);
  });

  it("does NOT mutate the input array (sorting yields a fresh array)", () => {
    const rows = [{ a: 3 }, { a: 1 }, { a: 2 }];
    const snapshot = [...rows];
    const out = sortRows(rows, { a: 1 });
    expect(out).not.toBe(rows);
    expect(rows).toEqual(snapshot); // input order preserved
    expect(out.map((r) => r.a)).toEqual([1, 2, 3]);
  });

  it("sorts a single key ascending (1) and descending (-1)", () => {
    const rows = [{ a: 2 }, { a: 3 }, { a: 1 }];
    expect(sortRows(rows, { a: 1 }).map((r) => r.a)).toEqual([1, 2, 3]);
    expect(sortRows(rows, { a: -1 }).map((r) => r.a)).toEqual([3, 2, 1]);
  });

  it("applies keys in order for a multi-key sort (first key dominates, second breaks ties)", () => {
    const rows = [
      { g: "b", n: 1 },
      { g: "a", n: 2 },
      { g: "b", n: 0 },
      { g: "a", n: 1 },
    ];
    const out = sortRows(rows, { g: 1, n: -1 });
    expect(out).toEqual([
      { g: "a", n: 2 },
      { g: "a", n: 1 },
      { g: "b", n: 1 },
      { g: "b", n: 0 },
    ]);
  });

  it("sorts null/undefined LOW (before any concrete value)", () => {
    const rows = [{ a: 5 }, { a: null }, { a: 2 }, {}]; // {} → a is undefined
    const out = sortRows(rows, { a: 1 }).map((r) => r.a);
    // both nil values sort first (equal to each other), then 2, then 5
    expect(out.slice(2)).toEqual([2, 5]);
    expect(out[0] == null).toBe(true);
    expect(out[1] == null).toBe(true);
  });

  it("orders Date values by their instant, not by identity", () => {
    const rows = [
      { at: new Date("2020-06-01T00:00:00Z") },
      { at: new Date("2020-01-01T00:00:00Z") },
      { at: new Date("2020-03-01T00:00:00Z") },
    ];
    const out = sortRows(rows, { at: 1 }).map((r) => (r.at as Date).toISOString());
    expect(out).toEqual([
      "2020-01-01T00:00:00.000Z",
      "2020-03-01T00:00:00.000Z",
      "2020-06-01T00:00:00.000Z",
    ]);
  });

  it("without a tieBreak, preserves INPUT ORDER among rows with equal sort keys (stable)", () => {
    const rows = [
      { a: 1, tag: "first" },
      { a: 1, tag: "second" },
      { a: 1, tag: "third" },
    ];
    const out = sortRows(rows, { a: 1 }).map((r) => r.tag);
    expect(out).toEqual(["first", "second", "third"]);
  });

  it("uses tieBreak as the FINAL total-order key when sort keys are equal", () => {
    const rows = [
      { a: 1, id: "z" },
      { a: 1, id: "a" },
      { a: 1, id: "m" },
    ];
    // tieBreak by id → deterministic order regardless of input order
    const out = sortRows(rows, { a: 1 }, (r) => r.id as string).map((r) => r.id);
    expect(out).toEqual(["a", "m", "z"]);
  });
});

describe("projectRow", () => {
  it("no projection returns the whole row; clone:true severs reference to input", () => {
    const row = { a: 1, nested: { x: 1 } };
    const same = projectRow(row);
    expect(same).toBe(row); // clone defaults to false → same reference

    const cloned = projectRow(row, undefined, { clone: true });
    expect(cloned).toEqual(row);
    expect(cloned).not.toBe(row);
    (cloned.nested as { x: number }).x = 99;
    expect((row.nested as { x: number }).x).toBe(1); // input untouched
  });

  it("empty projection map is treated as no projection (whole row)", () => {
    const row = { a: 1, b: 2 };
    expect(projectRow(row, {})).toEqual({ a: 1, b: 2 });
  });

  it("inclusion keeps ONLY selected paths and omits absent ones", () => {
    const row = { a: 1, b: 2, c: 3 };
    expect(projectRow(row, { a: 1, missing: 1 })).toEqual({ a: 1 });
  });

  it("inclusion keeps a present-null value but omits an absent field", () => {
    const row = { a: null, b: 2 };
    // a present but null → kept; c absent → omitted
    expect(projectRow(row, { a: 1, c: 1 })).toEqual({ a: null });
  });

  it("inclusion adds pkFields even when they were not selected", () => {
    const row = { id: 7, a: 1, b: 2 };
    expect(projectRow(row, { a: 1 }, { pkFields: ["id"] })).toEqual({ id: 7, a: 1 });
  });

  it("inclusion supports nested dot-paths, rebuilding only the selected subtree", () => {
    const row = { profile: { city: "NYC", zip: "10001" }, name: "N" };
    expect(projectRow(row, { "profile.city": 1 })).toEqual({ profile: { city: "NYC" } });
  });

  it("exclusion drops the selected top-level paths and keeps the rest", () => {
    const row = { a: 1, b: 2, c: 3 };
    expect(projectRow(row, { b: 0 })).toEqual({ a: 1, c: 3 });
  });

  it("exclusion supports nested dot-paths, dropping only the targeted leaf", () => {
    const row = { profile: { city: "NYC", zip: "10001" }, name: "N" };
    expect(projectRow(row, { "profile.zip": 0 })).toEqual({
      profile: { city: "NYC" },
      name: "N",
    });
  });

  it("clone:true output is NOT reference-linked to the input (mutating output leaves input intact)", () => {
    const row = { keep: { deep: 1 }, drop: 2 };

    // inclusion
    const inc = projectRow(row, { keep: 1 }, { clone: true });
    (inc.keep as { deep: number }).deep = 99;
    expect((row.keep as { deep: number }).deep).toBe(1);

    // exclusion (always clones)
    const exc = projectRow(row, { drop: 0 }, { clone: true });
    (exc.keep as { deep: number }).deep = 77;
    expect((row.keep as { deep: number }).deep).toBe(1);
  });
});
