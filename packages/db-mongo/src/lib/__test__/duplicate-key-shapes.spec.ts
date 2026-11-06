import { describe, it, expect, beforeAll, afterEach, vi } from "vite-plus/test";
import { DbError } from "@atscript/db";
import { MongoBulkWriteError, MongoServerError, MongoWriteConcernError } from "mongodb";

import type { MongoAdapter } from "../mongo-adapter";
import { duplicateKeyViolation } from "../mongo-errors";
import { createTestSpace, prepareFixtures } from "./test-utils";

// A duplicate key is a `CONFLICT` whatever driver error carries it (0.1.174),
// including one built by another copy of the `mongodb` package (see
// mongo-errors.ts). Before, it escaped raw: two pods racing for the schema-sync
// lock failed with `E11000 … dup key: { _id: "sync_lock" }` instead of one waiting.

const DUP_MSG =
  'E11000 duplicate key error collection: test.__atscript_control index: _id_ dup key: { _id: "sync_lock" }';

/** The driver's `WriteError`: its fields are prototype getters over `err`. */
class FakeWriteError {
  constructor(private readonly err: { code: number; index: number; errmsg: string }) {}
  get code() {
    return this.err.code;
  }
  get index() {
    return this.err.index;
  }
  get errmsg() {
    return this.err.errmsg;
  }
}

/** A bulk result as `BulkWriteResult` exposes it (`getWriteConcernError()`). */
function bulkResult(writeConcernError?: unknown) {
  return {
    getWriteConcernError: () => writeConcernError,
    insertedCount: 0,
  } as never;
}

/** What `OrderedBulkOperation.handleWriteError` throws for a rejected insert. */
function bulkDuplicate(codes: number[] = [11000], topCode: number | undefined = codes[0]) {
  const writeErrors = codes.map(
    (code, index) => new FakeWriteError({ code, index, errmsg: code === 11000 ? DUP_MSG : "boom" }),
  );
  return new MongoBulkWriteError(
    { message: writeErrors[0]!.errmsg, code: topCode, writeErrors } as never,
    bulkResult(),
  );
}

/**
 * The same bulk error built by another copy of the driver: no class of ours in
 * its prototype chain (`instanceof MongoServerError` is false).
 */
class ForeignMongoBulkWriteError extends Error {
  code = 11000;
  writeErrors = [new FakeWriteError({ code: 11000, index: 0, errmsg: DUP_MSG })];
  result = { getWriteConcernError: () => undefined };
  override get name() {
    return "MongoBulkWriteError";
  }
}

describe("[mongo] duplicateKeyViolation", () => {
  it("a MongoServerError 11000 (single-document writes), with its keyPattern", () => {
    const error = new MongoServerError({ message: DUP_MSG, code: 11000, keyPattern: { _id: 1 } });
    expect(duplicateKeyViolation(error)).toEqual({ message: DUP_MSG, keyPattern: { _id: 1 } });
  });

  it("a MongoBulkWriteError with 11000 on top and in writeErrors", () => {
    expect(duplicateKeyViolation(bulkDuplicate())).toEqual({
      message: DUP_MSG,
      keyPattern: undefined,
    });
  });

  it("a MongoBulkWriteError with 11000 only in writeErrors", () => {
    expect(duplicateKeyViolation(bulkDuplicate([11000], undefined))?.message).toBe(DUP_MSG);
  });

  it("a bulk error from another copy of the driver (no instanceof match)", () => {
    const error = new ForeignMongoBulkWriteError(DUP_MSG);
    expect(error).not.toBeInstanceOf(MongoServerError);
    expect(duplicateKeyViolation(error)?.message).toBe(DUP_MSG);
  });

  it("a bare WriteError 11000", () => {
    const error = new FakeWriteError({ code: 11000, index: 0, errmsg: DUP_MSG });
    expect(duplicateKeyViolation(error)?.message).toBe(DUP_MSG);
  });

  it("legacy 11001 counts as a duplicate key", () => {
    expect(duplicateKeyViolation(new MongoServerError({ message: "E11001", code: 11001 }))).toEqual(
      { message: "E11001", keyPattern: undefined },
    );
  });

  it("a bulk error mixing a duplicate key with another write error is not a conflict", () => {
    expect(duplicateKeyViolation(bulkDuplicate([11000, 121]))).toBeUndefined();
  });

  it("never a write-concern failure, even next to a duplicate-key write error", () => {
    const withWc = new MongoBulkWriteError(
      { message: DUP_MSG, code: 11000, writeErrors: bulkDuplicate().writeErrors } as never,
      bulkResult({ code: 64, errmsg: "waiting for replication timed out" }),
    );
    expect(duplicateKeyViolation(withWc)).toBeUndefined();
    const wc = new MongoWriteConcernError({
      writeConcernError: { code: 64, errmsg: "waiting for replication timed out" },
    } as never);
    expect(duplicateKeyViolation(wc)).toBeUndefined();
  });

  it("anything else is not a duplicate key", () => {
    expect(
      duplicateKeyViolation(new MongoServerError({ message: "x", code: 121 })),
    ).toBeUndefined();
    expect(duplicateKeyViolation(new Error("connection reset"))).toBeUndefined();
    expect(duplicateKeyViolation(new DbError("CONFLICT", []))).toBeUndefined();
    expect(duplicateKeyViolation(undefined)).toBeUndefined();
    expect(duplicateKeyViolation("E11000")).toBeUndefined();
  });
});

describe("[mongo] duplicate keys map to CONFLICT whatever the driver error class", () => {
  const mongo = createTestSpace();

  beforeAll(prepareFixtures);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function insertRejectedWith(error: unknown): Promise<unknown> {
    const { CeItem } = await import("./fixtures/constraint-errors.as");
    const adapter = mongo.getAdapter(CeItem) as unknown as MongoAdapter;
    vi.spyOn(adapter, "collection", "get").mockReturnValue({
      insertOne: () => Promise.reject(error),
      insertMany: () => Promise.reject(error),
    } as never);
    return mongo
      .getTable(CeItem)
      .insertOne({ _id: "a", householdId: 1, name: "salt" } as never)
      .catch((e: unknown) => e);
  }

  it("a MongoBulkWriteError → CONFLICT", async () => {
    const error = await insertRejectedWith(bulkDuplicate());
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("CONFLICT");
  });

  it("another driver copy's bulk error → CONFLICT", async () => {
    const error = await insertRejectedWith(new ForeignMongoBulkWriteError(DUP_MSG));
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("CONFLICT");
  });

  it("a write-concern failure escapes as is", async () => {
    const wc = new MongoWriteConcernError({
      writeConcernError: { code: 64, errmsg: "waiting for replication timed out" },
    } as never);
    expect(await insertRejectedWith(wc)).toBe(wc);
  });

  it("insertMany onConflict ignore: another driver copy's bulk error marks the skipped row", async () => {
    const { CeItem } = await import("./fixtures/constraint-errors.as");
    const adapter = mongo.getAdapter(CeItem) as unknown as MongoAdapter;
    vi.spyOn(adapter, "collection", "get").mockReturnValue({
      insertMany: () => Promise.reject(new ForeignMongoBulkWriteError(DUP_MSG)),
    } as never);
    // No server: the write's transaction is a pass-through (as on a standalone server).
    vi.spyOn(adapter, "withTransaction").mockImplementation((fn: () => Promise<unknown>) => fn());
    const result = await mongo.getTable(CeItem).insertMany(
      [
        { _id: "a", householdId: 1, name: "salt" },
        { _id: "b", householdId: 2, name: "salt" },
      ] as never,
      { onConflict: "ignore" },
    );
    expect(result.conflicts).toEqual([0]);
    expect(result.inserted).toEqual([1]);
  });
});
