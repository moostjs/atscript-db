import { describe, it, expect } from "vite-plus/test";

import { DbError, aggregateFailure, isConflict, uniqueKeyTuple } from "../index";
import { findRowsByKeys, keyString, rowMatchesKey } from "../shared/keys";

describe("uniqueKeyTuple", () => {
  it("is undefined when any component is null / missing (NULL never collides)", () => {
    expect(uniqueKeyTuple({ a: 1 }, ["a", "b"])).toBeUndefined();
    expect(uniqueKeyTuple({ a: 1, b: null }, ["a", "b"])).toBeUndefined();
  });

  it("is equal across driver representations", () => {
    const iso = "2026-01-01T00:00:00.123Z";
    expect(uniqueKeyTuple({ t: new Date(iso) }, ["t"])).toBe(uniqueKeyTuple({ t: iso }, ["t"]));
    expect(uniqueKeyTuple({ id: 1n }, ["id"])).toBe(uniqueKeyTuple({ id: "1" }, ["id"]));
    expect(uniqueKeyTuple({ b: Buffer.from([1, 255]) }, ["b"])).toBe(
      uniqueKeyTuple({ b: new Uint8Array([1, 255]) }, ["b"]),
    );
  });

  it("reads dot paths and distinguishes tuple boundaries", () => {
    expect(uniqueKeyTuple({ a: { b: 1 } }, ["a.b"])).toBe(
      uniqueKeyTuple({ a: { b: "1" } }, ["a.b"]),
    );
    expect(uniqueKeyTuple({ a: "x,y", b: "z" }, ["a", "b"])).not.toBe(
      uniqueKeyTuple({ a: "x", b: "y,z" }, ["a", "b"]),
    );
  });

  it("keyString survives an invalid Date", () => {
    expect(keyString(new Date("nope"))).toBe("Invalid Date");
  });
});

describe("isConflict / aggregateFailure", () => {
  it("isConflict is true only for DbError CONFLICT", () => {
    expect(isConflict(new DbError("CONFLICT", [{ path: "", message: "m" }]))).toBe(true);
    expect(isConflict(new DbError("FK_VIOLATION", [{ path: "", message: "m" }]))).toBe(false);
    expect(isConflict(new Error("CONFLICT"))).toBe(false);
    expect(isConflict(null)).toBe(false);
  });

  it("aggregateFailure lists every failure in the message", () => {
    const err = aggregateFailure("close failed", [new Error("a"), "b"]);
    expect(err).toBeInstanceOf(AggregateError);
    expect(err.message).toBe("close failed: a; b");
    expect(err.errors).toHaveLength(2);
  });
});

/** The reference `findRowsByKeys` must agree with: a scan per filter. */
function scan(rows: Array<Record<string, unknown>>, filters: Array<Record<string, unknown>>) {
  return filters.map((f) => rows.find((r) => rowMatchesKey(r, f)));
}

describe("findRowsByKeys", () => {
  it("answers exactly what a rows.find(rowMatchesKey) scan answers", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = () => {
      const r = rnd();
      if (r < 0.05) return null;
      if (r < 0.1) return undefined;
      if (r < 0.4) return Math.floor(rnd() * 20);
      if (r < 0.7) return String(Math.floor(rnd() * 20)); // number vs numeric string
      if (r < 0.8) return BigInt(Math.floor(rnd() * 20));
      if (r < 0.9) return new Date(Date.UTC(2026, 0, 1 + Math.floor(rnd() * 5)));
      return new Date(Date.UTC(2026, 0, 1 + Math.floor(rnd() * 5))).toISOString();
    };
    for (let round = 0; round < 30; round++) {
      const rows = Array.from({ length: 40 }, (_, i) => ({
        id: pick(),
        a: pick(),
        nested: { b: pick() },
        n: i,
      }));
      const filters: Array<Record<string, unknown>> = Array.from({ length: 30 }, () => {
        const shape = rnd();
        if (shape < 0.4) return { id: pick() };
        if (shape < 0.7) return { id: pick(), a: pick() };
        if (shape < 0.85) return { a: pick(), id: pick() }; // other key order
        return { "nested.b": pick() };
      });
      const expected = scan(rows, filters);
      const actual = findRowsByKeys(rows, filters);
      expect(actual.length).toBe(expected.length);
      actual.forEach((row, i) => expect(row).toBe(expected[i]));
    }
  });

  it("returns the first matching row and undefined for no match", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i % 10, n: i }));
    const found = findRowsByKeys(rows, [{ id: 3 }, { id: "3" }, { id: 99 }, { id: 7 }]);
    expect(found.map((r) => r?.n)).toEqual([3, 3, undefined, 7]);
  });

  it("composite keys cannot collide through separators", () => {
    const rows = Array.from({ length: 10 }, () => ({ a: "x\u0000y", b: "z" }));
    rows.push({ a: "x", b: "y\u0000z" });
    const found = findRowsByKeys(
      rows,
      Array.from({ length: 10 }, () => ({ a: "x", b: "y\u0000z" })),
    );
    expect(found.every((r) => r === rows[10])).toBe(true);
  });
});
