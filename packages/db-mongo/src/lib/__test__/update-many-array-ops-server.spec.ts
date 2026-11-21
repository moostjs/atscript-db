import { DbSpace } from "@atscript/db";
import type { AtscriptDbTable } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// `updateMany` with `$insert` / `$upsert` / `$update` / `$remove` (since
// 0.1.182; 0.1.180 – 0.1.181 refused them) against a real MongoDB
// (mongodb-memory-server): one `updateMany` statement with the update pipeline
// `updateOne` uses, so every matched document ends as `updateOne` leaves it.

let server: any;
let client: MongoClient;
let fx: Record<string, any>;

/** Documents with different stored arrays — the third holds none. */
const rows = () => [
  {
    id: 1,
    status: "open",
    tags: ["t1", "old"],
    uniq: ["u"],
    variants: [
      { sku: "a", qty: 1, note: "keep" },
      { sku: "b", qty: 5 },
    ],
    attrs: [{ name: "w", value: "1", unit: "g" }],
    notes: [{ text: "x" }, { text: "y", author: "bob" }],
    box: { caption: "c", labels: ["l1"] },
    seen: [],
  },
  {
    id: 2,
    status: "open",
    tags: ["old"],
    uniq: ["v", "w"],
    variants: [{ sku: "c", qty: 3 }],
    attrs: [],
    notes: [{ text: "y", author: "bob" }],
    box: { caption: "c", labels: [] },
    seen: ["s"],
  },
  { id: 3, status: "open" },
  { id: 4, status: "closed", tags: ["old"] },
];

const patch = {
  status: "done",
  tags: { $remove: ["old"], $insert: ["new"] },
  uniq: { $insert: ["w", "z"] },
  variants: { $update: [{ sku: "a", qty: 2 }], $insert: [{ sku: "n", qty: 1 }] },
  attrs: { $upsert: [{ name: "w", value: "2" }] },
  notes: { $remove: [{ text: "y", author: "bob" }] },
  box: { caption: "c", labels: { $insert: ["l2"] } },
};

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/update-many-array-ops.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

let dbSeq = 0;
/** A fresh database with the fixture tables, seeded with {@link rows}. */
async function freshSpace(): Promise<{ db: Db; items: AtscriptDbTable; plain: AtscriptDbTable }> {
  const db = client.db(`update_many_array_ops_${++dbSeq}`);
  const space = new DbSpace(() => new MongoAdapter(db, client));
  await new SchemaSync(space).run([fx.UmaItem, fx.UmaPlain], { force: true });
  const items = space.getTable(fx.UmaItem);
  await items.insertMany(rows() as any);
  return { db, items, plain: space.getTable(fx.UmaPlain) };
}

/** The documents in `id` order, without their generated `_id`. */
const all = async (table: AtscriptDbTable) =>
  ((await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map(
    ({ _id, ...row }) => row,
  );

describe("MongoDB updateMany with array operators", () => {
  let items: AtscriptDbTable;
  let plain: AtscriptDbTable;
  let collection: any;

  beforeEach(async () => {
    ({ items, plain } = await freshSpace());
    collection = (items.getAdapter() as unknown as MongoAdapter).collection;
  });

  afterEach(() => vi.restoreAllMocks());

  it("one updateMany statement; every document ends as updateOne leaves it", async () => {
    const updateMany = vi.spyOn(collection, "updateMany");
    const updateOne = vi.spyOn(collection, "updateOne");
    expect(await items.updateMany({ status: "open" }, patch as any)).toEqual({
      matchedCount: 3,
      modifiedCount: 3,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    const [filter, pipeline] = updateMany.mock.calls[0]!;
    expect(filter).toEqual({ status: "open" });
    expect(Array.isArray(pipeline)).toBe(true);
    expect(updateOne).not.toHaveBeenCalled();
    const many = await all(items);

    const other = await freshSpace();
    for (const id of [1, 2, 3]) await other.items.updateOne({ id, ...patch } as any);
    expect(many).toEqual(await all(other.items));

    expect(many.map((row) => row.tags)).toEqual([["t1", "new"], ["new"], ["new"], ["old"]]);
    expect(many.map((row) => row.variants)).toEqual([
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
      undefined,
    ]);
    expect(many.map((row) => row.attrs?.[0])).toEqual([
      { name: "w", value: "2", unit: "g" },
      { name: "w", value: "2" },
      { name: "w", value: "2" },
      undefined,
    ]);
    expect(many.map((row) => row.uniq)).toEqual([
      ["u", "w", "z"],
      ["v", "w", "z"],
      ["w", "z"],
      undefined,
    ]);
    expect(many.map((row) => row.notes)).toEqual([[{ text: "x" }], [], [], undefined]);
    expect(many.map((row) => row.box?.labels)).toEqual([["l1", "l2"], ["l2"], ["l2"], undefined]);
    expect(many.map((row) => [row.status, row.version])).toEqual([
      ["done", 1],
      ["done", 1],
      ["done", 1],
      ["closed", 0],
    ]);
  });

  it("a version-exempt patch keeps every version; a mixed one bumps each by one", async () => {
    await items.updateMany({}, { seen: { $insert: ["s2"] } } as any);
    expect((await all(items)).map((row) => [row.seen, row.version])).toEqual([
      [["s2"], 0],
      [["s", "s2"], 0],
      [["s2"], 0],
      [["s2"], 0],
    ]);
    await items.updateMany({}, { status: "x", seen: { $remove: ["s"] } } as any);
    expect((await all(items)).map((row) => [row.seen, row.version])).toEqual([
      [["s2"], 1],
      [["s2"], 1],
      [["s2"], 1],
      [["s2"], 1],
    ]);
  });

  it("a bounded write takes `limit` documents in sort order; looping until 0 patches each once", async () => {
    const updateMany = vi.spyOn(collection, "updateMany");
    const rounds: number[] = [];
    for (;;) {
      const { matchedCount } = await items.updateMany(
        { status: "open" },
        { status: "seen", tags: { $insert: ["x"] } } as any,
        { limit: 2, sort: { id: -1 } },
      );
      rounds.push(matchedCount);
      if (matchedCount === 0) break;
    }
    expect(rounds).toEqual([2, 1, 0]);
    expect(updateMany.mock.calls[0]![0]).toEqual({
      $and: [{ status: "open" }, { id: { $in: [3, 2] } }],
    });
    expect((await all(items)).map((row) => row.tags)).toEqual([
      ["t1", "old", "x"],
      ["old", "x"],
      ["x"],
      ["old"],
    ]);
  });

  it("an operator with nothing to apply sends no update — the honest match count only", async () => {
    await plain.insertMany([
      { id: 1, status: "open", tags: ["a"] },
      { id: 2, status: "open" },
      { id: 3, status: "closed" },
    ] as any);
    const plainCollection = (plain.getAdapter() as unknown as MongoAdapter).collection;
    const updateMany = vi.spyOn(plainCollection, "updateMany");
    expect(await plain.updateMany({ status: "open" }, { tags: { $insert: [] } } as any)).toEqual({
      matchedCount: 2,
      modifiedCount: 0,
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect((await all(plain)).map((row) => row.tags)).toEqual([["a"], undefined, undefined]);
  });

  // Before 0.1.182 a patch whose only operator sat inside a replace-strategy
  // object went to the plain update and stored `{ $insert: [...] }` there.
  it("an operator inside a replace-strategy object is applied when it is the patch's only one", async () => {
    await items.updateMany({ status: "open" }, {
      box: { caption: "k", labels: { $insert: ["l2"] } },
    } as any);
    expect((await all(items)).map((row) => row.box)).toEqual([
      { caption: "k", labels: ["l1", "l2"] },
      { caption: "k", labels: ["l2"] },
      { caption: "k", labels: ["l2"] },
      undefined,
    ]);
    await items.updateMany({ status: "open" }, { box: { labels: { $replace: ["z"] } } } as any);
    expect((await all(items)).map((row) => row.box)).toEqual([
      { caption: null, labels: ["z"] },
      { caption: null, labels: ["z"] },
      { caption: null, labels: ["z"] },
      undefined,
    ]);
  });

  // `$replace` decomposes to plain keys; a classic `$set` of them failed on a
  // parent stored as `null` ("Cannot create field … in element") after other
  // documents were written, and cleared a merge child's omitted children.
  // Inside an object it takes the update pipeline (since 0.1.182); on a
  // top-level array it is a plain set, which stores the same array (since
  // 0.1.183; it took the pipeline).
  describe("every write path gives the updateOne result", () => {
    const docs = [
      { id: 1, status: "s", box: null, outer: null },
      {
        id: 2,
        status: "s",
        box: { caption: "c", labels: ["x"] },
        outer: { title: "t", minner: { note: "n", labels: ["x"] } },
      },
      { id: 3, status: "s" },
    ];
    const shapes: Array<[string, Record<string, unknown>]> = [
      ["$replace alone under a replace-strategy parent", { box: { labels: { $replace: ["z"] } } }],
      [
        "$replace inside a merge child of a replaced object",
        { outer: { title: "t2", minner: { labels: { $replace: ["z"] } } } },
      ],
      [
        "$insert inside a merge child of a replaced object",
        { outer: { title: "t2", minner: { labels: { $insert: ["y"] } } } },
      ],
      [
        "$replace alone on a top-level array",
        { tags: { $replace: ["$secret", "$$ROOT", "$tags"] } },
      ],
    ];
    type TWrite = (table: AtscriptDbTable, data: Record<string, unknown>) => Promise<unknown>;
    const writes: Array<[string, TWrite]> = [
      ["updateMany", (table, data) => table.updateMany({ status: "s" } as any, data as any)],
      [
        "bulkUpdate",
        (table, data) => table.bulkUpdate(docs.map(({ id }) => ({ id, ...data })) as any),
      ],
    ];
    const reset = async (table: AtscriptDbTable) => {
      await table.deleteMany({} as any);
      await table.insertMany(docs as any);
    };

    for (const [shape, data] of shapes) {
      for (const [write, run] of writes) {
        it(`${write}: ${shape}`, async () => {
          await reset(items);
          await run(items, data);
          const reference = (await freshSpace()).items;
          await reset(reference);
          for (const { id } of docs) await reference.updateOne({ id, ...data } as any);
          expect(await all(items)).toEqual(await all(reference));
        });
      }
    }

    it("a merge child keeps its omitted children on MongoDB", async () => {
      await reset(items);
      await items.updateMany(
        { status: "s" } as any,
        {
          outer: { title: "t2", minner: { labels: { $replace: ["z"] } } },
        } as any,
      );
      const rows = await all(items);
      expect(rows.map((row) => row.outer)).toEqual([
        { title: "t2", minner: { labels: ["z"] } },
        { title: "t2", minner: { note: "n", labels: ["z"] } },
        { title: "t2", minner: { labels: ["z"] } },
      ]);
      expect(rows.map((row) => row.box)).toEqual([
        null,
        { caption: "c", labels: ["x"] },
        undefined,
      ]);
    });
  });

  it("a top-level $replace: one plain updateMany, `$` strings stored as sent, version bumped", async () => {
    const updateMany = vi.spyOn(collection, "updateMany");
    const before = await all(items);
    await items.updateMany({ status: "open" }, {
      tags: { $replace: ["$secret", "$$ROOT"] },
    } as any);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(Array.isArray(updateMany.mock.calls[0]![1])).toBe(false);
    const rows = await all(items);
    expect(rows.map((row) => row.tags)).toEqual([
      ["$secret", "$$ROOT"],
      ["$secret", "$$ROOT"],
      ["$secret", "$$ROOT"],
      ["old"],
    ]);
    expect(rows.map((row) => row.version - before.find((b) => b.id === row.id)!.version)).toEqual([
      1, 1, 1, 0,
    ]);
  });

  it("zero matches: { 0, 0 } and nothing changes", async () => {
    const before = await all(items);
    expect(await items.updateMany({ status: "none" }, patch as any)).toEqual({
      matchedCount: 0,
      modifiedCount: 0,
    });
    expect(await all(items)).toEqual(before);
  });
});
