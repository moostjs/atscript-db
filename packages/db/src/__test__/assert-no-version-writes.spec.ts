import { describe, it, expect } from "vite-plus/test";

import { DbError } from "../db-error";
import { assertNoVersionWrites } from "../patch/patch-decomposer";

describe("assertNoVersionWrites", () => {
  // WHY: happy path — writes that don't touch the version column must pass
  // through without surfacing any error and without mutating the payload.
  it("is a no-op when the version column is absent from payload", () => {
    const data: Record<string, unknown> = { name: "Ada", status: "active" };
    expect(() => assertNoVersionWrites(data, "version")).not.toThrow();
    expect(data).toEqual({ name: "Ada", status: "active" });
  });

  // WHY: §4.5 invariant — a plain SET would be overwritten by the adapter's
  // auto-bump and silently lose data. Reject loudly so the caller sees it.
  it("throws DbError when the version column appears as a top-level SET key", () => {
    expect(() => assertNoVersionWrites({ version: 7 }, "version")).toThrow(DbError);
  });

  // WHY: $inc would compound with the auto-bump (`+1 + N`), corrupting the
  // monotonic-by-one invariant that CAS predicates depend on.
  it("throws DbError when the version column appears as the target of $inc", () => {
    expect(() => assertNoVersionWrites({ version: { $inc: 1 } }, "version")).toThrow(DbError);
  });

  // WHY: $mul is the same family of corruption — any caller-side write to
  // the column breaks OCC. The check is a single rule at the key level so
  // every flavor of operator (including future ones) is caught uniformly.
  it("throws DbError when the version column appears as the target of $mul", () => {
    expect(() => assertNoVersionWrites({ version: { $mul: 2 } }, "version")).toThrow(DbError);
  });

  // WHY: error is operator-facing — a vague message wastes debug time. Must
  // name the column AND point to the $cas remediation path.
  it("error message names the column and offers the $cas remediation", () => {
    try {
      assertNoVersionWrites({ version: 1 }, "version");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DbError);
      const dbErr = err as DbError;
      expect(dbErr.code).toBe("VERSION_COLUMN_WRITE");
      expect(dbErr.message).toContain('"version"');
      expect(dbErr.message).toContain("$cas");
    }
  });

  // WHY: the version column name is configurable via @db.column rename;
  // the assertion must respect the physical name passed in, not assume
  // a literal "version".
  it("honors a renamed version column", () => {
    expect(() => assertNoVersionWrites({ v: 1 }, "v")).toThrow(DbError);
    // The literal "version" key is fine when the column is named "v".
    expect(() => assertNoVersionWrites({ version: 1 }, "v")).not.toThrow();
  });
});
