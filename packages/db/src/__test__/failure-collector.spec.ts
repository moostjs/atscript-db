import { describe, it, expect } from "vite-plus/test";

import { DbError } from "../db-error";
import { createChangeRecorder, createFailureCollector } from "../shared/failure-collector";

// The collector isolates per-operation failures (one CREATE UNIQUE INDEX over
// duplicate rows must not stop the rest) — but not contention: a retryable
// DbError (lock timeout, deadlock, serialization failure) fails the batch at
// once, as is (since 0.1.177). Collected, it became a plain `Error` without
// code or `retryable`, and every remaining operation met the same lock.

const fail = (error: unknown) => async () => {
  throw error;
};

describe("createFailureCollector", () => {
  it("collects an ordinary failure, runs the rest and throws them together", async () => {
    const { attempt, throwIfAny } = createFailureCollector("index sync");
    expect(await attempt("create index a", fail(new Error("duplicate rows")))).toBe(false);
    expect(await attempt("create index b", async () => {})).toBe(true);
    expect(throwIfAny).toThrow(
      "index sync failed for 1 operation(s): create index a: duplicate rows",
    );
  });

  it("collects a non-retryable DbError like any failure", async () => {
    const { attempt, throwIfAny } = createFailureCollector("index sync");
    const conflict = new DbError("CONFLICT", [{ path: "code", message: "must be unique" }]);
    expect(await attempt("create index a", fail(conflict))).toBe(false);
    expect(throwIfAny).toThrow("create index a: must be unique");
  });

  it("rethrows a retryable DbError as is and collects nothing", async () => {
    const { attempt, throwIfAny } = createFailureCollector("index sync");
    const contention = new DbError("LOCK_TIMEOUT", [{ path: "", message: "busy" }]);
    await expect(attempt("create index a", fail(contention))).rejects.toBe(contention);
    expect(throwIfAny).not.toThrow();
  });

  it("a change recorder over the collector stops at contention without recording it", async () => {
    const { attempt } = createFailureCollector("index sync");
    const { changes, apply } = createChangeRecorder<string>(false, attempt);
    await apply("a", "create index a", () => {});
    const contention = new DbError("LOCK_TIMEOUT", [{ path: "", message: "busy" }]);
    await expect(apply("b", "create index b", fail(contention))).rejects.toBe(contention);
    expect(changes).toEqual(["a"]);
  });
});
