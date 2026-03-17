import { describe, it, expect } from "vite-plus/test";

import { $inc, $dec, $mul, isDbFieldOp, getDbFieldOp, separateFieldOps } from "../ops";

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
