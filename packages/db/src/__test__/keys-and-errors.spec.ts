import { describe, it, expect } from "vite-plus/test";

import { DbError, aggregateFailure, isConflict, uniqueKeyTuple } from "../index";
import { keyString } from "../shared/keys";

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
