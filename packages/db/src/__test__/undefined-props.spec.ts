import { ValidatorError } from "@atscript/typescript/utils";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { AtscriptDbTable, _cloneWritePayload } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * `undefined` write props (since 0.1.128) — I4: `undefined` ≡ absent,
 * `null` ≡ explicit NULL, at every plain-object depth the framework maps to
 * storage, on every write path. Pruning happens once at the table entry,
 * before defaults and validation, via `_cloneWritePayload`.
 *
 * MockAdapter has no native defaults, so `_applyDefaults` fills `@db.default`
 * values in the SDK — an `undefined` on a defaulted field must therefore end
 * up as the DEFAULT, never as NULL.
 */

let WsItem: any;

beforeAll(async () => {
  await prepareFixtures();
  WsItem = (await import("./fixtures/write-semantics.as")).WsItem;
});

function makeTable(): { table: AtscriptDbTable; adapter: MockAdapter } {
  const adapter = new MockAdapter();
  const table = new AtscriptDbTable(WsItem, adapter);
  return { table, adapter };
}

function lastCall(adapter: MockAdapter, method: string): any[] {
  const calls = adapter.calls.filter((c) => c.method === method);
  expect(calls.length, `expected a recorded ${method} call`).toBeGreaterThan(0);
  return calls[calls.length - 1]!.args;
}

describe("insert paths", () => {
  it("insertOne: undefined on a defaulted field yields the default, undefined optional is absent, null stays null", async () => {
    const { table, adapter } = makeTable();
    await table.insertOne({
      id: 1,
      name: "a",
      cap: undefined,
      note: undefined,
      counter: null,
    } as any);
    const [rows] = lastCall(adapter, "insertMany");
    const row = rows[0];
    expect(row.cap).toBe(10000);
    expect("note" in row).toBe(false);
    expect(row.counter).toBeNull();
  });

  it("insertMany: prunes per row", async () => {
    const { table, adapter } = makeTable();
    await table.insertMany([
      { id: 1, name: "a", note: undefined },
      { id: 2, name: "b", note: "keep" },
    ] as any[]);
    const [rows] = lastCall(adapter, "insertMany");
    expect("note" in rows[0]).toBe(false);
    expect(rows[1].note).toBe("keep");
  });

  it("flattened nested object: an undefined optional leaf is identical to omitting it", async () => {
    const withUndefined = makeTable();
    await withUndefined.table.insertOne({
      id: 1,
      name: "a",
      address: { city: "X", line2: undefined },
    } as any);
    const omitted = makeTable();
    await omitted.table.insertOne({ id: 1, name: "a", address: { city: "X" } } as any);
    expect(lastCall(withUndefined.adapter, "insertMany")).toEqual(
      lastCall(omitted.adapter, "insertMany"),
    );
  });

  it("bulkReplace drops undefined props", async () => {
    const { table, adapter } = makeTable();
    await table.bulkReplace([{ id: 1, name: "a", note: undefined, counter: null }] as any[]);
    const [, data] = lastCall(adapter, "replaceOne");
    expect("note" in data).toBe(false);
    expect(data.counter).toBeNull();
  });

  it("replaceMany drops undefined props", async () => {
    const { table, adapter } = makeTable();
    await table.replaceMany({} as any, { id: 1, name: "a", note: undefined } as any);
    const [, data] = lastCall(adapter, "replaceMany");
    expect("note" in data).toBe(false);
  });

  it("preValidateItems: undefined on a defaulted field passes; on a required field it fails like omission", async () => {
    const { table } = makeTable();
    await expect(
      table.preValidateItems([{ id: 1, name: "a", cap: undefined }]),
    ).resolves.toBeUndefined();
    await expect(table.preValidateItems([{ id: 1, name: undefined }])).rejects.toBeInstanceOf(
      ValidatorError,
    );
  });
});

describe("patch paths", () => {
  it("updateOne never SETs an undefined key; null is an explicit SET", async () => {
    const { table, adapter } = makeTable();
    await table.updateOne({ id: 1, name: "n", note: undefined, counter: null } as any);
    const [, data] = lastCall(adapter, "updateOne");
    expect("note" in data).toBe(false);
    expect(data.name).toBe("n");
    expect(data.counter).toBeNull();
  });

  it("bulkUpdate prunes per item", async () => {
    const { table, adapter } = makeTable();
    await table.bulkUpdate([
      { id: 1, name: "n", note: undefined },
      { id: 2, note: null },
    ] as any[]);
    const calls = adapter.calls.filter((c) => c.method === "updateOne");
    expect(calls).toHaveLength(2);
    expect("note" in calls[0]!.args[1]).toBe(false);
    expect(calls[1]!.args[1].note).toBeNull();
  });

  it("updateMany prunes the patch", async () => {
    const { table, adapter } = makeTable();
    await table.updateMany({} as any, { name: "n", note: undefined } as any);
    const [, data] = lastCall(adapter, "updateMany");
    expect(data).toEqual({ name: "n" });
  });

  // WHY (review #7): a flattened parent without merge strategy has REPLACE
  // semantics — absent optional leaves are null-filled by the decomposer. The
  // undefined leaf therefore behaves exactly like omission (NULL), not "untouched".
  it("flattened non-merge parent: undefined leaf ≡ omitted leaf (null-filled, same as omission)", async () => {
    const a = makeTable();
    await a.table.updateOne({ id: 1, address: { city: "X", line2: undefined } } as any);
    const b = makeTable();
    await b.table.updateOne({ id: 1, address: { city: "X" } } as any);
    const dataA = lastCall(a.adapter, "updateOne")[1];
    const dataB = lastCall(b.adapter, "updateOne")[1];
    expect(dataA).toEqual(dataB);
    expect(dataA.address__line2).toBeNull();
  });

  // WHY: merge-strategy blocks are patched per leaf — an undefined leaf is not
  // touched at all (no key in the SET list).
  it("merge-strategy block: undefined leaf is untouched", async () => {
    const { table, adapter } = makeTable();
    await table.updateOne({ id: 1, stats: { views: 3, rating: undefined } } as any);
    const [, data] = lastCall(adapter, "updateOne");
    expect(data.stats__views).toBe(3);
    expect("stats__rating" in data).toBe(false);
  });

  it("{ $inc: undefined } prunes to {} and is rejected by validation (same as sending {})", async () => {
    const { table } = makeTable();
    await expect(
      table.updateOne({ id: 1, counter: { $inc: undefined } } as any),
    ).rejects.toBeInstanceOf(ValidatorError);
  });
});

describe("recursion boundaries", () => {
  it("recurses through nested arrays (an object inside an array inside an array is pruned too)", () => {
    const inner = [1, 2];
    const source = { grid: [[{ a: undefined, b: 1 }], inner], flat: inner };
    const out = _cloneWritePayload(source);
    expect(out).toEqual({ grid: [[{ b: 1 }], inner], flat: inner });
    expect((out.grid as unknown[])[1]).toBe(inner); // arrays without object elements: by reference
    expect(out.flat).toBe(inner);
    expect(source.grid[0]![0]).toEqual({ a: undefined, b: 1 }); // never mutates the source
  });

  it("recurses into plain-object elements of arrays without dropping or reordering elements", async () => {
    const { table, adapter } = makeTable();
    await table.insertOne({
      id: 1,
      name: "a",
      payload: { a: undefined, items: [{ x: 1, y: undefined }, { x: undefined }, { y: "z" }] },
    } as any);
    const [rows] = lastCall(adapter, "insertMany");
    const raw = rows[0].payload;
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    expect("a" in payload).toBe(false);
    expect(payload.items).toEqual([{ x: 1 }, {}, { y: "z" }]);
  });

  it("never drops undefined array ELEMENTS (positional; JSON turns them into null)", async () => {
    const { table, adapter } = makeTable();
    await table.updateMany({} as any, { tags: ["a", undefined, "b"] } as any);
    const [, data] = lastCall(adapter, "updateMany");
    expect(data.tags).toHaveLength(3);
    expect(data.tags[1]).toBeUndefined();
  });

  it("leaves class instances (Date, Uint8Array) untouched and by reference", async () => {
    const { table, adapter } = makeTable();
    const when = new Date("2026-01-01T00:00:00Z");
    const blob = new Uint8Array([1, 2, 3]);
    await table.updateMany({} as any, { when, blob } as any);
    const [, data] = lastCall(adapter, "updateMany");
    expect(data.when).toBe(when);
    expect(data.blob).toBe(blob);
  });

  it("never mutates the caller's payload tree", async () => {
    const { table } = makeTable();
    const address = { city: "X", line2: undefined };
    const payload = { id: 1, name: "a", note: undefined, address };
    await table.insertOne(payload as any);
    expect("note" in payload).toBe(true);
    expect("line2" in address).toBe(true);
    expect(payload.address).toBe(address);
  });
});
