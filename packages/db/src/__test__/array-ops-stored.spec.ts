import { describe, it, expect, beforeAll, vi } from "vite-plus/test";

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
let AosPhantom: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ AosItem, AosRenamed, AosKeyed, AosPhantom } = await import("./fixtures/array-ops-stored.as"));
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
function setupTable(type: any, adapter = new MockAdapter()) {
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

// The same cases run against a real MongoDB in db-mongo's
// `array-update-strategy-server.spec.ts`: the native pipeline and this
// read-modify-write give the same arrays (since 0.1.180).
describe("array operators: one behaviour on every adapter", () => {
  let nextId = 1;
  /** The arrays stored after `patch` is applied to a row seeded with `row`. */
  async function run(row: Record<string, unknown>, patch: Record<string, unknown>) {
    const { adapter, table, seed } = setupTable(AosKeyed);
    const id = nextId++;
    seed({ id, ...row });
    await table.updateOne({ id, ...patch } as any);
    return written(adapter) as Record<string, any>;
  }

  it("$insert on a keyed array skips an item whose key is stored; the first of two new items with one key stands", async () => {
    const row = await run(
      { plain: stored(), merged: stored() },
      {
        plain: {
          $insert: [
            { sku: "a", qty: 9 },
            { sku: "n", qty: 1 },
            { sku: "n", qty: 2 },
          ],
        },
        merged: { $insert: [{ sku: "b", qty: 9 }] },
      },
    );
    expect(row.plain).toEqual([...stored(), { sku: "n", qty: 1 }]);
    expect(row.merged).toEqual(stored());
  });

  it("$upsert on a keyed array changes the element where it is, and appends a new key", async () => {
    const items = [
      { sku: "a", qty: 2 },
      { sku: "n", qty: 1 },
    ];
    const row = await run(
      { plain: stored(), merged: stored() },
      { plain: { $upsert: items }, merged: { $upsert: items } },
    );
    expect(row.plain).toEqual([
      { sku: "a", qty: 2 },
      { sku: "b", qty: 5, note: "other" },
      { sku: "n", qty: 1 },
    ]);
    expect(row.merged).toEqual([
      { sku: "a", qty: 2, note: "keep" },
      { sku: "b", qty: 5, note: "other" },
      { sku: "n", qty: 1 },
    ]);
  });

  it("operators on an array without keys leave the other elements alone — duplicates and order kept", async () => {
    const tags = ["x", "y", "x", "z"];
    expect((await run({ tags }, { tags: { $remove: ["y"] } })).tags).toEqual(["x", "x", "z"]);
    expect((await run({ tags }, { tags: { $upsert: ["x", "w", "w"] } })).tags).toEqual([
      ...tags,
      "w",
    ]);
    expect((await run({ tags }, { tags: { $insert: ["x", "x"] } })).tags).toEqual([
      ...tags,
      "x",
      "x",
    ]);
    const keyless = [{ label: "x", note: "n" }, { label: "y" }, { label: "y" }];
    expect(
      (await run({ keyless }, { keyless: { $upsert: [{ label: "y" }, { label: "z" }] } })).keyless,
    ).toEqual([...keyless, { label: "z" }]);
    expect((await run({ keyless }, { keyless: { $remove: [{ label: "y" }] } })).keyless).toEqual([
      { label: "x", note: "n" },
    ]);
  });

  it("$insert on a unique array skips a value that is stored", async () => {
    const row = await run({ uniq: ["a", "b"] }, { uniq: { $insert: ["b", "c"] } });
    expect(row.uniq).toEqual(["a", "b", "c"]);
  });
});

// Edge cases of the read-modify-write that used to differ from MongoDB
// (fixed in 0.1.180).
describe("array operators: stored forms the resolver must cope with", () => {
  async function run(row: Record<string, unknown>, patch: Record<string, unknown>) {
    const { adapter, table, seed } = setupTable(AosKeyed);
    seed({ id: 1, ...row });
    await table.updateOne({ id: 1, ...patch } as any);
    return written(adapter) as Record<string, any>;
  }

  // PostgreSQL JSONB and MySQL JSON return an object with its keys in their
  // own order: an element is found whatever the order of its properties
  it("an element without keys is found whatever the order of its properties", async () => {
    const keyless = [{ note: "n", label: "x" }, { label: "y" }];
    const item = { label: "x", note: "n" };
    expect((await run({ keyless }, { keyless: { $remove: [item] } })).keyless).toEqual([
      { label: "y" },
    ]);
    const upserted = (await run({ keyless }, { keyless: { $upsert: [item] } })).keyless;
    expect(upserted).toHaveLength(2);
    // the stored element stays as it is, as on MongoDB (since 0.1.182; it
    // was replaced by the item, taking the item's property order)
    expect(Object.keys(upserted[0])).toEqual(["note", "label"]);
  });

  it("nested objects are compared the same way", async () => {
    const tags = [{ a: { y: 1, x: 2 } }] as unknown as string[];
    const table = setupTable(AosKeyed);
    table.seed({ id: 1, tags });
    // not a valid payload for string[] — the comparison itself is what is checked
    const { resolveArrayOps } = await import("../patch/array-ops-resolver");
    const resolved = resolveArrayOps(
      { "tags.__$remove": [{ a: { x: 2, y: 1 } }] },
      { id: 1, tags },
      table.table as any,
    );
    expect(resolved.tags).toEqual([]);
  });

  it("a null array stays null when the operators have nothing to apply", async () => {
    expect((await run({ tags: null }, { tags: { $update: ["x"] } })).tags).toBeNull();
    expect((await run({ tags: null }, { tags: { $insert: [] } })).tags).toBeNull();
    expect((await run({ plain: null }, { plain: { $update: [] } })).plain).toBeNull();
    // an operator with something to apply starts from an empty array
    expect((await run({ tags: null }, { tags: { $remove: ["x"] } })).tags).toEqual([]);
    expect((await run({ tags: null }, { tags: { $insert: ["x"] } })).tags).toEqual(["x"]);
    expect(
      (await run({ plain: null }, { plain: { $update: [{ sku: "a", qty: 1 }] } })).plain,
    ).toEqual([]);
  });

  it("a null element in a keyed array matches no key and stays where it is", async () => {
    const plain = [null, { sku: "a", qty: 1 }];
    const row = await run(
      { plain, merged: plain },
      {
        plain: { $insert: [{ sku: "b", qty: 2 }], $update: [{ sku: "a", qty: 3 }] },
        merged: { $upsert: [{ sku: "a", qty: 4 }], $remove: [{ sku: "zz" }] },
      },
    );
    expect(row.plain).toEqual([null, { sku: "a", qty: 3 }, { sku: "b", qty: 2 }]);
    expect(row.merged).toEqual([null, { sku: "a", qty: 4 }]);
  });
});

// `$insert` / `$upsert` / `$update` / `$remove` in `updateMany` apply to each
// matched row (since 0.1.182) — see `update-many-array-ops.spec.ts`.
describe("updateMany with an array field", () => {
  it("a plain array value is written in one statement", async () => {
    const { adapter, table, seed } = setupTable(AosRenamed);
    seed({ id: 1, u_col: ["a"] });
    await table.updateMany({ id: 1 }, { uniq: ["b", "c"] } as any);
    expect(adapter.calls.findLast((c) => c.method === "updateMany")!.args[1]).toMatchObject({
      u_col: JSON.stringify(["b", "c"]),
    });
  });
});

// A `phantom` prop of the element type is display-only: it is never stored, so
// the replace-strategy check of `$update` ("every required field is there")
// must not ask for it (since 0.1.181; before, every such `$update` was refused
// with PATCH_FIELD_REQUIRED and there was no item that passed).
describe("array operators on an element type with a phantom prop", () => {
  it.each(["$update", "$upsert", "$insert"])(
    "%s of a whole element is accepted without the phantom prop",
    async (op) => {
      const { adapter, table, seed } = setupTable(AosPhantom);
      seed({ id: 1, lines: JSON.stringify([{ sku: "a", qty: 1, note: "n" }]) });
      const sku = op === "$insert" ? "b" : "a";

      await table.updateOne({ id: 1, lines: { [op]: [{ sku, qty: 2 }] } } as never);

      const lines = written(adapter).lines;
      expect(typeof lines === "string" ? JSON.parse(lines) : lines).toEqual(
        op === "$insert"
          ? [
              { sku: "a", qty: 1, note: "n" },
              { sku: "b", qty: 2 },
            ]
          : [{ sku: "a", qty: 2 }],
      );
    },
  );

  it("$update that lacks a required data field is still refused", async () => {
    const { table, seed } = setupTable(AosPhantom);
    seed({ id: 1, lines: JSON.stringify([{ sku: "a", qty: 1 }]) });

    await expect(
      table.updateOne({ id: 1, lines: { $update: [{ sku: "a" }] } } as never),
    ).rejects.toMatchObject({
      errors: [{ code: "PATCH_FIELD_REQUIRED", params: { field: "qty" } }],
    });
  });
});

/** The queries `findOne` received. */
const reads = (adapter: MockAdapter) =>
  adapter.calls.filter((c) => c.method === "findOne").map((c) => c.args[0]);

// The read of the read-modify-write takes an exclusive row lock where the
// adapter takes row locks (since 0.1.182): two concurrent operator patches of
// one row no longer read the same array, so neither change is lost.
describe("the read-modify-write locks the row it reads", () => {
  class LockingMockAdapter extends MockAdapter {
    override supportsReadLocks(): boolean {
      return true;
    }
  }

  it("an adapter with row locks: the read asks for an exclusive lock, updateOne and bulkUpdate alike", async () => {
    const { adapter, table, seed } = setupTable(AosKeyed, new LockingMockAdapter());
    seed({ id: 1, tags: ["a"] });
    await table.updateOne({ id: 1, tags: { $insert: ["b"] } } as any);
    await table.bulkUpdate([{ id: 1, tags: { $remove: ["a"] } }] as any);
    expect(reads(adapter)).toEqual([
      { filter: { id: 1 }, controls: {}, lock: { mode: "update", wait: "block" } },
      { filter: { id: 1 }, controls: {}, lock: { mode: "update", wait: "block" } },
    ]);
  });

  it("an adapter without row locks reads as before", async () => {
    const { adapter, table, seed } = setupTable(AosKeyed);
    seed({ id: 1, tags: ["a"] });
    await table.updateOne({ id: 1, tags: { $insert: ["b"] } } as any);
    expect(reads(adapter)).toEqual([{ filter: { id: 1 }, controls: {} }]);
  });
});
