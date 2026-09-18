import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { CasMismatchError, DbError } from "../db-error";
import { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * `touchMany` (since 0.1.129) — the batch versioned touch: every listed row's
 * version bumps by exactly one, each guarded by its own expected version.
 * The adapter contract it drives: one `count` over the whole OR filter FIRST
 * (`require: 'all'`), then `updateMany(chunkOrFilter, {}, undefined)` chunks
 * of ≤ 500 keys inside ONE `withTransaction`, `CAS_MISMATCH` when the summed
 * `matchedCount` falls short.
 */

let VersionedUser: any;
let VersionedOrder: any;
let VersionedLine: any;
let PlainWidget: any;
let VersionedMember: any;

beforeAll(async () => {
  await prepareFixtures();
  const v = await import("./fixtures/version-tables.as");
  VersionedUser = v.VersionedUser;
  VersionedOrder = v.VersionedOrder;
  VersionedLine = v.VersionedLine;
  PlainWidget = v.PlainWidget;
  VersionedMember = v.VersionedMember;
});

function makeTable(type: any, rows: Array<Record<string, unknown>> = []) {
  const adapter = new MockAdapter();
  const table = new AtscriptDbTable(type, adapter);
  adapter.store.set(table.tableName, rows);
  return { table, adapter };
}

const users3 = () => [
  { id: 1, name: "Ada", version: 4 },
  { id: 2, name: "Bob", version: 0 },
  { id: 3, name: "Cy", version: 9 },
];
const keys3 = () => [
  { id: 1, version: 4 },
  { id: 2, version: 0 },
  { id: 3, version: 9 },
];
const orOf = (keys: Array<Record<string, unknown>>) => ({ $or: keys });

async function rejectsWith(p: Promise<unknown>, code: string, path?: string, message?: RegExp) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DbError);
  expect((err as DbError).code).toBe(code);
  if (path !== undefined) expect((err as DbError).errors[0]!.path).toBe(path);
  if (message) expect((err as DbError).message).toMatch(message);
  return err as DbError;
}

describe("touchMany — happy path", () => {
  it("full match: count once over the whole OR, one updateMany({}) chunk inside one transaction, { m, m }", async () => {
    const { table, adapter } = makeTable(VersionedUser, users3());
    const count = vi.spyOn(adapter, "count");
    const updateMany = vi.spyOn(adapter, "updateMany");
    const tx = vi.spyOn(adapter, "withTransaction");

    const result = await table.touchMany(keys3() as any);

    expect(result).toEqual({ matchedCount: 3, modifiedCount: 3 });
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]![0]).toEqual({ filter: orOf(keys3()), controls: {} });
    expect(tx).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    // Direct adapter call with an EMPTY patch: the adapter renders the bump itself.
    expect(updateMany.mock.calls[0]).toEqual([orOf(keys3()), {}, undefined]);
    // The count precedes the write.
    expect(count.mock.invocationCallOrder[0]!).toBeLessThan(
      updateMany.mock.invocationCallOrder[0]!,
    );
  });

  it("600 keys → the count sees all 600 clauses, the bumps run as 500 + 100 in ONE transaction", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, name: `u${i}`, version: 1 }));
    const keys = rows.map((r) => ({ id: r.id, version: 1 }));
    const { table, adapter } = makeTable(VersionedUser, rows);
    const count = vi.spyOn(adapter, "count");
    const updateMany = vi.spyOn(adapter, "updateMany");
    const tx = vi.spyOn(adapter, "withTransaction");

    const result = await table.touchMany(keys as any);

    expect(result).toEqual({ matchedCount: 600, modifiedCount: 600 });
    expect((count.mock.calls[0]![0].filter as any).$or).toHaveLength(600);
    expect(tx).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect((updateMany.mock.calls[0]![0] as any).$or).toHaveLength(500);
    expect((updateMany.mock.calls[1]![0] as any).$or).toHaveLength(100);
    expect((updateMany.mock.calls[1]![0] as any).$or[0]).toEqual({ id: 501, version: 1 });
  });

  it("composite primary key: each clause carries every PK field plus the version", async () => {
    const rows = [
      { orderId: 1, lineNo: 1, qty: 2, version: 3 },
      { orderId: 1, lineNo: 2, qty: 5, version: 0 },
    ];
    const { table, adapter } = makeTable(VersionedLine, rows);
    const updateMany = vi.spyOn(adapter, "updateMany");

    const result = await table.touchMany([
      { orderId: 1, lineNo: 1, version: 3 },
      { orderId: 1, lineNo: 2, version: 0 },
    ] as any);

    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    expect(updateMany.mock.calls[0]![0]).toEqual({
      $or: [
        { orderId: 1, lineNo: 1, version: 3 },
        { orderId: 1, lineNo: 2, version: 0 },
      ],
    });
  });

  it("renamed version column: keys use the logical field, the adapter sees the physical column", async () => {
    const { table, adapter } = makeTable(VersionedOrder, [{ id: 1, status: "new", v: 2 }]);
    const count = vi.spyOn(adapter, "count");
    const updateMany = vi.spyOn(adapter, "updateMany");

    await table.touchMany([{ id: 1, revision: 2 }] as any);

    expect(count.mock.calls[0]![0].filter).toEqual({ $or: [{ id: 1, v: 2 }] });
    expect(updateMany.mock.calls[0]![0]).toEqual({ $or: [{ id: 1, v: 2 }] });
  });

  it("empty input → { 0, 0 } without touching the adapter", async () => {
    const { table, adapter } = makeTable(VersionedUser, users3());
    const result = await table.touchMany([]);
    expect(result).toEqual({ matchedCount: 0, modifiedCount: 0 });
    expect(adapter.calls).toEqual([]);
  });
});

describe("touchMany — require: 'all' (default) vs 'any'", () => {
  it("one stale key → CAS_MISMATCH from the pre-count, nothing written", async () => {
    const { table, adapter } = makeTable(VersionedUser, users3());
    const updateMany = vi.spyOn(adapter, "updateMany");
    const tx = vi.spyOn(adapter, "withTransaction");

    const keys = keys3();
    keys[1]!.version = 7; // stale
    const err = await rejectsWith(
      table.touchMany(keys as any),
      "CAS_MISMATCH",
      "$cas",
      /touchMany: 2 of 3 rows matched — stale or missing rows/,
    );
    expect(err).toBeInstanceOf(CasMismatchError);
    expect(err).toMatchObject({ name: "CasMismatchError", matched: 2, expected: 3 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });

  it("a missing row counts as a mismatch too", async () => {
    const { table } = makeTable(VersionedUser, users3());
    await rejectsWith(
      table.touchMany([...keys3(), { id: 404, version: 0 }] as any),
      "CAS_MISMATCH",
      "$cas",
      /3 of 4 rows matched/,
    );
  });

  it("a row that moves between the count and the bump → CAS_MISMATCH thrown INSIDE the transaction", async () => {
    const { table, adapter } = makeTable(VersionedUser, users3());
    vi.spyOn(adapter, "count").mockResolvedValue(3); // the pre-count passed…
    vi.spyOn(adapter, "updateMany").mockResolvedValue({ matchedCount: 2, modifiedCount: 2 }); // …the write did not
    const tx = vi.spyOn(adapter, "withTransaction");

    await rejectsWith(
      table.touchMany(keys3() as any),
      "CAS_MISMATCH",
      "$cas",
      /2 of 3 rows matched/,
    );
    expect(tx).toHaveBeenCalledTimes(1);
    // The rejection surfaced through withTransaction — a SQL adapter rolls back.
    await expect(tx.mock.results[0]!.value).rejects.toBeInstanceOf(DbError);
  });

  it("require: 'any' → no pre-count, the honest partial result", async () => {
    const { table, adapter } = makeTable(VersionedUser, users3());
    const count = vi.spyOn(adapter, "count");
    const keys = keys3();
    keys[1]!.version = 7; // stale — MockAdapter.updateMany matches by exact filter

    const result = await table.touchMany(keys as any, { require: "any" });

    expect(count).not.toHaveBeenCalled();
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
  });
});

describe("touchMany — input validation (INVALID_QUERY, before any adapter call)", () => {
  it("non-versioned table", async () => {
    const { table, adapter } = makeTable(PlainWidget, [{ id: 1, name: "w" }]);
    await rejectsWith(
      table.touchMany([{ id: 1 }] as any),
      "INVALID_QUERY",
      "",
      /touchMany requires @db\.column\.version/,
    );
    expect(adapter.calls).toEqual([]);
  });

  it("a key with a payload property", async () => {
    const { table, adapter } = makeTable(VersionedUser, users3());
    await rejectsWith(
      table.touchMany([{ id: 1, version: 4, name: "Ada" }] as any),
      "INVALID_QUERY",
      "[0].name",
      /a touch carries no payload/,
    );
    expect(adapter.calls).toEqual([]);
  });

  it("`$cas` is not the shape either — the version goes on the key itself", async () => {
    const { table } = makeTable(VersionedUser, users3());
    await rejectsWith(
      table.touchMany([{ id: 1, version: 4, $cas: { version: 4 } }] as any),
      "INVALID_QUERY",
      "[0].$cas",
    );
  });

  it("missing or non-numeric version — path names the key index and the version field", async () => {
    const { table } = makeTable(VersionedUser, users3());
    await rejectsWith(
      table.touchMany([{ id: 1, version: 4 }, { id: 2 }] as any),
      "INVALID_QUERY",
      "[1].version",
    );
    await rejectsWith(
      table.touchMany([{ id: 1, version: "4" }] as any),
      "INVALID_QUERY",
      "[0].version",
    );
    await rejectsWith(
      table.touchMany([{ id: 1, version: Number.NaN }] as any),
      "INVALID_QUERY",
      "[0].version",
    );
  });

  it("missing primary key — path names the key index and the PK field", async () => {
    const { table } = makeTable(VersionedUser, users3());
    await rejectsWith(
      table.touchMany([{ version: 4 }] as any),
      "INVALID_QUERY",
      "[0].id",
      /each key must carry its "id"/,
    );
  });

  it("a unique-index field does not identify a touch key (primary key only)", async () => {
    const { table, adapter } = makeTable(VersionedMember, [
      { id: 1, email: "ada@example.com", version: 4 },
    ]);
    await rejectsWith(
      table.touchMany([{ email: "ada@example.com", version: 4 }] as any),
      "INVALID_QUERY",
      "[0].id",
    );
    expect(adapter.calls).toEqual([]);
  });

  it("undefined-valued properties are ignored, like in every write payload", async () => {
    const { table, adapter } = makeTable(VersionedUser, users3());
    const updateMany = vi.spyOn(adapter, "updateMany");
    const result = await table.touchMany([{ id: 1, version: 4, name: undefined }] as any);
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(updateMany.mock.calls[0]![0]).toEqual({ $or: [{ id: 1, version: 4 }] });
  });

  it("duplicate primary key", async () => {
    const { table } = makeTable(VersionedUser, users3());
    await rejectsWith(
      table.touchMany([
        { id: 1, version: 4 },
        { id: 1, version: 5 },
      ] as any),
      "INVALID_QUERY",
      "[1]",
      /duplicate key/,
    );
  });
});
