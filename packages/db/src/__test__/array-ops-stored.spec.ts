import { describe, it, expect, beforeAll, vi } from "vite-plus/test";

import { DbError } from "../db-error";
import { AtscriptDbTable } from "../table/db-table";
import type { TDbFieldMeta } from "../types";
import { MockAdapter, prepareFixtures } from "./test-utils";

// An array patch operator (`$insert`, `$remove`, …) on an adapter without
// native patch support is a read-modify-write: the stored value is read raw
// from the adapter. Since 0.1.178 it is decoded through the column's
// `fromStorage` formatter first, as a read decodes it — a column the adapter
// stores in its own form (SQLite: a vector as a Float32 BLOB) was otherwise
// taken for the array (the BLOB's bytes). The formatter is looked up by the
// physical column, so a `@db.column` rename finds it. Its result is used only
// when it is an array — anything else continues as stored, as before — and a
// value that is still not an array throws instead of being spread item by item.

let AosItem: any;
let AosRenamed: any;
let AosKeyed: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ AosItem, AosRenamed, AosKeyed } = await import("./fixtures/array-ops-stored.as"));
});

/** Postgres's JSON / JSONB formatter: a JSON string value read back is re-encoded as JSON text. */
const reencodeJsonString = (value: unknown) =>
  typeof value === "string" ? JSON.stringify(value) : value;

/**
 * Stores `scores` / `weights` as `enc:<json>` — text the resolver's own JSON
 * parse would reject; with `pgTags`, `tags` gets Postgres's JSONB formatter.
 */
function setup({ pgTags = false } = {}) {
  const adapter = new MockAdapter();
  const fromStorage = vi.fn((value: unknown) =>
    typeof value === "string" && value.startsWith("enc:") ? JSON.parse(value.slice(4)) : value,
  );
  adapter.formatValue = (field: TDbFieldMeta) => {
    if (field.path === "scores" || field.path === "weights") {
      return {
        toStorage: (value: unknown) => (typeof value === "string" ? `enc:${value}` : value),
        fromStorage,
      };
    }
    return pgTags && field.path === "tags"
      ? { toStorage: (value: unknown) => value, fromStorage: reencodeJsonString }
      : undefined;
  };
  const table = new AtscriptDbTable(AosItem, adapter);
  const rows = adapter.store;
  rows.set(table.tableName, []);
  return {
    adapter,
    table,
    fromStorage,
    seed: (row: object) => rows.get(table.tableName)!.push({ ...row }),
  };
}

/** A table of `type` on a fresh `MockAdapter`, with no rows. */
function setupTable(type: any) {
  const adapter = new MockAdapter();
  const table = new AtscriptDbTable(type, adapter);
  adapter.store.set(table.tableName, []);
  return {
    adapter,
    table,
    seed: (row: object) => adapter.store.get(table.tableName)!.push({ ...row }),
  };
}

/** The update the adapter received for the last `updateOne`. */
const written = (adapter: MockAdapter) =>
  adapter.calls.findLast((c) => c.method === "updateOne")!.args[1] as Record<string, unknown>;
const updates = (adapter: MockAdapter) => adapter.calls.filter((c) => c.method === "updateOne");

describe("array patch operators read the stored value through fromStorage", () => {
  it("a formatted column — renamed too — applies the ops to the decoded array", async () => {
    const { adapter, table, fromStorage, seed } = setup();
    seed({ id: 1, scores: "enc:[1,2]", w_col: "enc:[3]" });
    await table.updateOne({
      id: 1,
      scores: { $insert: [9], $remove: [1] },
      weights: { $insert: [4] },
    } as any);
    // the resolved arrays are written as any update value (no toStorage on this path)
    expect(written(adapter)).toMatchObject({ scores: [2, 9], w_col: [3, 4] });
    expect(fromStorage).toHaveBeenCalledWith("enc:[1,2]");
    expect(fromStorage).toHaveBeenCalledWith("enc:[3]");
  });

  it("a column without a formatter behaves as before: JSON text parsed, an array taken as is", async () => {
    const { adapter, table, fromStorage, seed } = setup();
    seed({ id: 1, tags: '["a"]' });
    seed({ id: 2, tags: ["x"] });
    await table.updateOne({ id: 1, tags: { $insert: ["b"] } } as any);
    expect(written(adapter)).toMatchObject({ tags: ["a", "b"] });
    await table.updateOne({ id: 2, tags: { $insert: ["y"] } } as any);
    expect(written(adapter)).toMatchObject({ tags: ["x", "y"] });
    expect(fromStorage).not.toHaveBeenCalled();
  });

  it("a null or missing stored value is [] — the formatter is not called for it", async () => {
    const { adapter, table, fromStorage, seed } = setup();
    seed({ id: 1, scores: null });
    await table.updateOne({ id: 1, scores: { $insert: [5] }, weights: { $insert: [6] } } as any);
    expect(written(adapter)).toMatchObject({ scores: [5], w_col: [6] });
    expect(fromStorage).not.toHaveBeenCalled();
  });

  // Postgres hands JSONB back parsed; its formatter re-encodes a JSON string
  // value. A string result is no array, so the stored value is used as before.
  describe("Postgres's JSONB formatter on an array column: results as before 0.1.178", () => {
    it("a parsed array: the ops apply to it", async () => {
      const { adapter, table, seed } = setup({ pgTags: true });
      seed({ id: 1, tags: ["a"] });
      await table.updateOne({ id: 1, tags: { $insert: ["x"] } } as any);
      expect(written(adapter)).toMatchObject({ tags: ["a", "x"] });
    });

    it('a JSON string scalar ("abc"): the SyntaxError of its parse, nothing written', async () => {
      const { adapter, table, seed } = setup({ pgTags: true });
      seed({ id: 1, tags: "abc" });
      await expect(table.updateOne({ id: 1, tags: { $insert: ["x"] } } as any)).rejects.toThrow(
        SyntaxError,
      );
      expect(updates(adapter)).toEqual([]);
    });

    it('a JSON string holding JSON text (\'["a"]\'): parsed, the ops apply to ["a"]', async () => {
      const { adapter, table, seed } = setup({ pgTags: true });
      seed({ id: 1, tags: '["a"]' });
      await table.updateOne({ id: 1, tags: { $insert: ["x"] } } as any);
      expect(written(adapter)).toMatchObject({ tags: ["a", "x"] });
    });
  });

  it("a stored value that is not an array throws, naming the field; nothing is written", async () => {
    const { adapter, table, seed } = setup();
    // JSON text of a string, an object, a formatted column decoding to no array (bytes)
    seed({ id: 1, tags: '"abc"' });
    seed({ id: 2, tags: { x: 1 } });
    seed({ id: 3, scores: Buffer.from([1, 2, 3]) });
    for (const [id, field, item] of [
      [1, "tags", "x"],
      [2, "tags", "x"],
      [3, "scores", 1],
    ] as const) {
      await expect(
        table.updateOne({ id, [field]: { $insert: [item] } } as any),
        `${field} of row ${id}`,
      ).rejects.toThrow(
        `Cannot apply array patch operators to "${field}": its stored value is not an array`,
      );
    }
    expect(updates(adapter)).toEqual([]);
  });
});

// The column's array settings are annotations of the logical field. Before
// 0.1.178 they were looked up by the physical column name, so a renamed
// (`@db.column`) or flattened array column lost `uniqueItems` (`$insert`
// stored a duplicate) and its merge strategy (`$upsert` replaced the item).
describe("array patch operators on a renamed or flattened column keep its array settings", () => {
  it("uniqueItems: $insert of a value already stored does not add it twice", async () => {
    const { adapter, table, seed } = setupTable(AosRenamed);
    seed({ id: 1, u_col: ["a"], box__labels: ["x"] });
    await table.updateOne({
      id: 1,
      uniq: { $insert: ["a", "b"] },
      box: { labels: { $insert: ["x", "y"] } },
    } as any);
    expect(written(adapter)).toMatchObject({ u_col: ["a", "b"], box__labels: ["x", "y"] });
  });

  it("merge strategy: $upsert of a matching item keeps the fields it does not name", async () => {
    const { adapter, table, seed } = setupTable(AosRenamed);
    seed({ id: 1, m_col: [{ sku: "a", qty: 1, note: "keep" }] });
    await table.updateOne({ id: 1, merged: { $upsert: [{ sku: "a", qty: 2 }] } } as any);
    expect(written(adapter)).toMatchObject({ m_col: [{ sku: "a", qty: 2, note: "keep" }] });
  });
});

/** The keyed array a row is seeded with. */
const stored = () => [
  { sku: "a", qty: 1, note: "keep" },
  { sku: "b", qty: 5, note: "other" },
];

// `$update` follows the array's patch strategy, as `$upsert` does and as
// MongoDB applies it natively. Before 0.1.180 this read-modify-write path
// merged under both strategies, so the same update kept an omitted optional
// field here and cleared it on MongoDB.
describe("array $update follows the patch strategy", () => {
  it("replace strategy (default): the matched element becomes the item; the rest is untouched", async () => {
    const { adapter, table, seed } = setupTable(AosKeyed);
    seed({ id: 1, plain: stored() });
    await table.updateOne({ id: 1, plain: { $update: [{ sku: "a", qty: 2 }] } } as any);
    expect(written(adapter).plain).toEqual([
      { sku: "a", qty: 2 },
      { sku: "b", qty: 5, note: "other" },
    ]);
  });

  it("merge strategy: the matched element keeps the fields the item does not name", async () => {
    const { adapter, table, seed } = setupTable(AosKeyed);
    seed({ id: 1, merged: stored() });
    await table.updateOne({ id: 1, merged: { $update: [{ sku: "a", qty: 2 }] } } as any);
    expect(written(adapter).merged).toEqual([
      { sku: "a", qty: 2, note: "keep" },
      { sku: "b", qty: 5, note: "other" },
    ]);
  });

  it("an item whose key matches nothing changes nothing — $update never inserts", async () => {
    const { adapter, table, seed } = setupTable(AosKeyed);
    seed({ id: 1, plain: stored(), merged: stored() });
    await table.updateOne({
      id: 1,
      plain: { $update: [{ sku: "zz", qty: 9 }] },
      merged: { $update: [{ sku: "zz", qty: 9 }] },
    } as any);
    expect(written(adapter)).toMatchObject({ plain: stored(), merged: stored() });
  });

  it("a key given twice: items apply in order — the last one stands, merged over the first under merge", async () => {
    const { adapter, table, seed } = setupTable(AosKeyed);
    seed({ id: 1, plain: stored(), merged: stored() });
    const items = [
      { sku: "a", qty: 2, note: "first" },
      { sku: "a", qty: 3 },
    ];
    await table.updateOne({ id: 1, plain: { $update: items }, merged: { $update: items } } as any);
    expect((written(adapter).plain as unknown[])[0]).toEqual({ sku: "a", qty: 3 });
    expect((written(adapter).merged as unknown[])[0]).toEqual({ sku: "a", qty: 3, note: "first" });
  });

  it("an array without key props: $update changes nothing", async () => {
    const { adapter, table, seed } = setupTable(AosKeyed);
    seed({ id: 1, keyless: [{ label: "x", note: "n" }], tags: ["a"] });
    await table.updateOne({
      id: 1,
      keyless: { $update: [{ label: "x" }, { label: "new" }] },
      tags: { $update: ["a", "b"] },
    } as any);
    expect(written(adapter)).toMatchObject({ keyless: [{ label: "x", note: "n" }], tags: ["a"] });
  });
});

// `updateMany` is one statement for every matched row, and an array operator
// needs each row's stored array. Before 0.1.180 the operator object itself
// was written into the column of every matched row.
describe("updateMany refuses array patch operators", () => {
  it("throws INVALID_QUERY naming the field — renamed and nested too; nothing reaches the adapter", async () => {
    const { adapter, table, seed } = setupTable(AosRenamed);
    seed({ id: 1, u_col: ["a"], box__labels: ["x"] });
    const error = await table
      .updateMany({ id: 1 }, {
        uniq: { $insert: ["b"] },
        box: { labels: { $remove: ["x"] } },
      } as any)
      .then(
        () => undefined,
        (e: unknown) => e as DbError,
      );
    expect(error).toBeInstanceOf(DbError);
    expect(error!.code).toBe("INVALID_QUERY");
    expect(error!.errors.map((e) => e.path).toSorted()).toEqual(["box.labels", "uniq"]);
    expect(error!.errors[0]!.message).toMatch(/not supported by updateMany/);
    expect(adapter.calls.filter((c) => c.method === "updateMany")).toEqual([]);
  });

  it("a plain array value is still written", async () => {
    const { adapter, table, seed } = setupTable(AosRenamed);
    seed({ id: 1, u_col: ["a"] });
    await table.updateMany({ id: 1 }, { uniq: ["b", "c"] } as any);
    expect(adapter.calls.findLast((c) => c.method === "updateMany")!.args[1]).toMatchObject({
      u_col: JSON.stringify(["b", "c"]),
    });
  });
});
