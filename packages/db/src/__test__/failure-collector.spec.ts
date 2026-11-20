import { describe, it, expect } from "vite-plus/test";

import { DbError, isRetryableDbError } from "../db-error";
import { createChangeRecorder, createFailureCollector } from "../shared/failure-collector";

// The collector isolates per-operation failures (one CREATE UNIQUE INDEX over
// duplicate rows must not stop the rest) — but not contention: a retryable
// DbError (lock timeout, deadlock, serialization failure) fails the batch at
// once (since 0.1.177). Collected, it became a plain `Error` without code or
// `retryable`, and every remaining operation met the same lock.

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

  // Since 0.1.178: contention after collected failures no longer drops them —
  // the caller learns about the failed index now, not on the next run. The
  // engine's text goes in `details` (never sent to HTTP clients), not `message`.
  it("contention after collected failures: same code / message / cause, the failures appended", async () => {
    const { attempt } = createFailureCollector("index sync");
    expect(await attempt("create index a", fail(new Error("duplicate rows")))).toBe(false);
    expect(await attempt("create index b", async () => {})).toBe(true);
    const conflict = new DbError("CONFLICT", [{ path: "code", message: "must be unique" }]);
    expect(await attempt("create index c", fail(conflict))).toBe(false);
    const driverError = new Error("Deadlock found when trying to get lock");
    const contention = new DbError("DEADLOCK", [{ path: "", message: "deadlock" }], "busy", {
      cause: driverError,
    });
    const error = (await attempt("drop index d", fail(contention)).catch(
      (e: unknown) => e,
    )) as DbError;
    expect(error).not.toBe(contention);
    expect(error).toBeInstanceOf(DbError);
    expect(isRetryableDbError(error)).toBe(true);
    expect(error.code).toBe("DEADLOCK");
    expect(error.message).toBe("busy");
    expect(error.cause).toBe(driverError);
    expect(error.errors).toEqual([
      { path: "", message: "deadlock" },
      { path: "", message: "create index a failed", details: "duplicate rows" },
      { path: "", message: "create index c failed", details: "must be unique" },
    ]);
  });

  it("contention without a cause after a collected failure gets none either", async () => {
    const { attempt } = createFailureCollector("index sync");
    await attempt("create index a", fail(new Error("duplicate rows")));
    const contention = new DbError("LOCK_TIMEOUT", [{ path: "", message: "busy" }]);
    const error = (await attempt("drop index b", fail(contention)).catch(
      (e: unknown) => e,
    )) as DbError;
    expect(error.code).toBe("LOCK_TIMEOUT");
    expect(error.message).toBe("busy");
    expect("cause" in error).toBe(false);
    expect(error.errors).toEqual([
      { path: "", message: "busy" },
      { path: "", message: "create index a failed", details: "duplicate rows" },
    ]);
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
