import { describe, it, expect } from "vite-plus/test";

import { DbError } from "../db-error";
import {
  $inc,
  $dec,
  $mul,
  $cas,
  isDbFieldOp,
  getDbFieldOp,
  separateFieldOps,
  separateCas,
} from "../ops";

describe("field ops helpers", () => {
  it("$inc returns { $inc: N }", () => {
    expect($inc(5)).toEqual({ $inc: 5 });
    expect($inc()).toEqual({ $inc: 1 });
  });

  it("$dec returns { $dec: N }", () => {
    expect($dec(3)).toEqual({ $dec: 3 });
    expect($dec()).toEqual({ $dec: 1 });
  });

  it("$mul returns { $mul: N }", () => {
    expect($mul(2.5)).toEqual({ $mul: 2.5 });
  });
});

describe("isDbFieldOp", () => {
  it("returns true for valid ops", () => {
    expect(isDbFieldOp({ $inc: 1 })).toBe(true);
    expect(isDbFieldOp({ $dec: 5 })).toBe(true);
    expect(isDbFieldOp({ $mul: 2 })).toBe(true);
    expect(isDbFieldOp({ $inc: -3 })).toBe(true);
    expect(isDbFieldOp({ $inc: 0 })).toBe(true);
  });

  it("returns false for non-ops", () => {
    expect(isDbFieldOp(null)).toBe(false);
    expect(isDbFieldOp(undefined)).toBe(false);
    expect(isDbFieldOp(42)).toBe(false);
    expect(isDbFieldOp("hello")).toBe(false);
    expect(isDbFieldOp([])).toBe(false);
    expect(isDbFieldOp({})).toBe(false);
    expect(isDbFieldOp({ $inc: "not a number" })).toBe(false);
    expect(isDbFieldOp({ $inc: 1, extra: 2 })).toBe(false);
    expect(isDbFieldOp({ $insert: [1] })).toBe(false);
    expect(isDbFieldOp({ $replace: [1] })).toBe(false);
    expect(isDbFieldOp({ name: "John" })).toBe(false);
  });
});

describe("getDbFieldOp", () => {
  it("normalizes $inc", () => {
    expect(getDbFieldOp({ $inc: 5 })).toEqual({ op: "inc", value: 5 });
  });

  it("normalizes $dec to negative inc", () => {
    expect(getDbFieldOp({ $dec: 3 })).toEqual({ op: "inc", value: -3 });
  });

  it("normalizes $mul", () => {
    expect(getDbFieldOp({ $mul: 2 })).toEqual({ op: "mul", value: 2 });
  });

  it("returns undefined for non-ops", () => {
    expect(getDbFieldOp(42)).toBeUndefined();
    expect(getDbFieldOp({ name: "John" })).toBeUndefined();
  });
});

describe("separateFieldOps", () => {
  it("returns undefined when no ops present (zero overhead path)", () => {
    const data = { name: "John", age: 30, active: true };
    const ops = separateFieldOps(data);
    expect(ops).toBeUndefined();
    expect(data).toEqual({ name: "John", age: 30, active: true });
  });

  it("separates $inc ops and removes them from data", () => {
    const data: Record<string, unknown> = { name: "John", views: { $inc: 1 }, score: { $inc: 10 } };
    const ops = separateFieldOps(data);
    expect(ops).toEqual({ inc: { views: 1, score: 10 } });
    expect(data).toEqual({ name: "John" });
  });

  it("separates $dec as negative inc", () => {
    const data: Record<string, unknown> = { stock: { $dec: 5 } };
    const ops = separateFieldOps(data);
    expect(ops).toEqual({ inc: { stock: -5 } });
    expect(data).toEqual({});
  });

  it("separates $mul ops", () => {
    const data: Record<string, unknown> = { price: { $mul: 1.1 } };
    const ops = separateFieldOps(data);
    expect(ops).toEqual({ mul: { price: 1.1 } });
    expect(data).toEqual({});
  });

  it("handles mixed ops and regular fields", () => {
    const data: Record<string, unknown> = {
      name: "Updated",
      views: { $inc: 1 },
      price: { $mul: 0.9 },
      status: "active",
    };
    const ops = separateFieldOps(data);
    expect(ops).toEqual({ inc: { views: 1 }, mul: { price: 0.9 } });
    expect(data).toEqual({ name: "Updated", status: "active" });
  });

  it("does not treat array patch ops as field ops", () => {
    const data: Record<string, unknown> = {
      tags: { $insert: ["new-tag"] },
      views: { $inc: 1 },
    };
    const ops = separateFieldOps(data);
    expect(ops).toEqual({ inc: { views: 1 } });
    expect(data).toEqual({ tags: { $insert: ["new-tag"] } });
  });

  it("handles dot-path keys from flattened nested structures", () => {
    const data: Record<string, unknown> = {
      name: "Updated",
      "stats.views": { $inc: 1 },
      "stats.score": { $mul: 1.5 },
      "meta.tag": "info",
    };
    const ops = separateFieldOps(data);
    expect(ops).toEqual({
      inc: { "stats.views": 1 },
      mul: { "stats.score": 1.5 },
    });
    expect(data).toEqual({ name: "Updated", "meta.tag": "info" });
  });

  it("skips null, arrays, and primitives without overhead", () => {
    const data: Record<string, unknown> = {
      a: null,
      b: 42,
      c: "hello",
      d: true,
      e: [1, 2, 3],
    };
    const ops = separateFieldOps(data);
    expect(ops).toBeUndefined();
    expect(data).toEqual({ a: null, b: 42, c: "hello", d: true, e: [1, 2, 3] });
  });
});

describe("$cas", () => {
  // WHY: type-clean inline ergonomics — consumers spread the helper into a
  // payload and the resulting object must serialize as a single $cas entry.
  it("returns a { $cas: { [col]: N } } wrapper", () => {
    expect($cas("version", 7)).toEqual({ $cas: { version: 7 } });
  });
});

describe("separateCas", () => {
  // WHY: pure-function contract — the table layer relies on the mutation
  // + return shape to forward `expectedVersion` to the adapter.
  it("strips $cas from payload and returns its value", () => {
    const data: Record<string, unknown> = { a: 1, $cas: { version: 4 } };
    const v = separateCas(data, "version");
    expect(v).toBe(4);
    expect(data).toEqual({ a: 1 });
  });

  // WHY: no-op path must be allocation-free; OCC-unaware writes pay nothing.
  it("returns undefined and does not mutate when $cas absent", () => {
    const data: Record<string, unknown> = { a: 1, b: "x" };
    const before = { ...data };
    const v = separateCas(data, "version");
    expect(v).toBeUndefined();
    expect(data).toEqual(before);
  });

  // WHY: defensive boundary — malformed payloads must surface loudly,
  // not silently no-op (Rule 12 / fail loud).
  it("throws DbError when $cas is not a plain object", () => {
    expect(() => separateCas({ $cas: null as unknown as Record<string, number> })).toThrow(DbError);
    expect(() => separateCas({ $cas: [1] as unknown as Record<string, number> })).toThrow(DbError);
    expect(() => separateCas({ $cas: "bad" as unknown as Record<string, number> })).toThrow(
      DbError,
    );
  });

  // WHY: v1 single-column constraint per locked decision §4.1.
  it("throws DbError when $cas map is empty", () => {
    expect(() => separateCas({ $cas: {} })).toThrow(DbError);
  });

  // WHY: v1 single-column constraint per locked decision §4.1.
  it("throws DbError when $cas map has more than one entry", () => {
    expect(() => separateCas({ $cas: { version: 1, other: 2 } })).toThrow(DbError);
  });

  // WHY: prevents float / NaN sneaking into the WHERE predicate where they
  // would compare as never-equal and silently drop the update.
  it("throws DbError when $cas value is non-numeric or non-integer", () => {
    expect(() => separateCas({ $cas: { version: "4" as unknown as number } })).toThrow(DbError);
    expect(() => separateCas({ $cas: { version: 1.5 } })).toThrow(DbError);
    expect(() => separateCas({ $cas: { version: Number.NaN } })).toThrow(DbError);
  });

  // WHY: catches caller bugs (typoed column name) at the SDK boundary,
  // not at the DB where the predicate would silently never match.
  it("throws DbError when versionColumn is provided and key does not match", () => {
    expect(() => separateCas({ $cas: { revision: 1 } }, "version")).toThrow(DbError);
  });

  // WHY: moost-db auto-lift (Phase 4) calls separateCas without knowing
  // the column name — validation deferred to the version-aware caller.
  it("accepts any single-entry shape when versionColumn is omitted", () => {
    const data: Record<string, unknown> = { $cas: { revision: 9 } };
    expect(separateCas(data)).toBe(9);
    expect(data).toEqual({});
  });
});
