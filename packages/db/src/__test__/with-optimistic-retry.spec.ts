import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { CasExhaustedError, DbError } from "../db-error";
import { AtscriptDbTable } from "../table/db-table";
import { withOptimisticRetry } from "../with-optimistic-retry";
import { MockAdapter, prepareFixtures } from "./test-utils";

let VersionedUser: any;
let PlainWidget: any;

beforeAll(async () => {
  await prepareFixtures();
  const mod = await import("./fixtures/version-tables.as");
  VersionedUser = mod.VersionedUser;
  PlainWidget = mod.PlainWidget;
});

// Local helper: build a fresh table over a fresh MockAdapter. Each test gets
// isolated mocks so spy state never leaks between cases.
function makeTable(type: any): AtscriptDbTable {
  const adapter = new MockAdapter();
  return new AtscriptDbTable(type, adapter);
}

describe("withOptimisticRetry", () => {
  // WHY: happy path. When no contention exists, the helper must be a no-op
  // wrapper over the raw findOne + $cas update — exactly one read, one
  // mutator call, one write, and the underlying updateOne result returned
  // verbatim. Any deviation indicates accidental looping or result
  // rewriting.
  it("commits on the first attempt when $cas matches", async () => {
    const table = makeTable(VersionedUser);
    const findOne = vi.spyOn(table, "findOne").mockResolvedValue({
      id: 1,
      name: "Ada",
      version: 4,
    } as any);
    const updateOne = vi
      .spyOn(table, "updateOne")
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const mutator = vi.fn((row: any) => ({ name: row.name.toUpperCase() }));

    const result = await withOptimisticRetry(table, { id: 1 }, mutator);

    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(mutator).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne.mock.calls[0]?.[0]).toEqual({
      id: 1,
      name: "ADA",
      $cas: { version: 4 },
    });
  });

  // WHY: the entire point of the helper. After a stale-version miss, the
  // re-read must deliver the fresh row to the mutator on the next attempt;
  // otherwise the caller keeps computing patches from outdated state and
  // would loop forever (or worse, commit something wrong if the test
  // weakened).
  it("re-reads the row and feeds the fresh state to the mutator on retry", async () => {
    const table = makeTable(VersionedUser);
    const findOne = vi
      .spyOn(table, "findOne")
      .mockResolvedValueOnce({ id: 1, name: "stale", version: 1 } as any)
      .mockResolvedValueOnce({ id: 1, name: "fresh", version: 2 } as any);
    const updateOne = vi
      .spyOn(table, "updateOne")
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });
    const seen: Array<{ name: string; version: number }> = [];
    const mutator = vi.fn((row: any) => {
      seen.push({ name: row.name, version: row.version });
      return { name: `${row.name}!` };
    });

    const result = await withOptimisticRetry(table, { id: 1 }, mutator);

    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([
      { name: "stale", version: 1 },
      { name: "fresh", version: 2 },
    ]);
    // Second update carries the FRESH version in $cas — not the stale one.
    expect(updateOne.mock.calls[1]?.[0]).toEqual({
      id: 1,
      name: "fresh!",
      $cas: { version: 2 },
    });
  });

  // WHY: bounded retry is the safety contract. Without an upper bound, a
  // pathologically hot row would loop forever and hang the caller. The
  // thrown error must carry enough context (attempt count, last-seen
  // version) for operators to triage contention.
  it("throws CasExhaustedError carrying attempts + lastSeenVersion after maxAttempts misses", async () => {
    const table = makeTable(VersionedUser);
    let v = 10;
    vi.spyOn(table, "findOne").mockImplementation(
      async () => ({ id: 1, name: "x", version: v++ }) as any,
    );
    const updateOne = vi
      .spyOn(table, "updateOne")
      .mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

    const err = await withOptimisticRetry(table, { id: 1 }, () => ({ name: "y" }), {
      maxAttempts: 3,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(CasExhaustedError);
    expect((err as CasExhaustedError).code).toBe("CAS_EXHAUSTED");
    expect((err as CasExhaustedError).attempts).toBe(3);
    // Last read before throwing was the 3rd one — versions 10, 11, 12.
    expect((err as CasExhaustedError).lastSeenVersion).toBe(12);
    expect(updateOne).toHaveBeenCalledTimes(3);
  });

  // WHY: real callers do async work inside the mutator (crypto hashing, DB
  // lookups, JSON transforms). A sync-only mutator interface would be a
  // foot-gun — callers would silently get a Promise object spread as the
  // patch.
  it("awaits an async mutator before applying the patch", async () => {
    const table = makeTable(VersionedUser);
    vi.spyOn(table, "findOne").mockResolvedValue({
      id: 1,
      name: "Ada",
      version: 4,
    } as any);
    const updateOne = vi
      .spyOn(table, "updateOne")
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    await withOptimisticRetry(table, { id: 1 }, async (row: any) => {
      await new Promise((r) => setTimeout(r, 1));
      return { name: `${row.name}-async` };
    });

    expect(updateOne.mock.calls[0]?.[0]).toEqual({
      id: 1,
      name: "Ada-async",
      $cas: { version: 4 },
    });
  });

  // WHY: the delay hook is the integration point for jittered backoff. It
  // must receive the 1-based attempt index that just failed (so callers can
  // multiply / jitter against it) and must NOT be called after the final
  // failed attempt (no point in delaying when we're about to throw).
  it("invokes opts.delay between failed attempts with the 1-based attempt number", async () => {
    const table = makeTable(VersionedUser);
    vi.spyOn(table, "findOne").mockResolvedValue({
      id: 1,
      name: "x",
      version: 1,
    } as any);
    vi.spyOn(table, "updateOne")
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });
    const delay = vi.fn(async (_attempt: number) => {});

    await withOptimisticRetry(table, { id: 1 }, () => ({ name: "y" }), { delay });

    // Two failed attempts before success ⇒ delay called twice with 1 then 2.
    expect(delay.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  // WHY: fail-loud (Rule 12). A table without @db.column.version cannot be
  // CAS-protected — the helper has no version to thread into $cas. Silently
  // degrading to last-write-wins would hide a bug class entirely; throwing
  // surfaces the misuse at the call site.
  it("throws DbError when the table has no @db.column.version column", async () => {
    const table = makeTable(PlainWidget);
    const mutator = vi.fn();

    const err = await withOptimisticRetry(table, { id: 1 }, mutator).catch((e) => e);

    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("INVALID_QUERY");
    expect(mutator).not.toHaveBeenCalled();
  });

  // WHY: don't fabricate a row for the mutator from `null`. If the row
  // doesn't exist, the caller has a bug (deleted row, wrong filter); the
  // helper must surface it instead of inventing state for the mutator to
  // operate on.
  it("throws NOT_FOUND on initial read miss without invoking the mutator", async () => {
    const table = makeTable(VersionedUser);
    vi.spyOn(table, "findOne").mockResolvedValue(null as any);
    const updateOne = vi.spyOn(table, "updateOne");
    const mutator = vi.fn();

    const err = await withOptimisticRetry(table, { id: 999 }, mutator).catch((e) => e);

    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("NOT_FOUND");
    expect(mutator).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  // WHY: the table layer extracts the filter from the update payload. If
  // the helper drops the PK fields from `filter` (e.g. only spreads
  // `patch`), the table can't identify which row to hit. This locks in the
  // `{ ...filter, ...patch, $cas }` spread order so PK fields always reach
  // the update payload.
  it("threads PK fields from filter into the updateOne payload", async () => {
    const table = makeTable(VersionedUser);
    vi.spyOn(table, "findOne").mockResolvedValue({
      id: 42,
      name: "Ada",
      version: 7,
    } as any);
    const updateOne = vi
      .spyOn(table, "updateOne")
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    await withOptimisticRetry(table, { id: 42 }, () => ({ name: "Bob" }));

    expect(updateOne.mock.calls[0]?.[0]).toEqual({
      id: 42,
      name: "Bob",
      $cas: { version: 7 },
    });
  });
});
