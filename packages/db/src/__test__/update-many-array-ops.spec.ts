import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbError } from "../db-error";
import { AtscriptDbTable } from "../table/db-table";
import type { DbQuery, TDbUpdateOptions, TDbUpdateResult } from "../types";
import { MockAdapter, OrderedMockAdapter, prepareFixtures } from "./test-utils";

// `updateMany` with `$insert` / `$upsert` / `$update` / `$remove` (since
// 0.1.182; 0.1.180 – 0.1.181 refused them). Each matched row ends with the
// array `updateOne` gives it. Without native patch support the table reads
// the keys of the matched rows (locked where the adapter locks rows), then per
// batch of keys their operator columns, and writes each row by its primary
// key — all in one transaction. A native-patch adapter gets the patch once
// through `nativePatchMany`.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/update-many-array-ops.as");
});

/** A mock that orders and limits its reads like a real engine, takes row locks and counts transactions. */
class RowMockAdapter extends OrderedMockAdapter {
  override supportsReadLocks(): boolean {
    return true;
  }

  transactions = 0;
  override async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.transactions++;
    return super.withTransaction(fn);
  }
}

/** A nested-object adapter (the in-memory one stores objects whole). */
class DocumentMockAdapter extends RowMockAdapter {
  override supportsNestedObjects(): boolean {
    return true;
  }
}

function setup(type: any = fx.UmaItem, adapter: MockAdapter = new RowMockAdapter()) {
  const table = new AtscriptDbTable(type, adapter);
  const rows: Array<Record<string, unknown>> = [];
  adapter.store.set(table.tableName, rows);
  return {
    adapter,
    table,
    rows,
    seed: (...seeded: Array<Record<string, unknown>>) =>
      rows.push(...seeded.map((row) => structuredClone(row))),
  };
}

const callsOf = (adapter: MockAdapter, method: string) =>
  adapter.calls.filter((c) => c.method === method);

/** Three rows, each with other stored arrays (a null array in the last). */
const items = () => [
  {
    id: 1,
    status: "open",
    plain: [
      { sku: "a", qty: 1, note: "keep" },
      { sku: "b", qty: 5 },
    ],
    merged: [{ sku: "a", qty: 1, note: "keep" }],
    keyless: [{ label: "x" }, { label: "y" }],
    tags: ["t1", "old"],
    uniq: ["u"],
    rev: 0,
  },
  {
    id: 2,
    status: "open",
    plain: [{ sku: "c", qty: 3 }],
    merged: [{ sku: "b", qty: 2 }],
    keyless: [{ label: "y" }],
    tags: ["old"],
    uniq: ["v", "w"],
    rev: 0,
  },
  {
    id: 3,
    status: "open",
    plain: null,
    merged: null,
    keyless: null,
    tags: null,
    uniq: null,
    rev: 0,
  },
];

const patch = {
  plain: { $update: [{ sku: "a", qty: 2 }], $insert: [{ sku: "n", qty: 1 }] },
  merged: { $upsert: [{ sku: "a", qty: 9 }] },
  keyless: { $remove: [{ label: "x" }] },
  tags: { $remove: ["old"], $insert: ["new"] },
  uniq: { $insert: ["w", "z"] },
};
const fields = Object.keys(patch);

describe("updateMany with array operators — per row", () => {
  it("every row ends with the array updateOne gives it, from its own stored array", async () => {
    const many = setup();
    many.seed(...items());
    const result = await many.table.updateMany({ status: "open" }, patch as any);
    expect(result).toEqual({ matchedCount: 3, modifiedCount: 3 });

    const one = setup();
    one.seed(...items());
    for (const { id } of items()) await one.table.updateOne({ id, ...patch } as any);
    const writtenByOne = callsOf(one.adapter, "updateOne").map((c) => c.args[1]);

    for (const [i, row] of many.rows.entries()) {
      for (const field of fields)
        expect(row[field], `${field} of row ${i + 1}`).toEqual(writtenByOne[i][field]);
    }
    expect(many.rows.map((row) => row.plain)).toEqual([
      [
        { sku: "a", qty: 2 },
        { sku: "b", qty: 5 },
        { sku: "n", qty: 1 },
      ],
      [
        { sku: "c", qty: 3 },
        { sku: "n", qty: 1 },
      ],
      [{ sku: "n", qty: 1 }],
    ]);
    expect(many.rows.map((row) => row.merged)).toEqual([
      [{ sku: "a", qty: 9, note: "keep" }],
      [
        { sku: "b", qty: 2 },
        { sku: "a", qty: 9 },
      ],
      [{ sku: "a", qty: 9 }],
    ]);
    expect(many.rows.map((row) => row.keyless)).toEqual([[{ label: "y" }], [{ label: "y" }], []]);
    expect(many.rows.map((row) => row.tags)).toEqual([["t1", "new"], ["new"], ["new"]]);
    expect(many.rows.map((row) => row.uniq)).toEqual([
      ["u", "w", "z"],
      ["v", "w", "z"],
      ["w", "z"],
    ]);
  });

  it("reads the keys locked in key order, then the operator columns by key (locked too), and writes each row by its key", async () => {
    const { adapter, table, seed } = setup();
    seed(...items());
    await table.updateMany({ status: "open" }, { tags: { $insert: ["x"] } } as any);

    const [pick, batch] = callsOf(adapter, "findMany").map((c) => c.args[0] as DbQuery);
    expect(pick!.filter).toEqual({ status: "open" });
    expect(pick!.controls.$sort).toEqual({ id: 1 });
    expect(pick!.controls.$select!.asArray).toEqual(["id"]);
    expect(pick!.lock).toEqual({ mode: "update", wait: "block" });
    // only the identity and the columns the operators touch — not whole rows
    expect(batch!.filter).toEqual({ id: { $in: [1, 2, 3] } });
    expect(batch!.controls.$select!.asArray).toEqual(["id", "tags"]);
    // locked too: a plain read could return the caller's older snapshot (REPEATABLE READ)
    expect(batch!.lock).toEqual({ mode: "update", wait: "block" });

    expect(callsOf(adapter, "updateMany").map((c) => c.args[0])).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    expect((adapter as RowMockAdapter).transactions).toBe(1);
  });

  it.each([
    [
      "$insert",
      { tags: { $insert: ["old", "z"] } },
      [
        ["t1", "old", "old", "z"],
        ["old", "old", "z"],
      ],
    ],
    ["$remove", { tags: { $remove: ["old"] } }, [["t1"], []]],
    [
      "$upsert",
      { tags: { $upsert: ["old", "z"] } },
      [
        ["t1", "old", "z"],
        ["old", "z"],
      ],
    ],
    ["$update without key props", { tags: { $update: ["old"] } }, [["t1", "old"], ["old"]]],
  ])("%s on an array without keys", async (_op, ops, expected) => {
    const { table, rows, seed } = setup();
    seed(...items().slice(0, 2));
    await table.updateMany({}, ops as any);
    expect(rows.map((row) => row.tags)).toEqual(expected);
  });

  it("keyed arrays: $update replaces (default) or merges (merge strategy) per row; $remove by key", async () => {
    const { table, rows, seed } = setup();
    seed(...items().slice(0, 2));
    await table.updateMany({}, {
      plain: { $update: [{ sku: "a", qty: 7 }], $remove: [{ sku: "c" }] },
      merged: {
        $update: [
          { sku: "a", qty: 7 },
          { sku: "b", qty: 8 },
        ],
      },
    } as any);
    expect(rows[0]!.plain).toEqual([
      { sku: "a", qty: 7 },
      { sku: "b", qty: 5 },
    ]);
    expect(rows[1]!.plain).toEqual([]);
    expect(rows[0]!.merged).toEqual([{ sku: "a", qty: 7, note: "keep" }]);
    expect(rows[1]!.merged).toEqual([{ sku: "b", qty: 8 }]);
  });

  it("a null array stays null when the operators have nothing to apply", async () => {
    const { table, rows, seed } = setup();
    seed(items()[2]!);
    await table.updateMany({}, { tags: { $update: ["x"] }, plain: { $insert: [] } } as any);
    expect(rows[0]!.tags).toBeNull();
    expect(rows[0]!.plain).toBeNull();
  });

  it("a renamed and a nested (flattened) array column: read and written under their columns", async () => {
    const { adapter, table, rows, seed } = setup();
    seed({ id: 1, w_col: [1], box__labels: ["a"] }, { id: 2, w_col: [2, 3], box__labels: null });
    await table.updateMany({}, {
      weights: { $insert: [9] },
      box: { labels: { $insert: ["b"] } },
    } as any);
    const batch = callsOf(adapter, "findMany")[1]!.args[0] as DbQuery;
    expect(batch.controls.$select!.asArray).toEqual(["id", "w_col", "box__labels"]);
    expect(rows.map((row) => [row.w_col, row.box__labels])).toEqual([
      [
        [1, 9],
        ["a", "b"],
      ],
      [[2, 3, 9], ["b"]],
    ]);
  });

  it("a plain set and field ops apply to every row next to the operator", async () => {
    const { adapter, table, rows, seed } = setup();
    seed(...items().slice(0, 2));
    await table.updateMany({}, { status: "done", tags: { $insert: ["x"] } } as any);
    expect(rows.map((row) => [row.status, row.tags])).toEqual([
      ["done", ["t1", "old", "x"]],
      ["done", ["old", "x"]],
    ]);
    // the `@db.onUpdate.inc` counter moves on each row's write
    for (const call of callsOf(adapter, "updateMany")) {
      expect(call.args[2]).toEqual({ inc: { rev: 1 } });
    }
  });

  it("zero matches: { 0, 0 } and no write", async () => {
    const { adapter, table, seed } = setup();
    seed(...items());
    expect(await table.updateMany({ status: "none" }, patch as any)).toEqual({
      matchedCount: 0,
      modifiedCount: 0,
    });
    expect(callsOf(adapter, "updateMany")).toEqual([]);
    expect(callsOf(adapter, "findMany")).toHaveLength(1);
  });

  it("the counts are what the row writes report — a row gone before its write is not counted", async () => {
    const { adapter, table, seed } = setup();
    seed(...items());
    const original = adapter.findMany.bind(adapter);
    adapter.findMany = async (query: DbQuery) => {
      const rows = await original(query);
      // the batch read finds row 2 gone (deleted after the pick)
      return query.controls.$select!.asArray!.length > 1 ? rows.filter((r) => r.id !== 2) : rows;
    };
    expect(await table.updateMany({}, { tags: { $insert: ["x"] } } as any)).toEqual({
      matchedCount: 2,
      modifiedCount: 2,
    });
  });

  it("a composite primary key: each row is picked and written by both key fields", async () => {
    const { adapter, table, rows, seed } = setup(fx.UmaPair);
    seed(
      { org: "a", code: 1, tags: ["x"] },
      { org: "a", code: 2, tags: [] },
      { org: "b", code: 1, tags: ["y"] },
    );
    await table.updateMany({ org: "a" }, { tags: { $insert: ["n"] } } as any);
    const batch = callsOf(adapter, "findMany")[1]!.args[0] as DbQuery;
    expect(batch.filter).toEqual({
      $or: [
        { org: "a", code: 1 },
        { org: "a", code: 2 },
      ],
    });
    expect(callsOf(adapter, "updateMany").map((c) => c.args[0])).toEqual([
      { org: "a", code: 1 },
      { org: "a", code: 2 },
    ]);
    expect(rows.map((row) => row.tags)).toEqual([["x", "n"], ["n"], ["y"]]);
  });

  it("a table without a primary key throws INVALID_QUERY naming the field; nothing is read or written", async () => {
    const { adapter, table, seed } = setup(fx.UmaLog);
    seed({ line: "a", tags: [] });
    const error = (await table
      .updateMany({}, { tags: { $insert: ["x"] } } as any)
      .catch((e: unknown) => e)) as DbError;
    expect(error).toBeInstanceOf(DbError);
    expect(error.code).toBe("INVALID_QUERY");
    expect(error.errors[0]!.path).toBe("tags");
    expect(error.errors[0]!.message).toMatch(/row by row, by primary key/);
    expect(adapter.calls.filter((c) => c.method !== "count")).toEqual([]);
  });

  it("an error on one row propagates out of the transaction — later rows are not written", async () => {
    const { adapter, table, seed } = setup();
    seed(...items().slice(0, 2), { id: 4, tags: '"not an array"' });
    seed({ id: 5, tags: ["z"] });
    await expect(table.updateMany({}, { tags: { $insert: ["x"] } } as any)).rejects.toThrow(
      'Cannot apply array patch operators to "tags": its stored value is not an array',
    );
    expect(callsOf(adapter, "updateMany").map((c) => c.args[0])).toEqual([{ id: 1 }, { id: 2 }]);
    expect((adapter as RowMockAdapter).transactions).toBe(1);
  });

  it("$cas stays refused", async () => {
    const { table } = setup(fx.UmaVersioned);
    await expect(
      table.updateMany({}, { tags: { $insert: ["x"] }, $cas: { version: 1 } } as any),
    ).rejects.toMatchObject({ code: "INVALID_QUERY", errors: [{ path: "$cas" }] });
  });
});

describe("updateMany with array operators — version column", () => {
  it("bumps each row unless the patch writes only version-exempt fields", async () => {
    const { adapter, table, seed } = setup(fx.UmaVersioned);
    seed({ id: 1, tags: [], version: 3 }, { id: 2, tags: ["a"], version: 7 });
    await table.updateMany({}, { tags: { $insert: ["x"] } } as any);
    const exempt = callsOf(adapter, "updateMany");
    expect(exempt.map((c) => c.args[3])).toEqual([{ keepVersion: true }, { keepVersion: true }]);
    adapter.calls.length = 0;
    await table.updateMany({}, { title: "t", tags: { $insert: ["y"] } } as any);
    const bumped = callsOf(adapter, "updateMany");
    expect(bumped).toHaveLength(2);
    expect(bumped.map((c) => c.args[3])).toEqual([undefined, undefined]);
    // never a CAS: no expected version reaches the adapter
    for (const call of bumped) expect(call.args[0]).toEqual({ id: call.args[0].id });
  });
});

describe("updateMany with array operators — bounded", () => {
  it("picks the first `limit` rows in sort order (locked), then writes them row by row", async () => {
    const { adapter, table, rows, seed } = setup();
    seed(...items());
    const result = await table.updateMany({}, { tags: { $insert: ["x"] } } as any, {
      limit: 2,
      sort: { id: -1 },
    });
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    const [pick] = callsOf(adapter, "findMany").map((c) => c.args[0] as DbQuery);
    expect(pick!.controls.$limit).toBe(2);
    expect(pick!.controls.$sort).toEqual({ id: -1 });
    expect(pick!.lock).toEqual({ mode: "update", wait: "block" });
    expect(callsOf(adapter, "updateMany").map((c) => c.args[0])).toEqual([{ id: 2 }, { id: 3 }]);
    expect(callsOf(adapter, "updateMany").every((c) => c.args[3]?.limit === undefined)).toBe(true);
    expect(rows.map((row) => row.tags)).toEqual([["t1", "old"], ["old", "x"], ["x"]]);
  });

  it("on an adapter with native bounded writes the rows are still picked first", async () => {
    class LimitAdapter extends RowMockAdapter {
      override supportsWriteLimit(): boolean {
        return true;
      }
    }
    const { adapter, table, seed } = setup(fx.UmaItem, new LimitAdapter());
    seed(...items());
    await table.updateMany({}, { tags: { $insert: ["x"] } } as any, { limit: 1 });
    expect(callsOf(adapter, "updateMany").map((c) => c.args.slice(0, 1))).toEqual([[{ id: 1 }]]);
    expect(callsOf(adapter, "updateMany")[0]!.args[3]).toBeUndefined();
  });
});

describe("updateMany with array operators — native-patch adapters", () => {
  class NativeManyAdapter extends DocumentMockAdapter {
    override supportsNativePatch(): boolean {
      return true;
    }
    override async nativePatchMany(
      filter: any,
      patch: unknown,
      ops?: any,
      opts?: TDbUpdateOptions,
    ): Promise<TDbUpdateResult> {
      this.record("nativePatchMany", filter, patch, ops, opts);
      return { matchedCount: 2, modifiedCount: 2 };
    }
  }

  class NativeOneAdapter extends DocumentMockAdapter {
    override supportsNativePatch(): boolean {
      return true;
    }
    override async nativePatch(filter: any, patch: unknown, ops?: any, ...rest: any[]) {
      this.record("nativePatch", filter, patch, ops, ...rest);
      return { matchedCount: 1, modifiedCount: 1 };
    }
  }

  it("nativePatchMany gets the filter and the patch as nativePatch would, once — no read", async () => {
    const { adapter, table, seed } = setup(fx.UmaItem, new NativeManyAdapter());
    seed(...items());
    const result = await table.updateMany({ status: "open" }, {
      status: "done",
      tags: { $insert: ["x"] },
      box: { labels: { $remove: ["a"] } },
    } as any);
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    const [call, ...more] = callsOf(adapter, "nativePatchMany");
    expect(more).toEqual([]);
    expect(call!.args[0]).toEqual({ status: "open" });
    expect(call!.args[1]).toEqual({
      status: "done",
      tags: { $insert: ["x"] },
      box: { labels: { $remove: ["a"] } },
    });
    expect(call!.args[2]).toEqual({ inc: { rev: 1 } });
    expect(callsOf(adapter, "findMany")).toEqual([]);
    expect(callsOf(adapter, "updateMany")).toEqual([]);
  });

  it("a bounded write calls nativePatchMany per batch of picked keys, never with a limit", async () => {
    const { adapter, table, seed } = setup(fx.UmaItem, new NativeManyAdapter());
    seed(...items());
    await table.updateMany({ status: "open" }, { tags: { $insert: ["x"] } } as any, { limit: 2 });
    const [call] = callsOf(adapter, "nativePatchMany");
    expect(call!.args[0]).toEqual({ $and: [{ status: "open" }, { id: { $in: [1, 2] } }] });
    expect(call!.args[3]).toBeUndefined();
  });

  it("without nativePatchMany: nativePatch once per matched row, by its primary key", async () => {
    const { adapter, table, seed } = setup(fx.UmaItem, new NativeOneAdapter());
    seed(...items());
    const result = await table.updateMany({ status: "open" }, { tags: { $insert: ["x"] } } as any);
    expect(result).toEqual({ matchedCount: 3, modifiedCount: 3 });
    const patches = callsOf(adapter, "nativePatch");
    expect(patches.map((c) => c.args[0])).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    for (const c of patches) {
      expect(c.args[1]).toEqual({ tags: { $insert: ["x"] } });
      expect(c.args[3]).toBeUndefined(); // no expected version
    }
    // the batch read asks for the keys only — the operators are not resolved here
    const batch = callsOf(adapter, "findMany")[1]!.args[0] as DbQuery;
    expect(batch.controls.$select!.asArray).toEqual(["id"]);
  });

  // Before 0.1.182 an operator inside a replace-strategy object went unseen
  // on a nested-object adapter: the patch reached a plain `updateMany`, which
  // stored the operator object as the array's value.
  it("an operator inside a replace-strategy object alone still takes nativePatchMany", async () => {
    const { adapter, table, seed } = setup(fx.UmaItem, new NativeManyAdapter());
    seed(...items());
    await table.updateMany({ status: "open" }, { box: { labels: { $insert: ["x"] } } } as any);
    const [call] = callsOf(adapter, "nativePatchMany");
    expect(call!.args[1]).toEqual({ box: { labels: { $insert: ["x"] } } });
    expect(callsOf(adapter, "updateMany")).toEqual([]);
  });

  // `$replace` decomposes to plain keys: inside a nested object they write
  // fields inside it, which a classic update cannot create under an object
  // stored as `null` — the native path (since 0.1.182)
  it("$replace alone inside a nested object takes nativePatchMany too", async () => {
    const { adapter, table, seed } = setup(fx.UmaItem, new NativeManyAdapter());
    seed(...items());
    const data = { box: { labels: { $replace: ["z"] } } };
    await table.updateMany({ status: "open" }, data as any);
    expect(callsOf(adapter, "nativePatchMany").map((c) => c.args[1])).toEqual([data]);
    expect(callsOf(adapter, "updateMany")).toEqual([]);
  });

  // A top-level `$replace` is a plain set of the array, which a classic
  // update stores as the pipeline does (since 0.1.183; it took the pipeline)
  it("$replace alone on a top-level array takes the plain updateMany", async () => {
    const { adapter, table, seed } = setup(fx.UmaItem, new NativeManyAdapter());
    seed(...items());
    await table.updateMany({ status: "open" }, { tags: { $replace: ["z"] } } as any);
    expect(callsOf(adapter, "nativePatchMany")).toEqual([]);
    expect(callsOf(adapter, "updateMany").map((c) => c.args[1])).toEqual([{ tags: ["z"] }]);
  });

  it("a patch without array operators still takes the plain updateMany", async () => {
    const { adapter, table, seed } = setup(fx.UmaItem, new NativeManyAdapter());
    seed(...items());
    await table.updateMany({ status: "open" }, { status: "done", tags: ["a"] } as any);
    expect(callsOf(adapter, "nativePatchMany")).toEqual([]);
    expect(callsOf(adapter, "updateMany")).toHaveLength(1);
  });
});

// A nested-object adapter without native patch support (the in-memory one)
// stores an object whole. With array operators inside, the table sets it leaf
// by leaf by dot path, as the flattening adapters store it, and reads each
// stored array from the nested document (since 0.1.182).
describe("array operators inside a nested object — nested-object adapter", () => {
  it("a replace-strategy object with an operator: dot paths, resolved from the nested document", async () => {
    const { adapter, table, seed } = setup(fx.UmaItem, new DocumentMockAdapter());
    seed({ id: 1, box: { labels: ["a"] } });
    await table.updateOne({ id: 1, box: { labels: { $insert: ["b"] } } } as any);
    expect(callsOf(adapter, "updateOne")[0]!.args[1]).toEqual({ "box.labels": ["a", "b"] });
  });

  it("updateMany reads the nested array by its document path", async () => {
    const { adapter, table, seed } = setup(fx.UmaItem, new DocumentMockAdapter());
    seed({ id: 1, box: { labels: ["a"] } }, { id: 2, box: { labels: [] } });
    await table.updateMany({}, { box: { labels: { $insert: ["n"] } } } as any);
    const batch = callsOf(adapter, "findMany")[1]!.args[0] as DbQuery;
    expect(batch.controls.$select!.asArray).toEqual(["id", "box.labels"]);
    expect(callsOf(adapter, "updateMany").map((c) => c.args[1])).toEqual([
      { "box.labels": ["a", "n"] },
      { "box.labels": ["n"] },
    ]);
  });

  it("without array operators the object is still set whole", async () => {
    const { adapter, table, seed } = setup(fx.UmaItem, new DocumentMockAdapter());
    seed({ id: 1, box: { labels: ["a"] } });
    await table.updateOne({ id: 1, box: { labels: ["z"] } } as any);
    expect(callsOf(adapter, "updateOne")[0]!.args[1]).toEqual({ box: { labels: ["z"] } });
  });
});

describe("updateMany without array operators is unchanged", () => {
  it("one adapter updateMany, no read, no transaction", async () => {
    const { adapter, table, seed } = setup();
    seed(...items());
    await table.updateMany({ status: "open" }, { status: "done", tags: ["a"] } as any);
    expect(adapter.calls.map((c) => c.method)).toEqual(["updateMany"]);
    expect((adapter as RowMockAdapter).transactions).toBe(0);
  });
});
