import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Collection, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { CollectionPatcher } from "../collection-patcher";
import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Arrays without key props whose elements are objects, against a real
// MongoDB (mongodb-memory-server): an element equals an item whatever the
// order of the objects' properties, at every depth, as on the other adapters
// (since 0.1.182; before, BSON equality — stored property order — so a
// re-ordered `$remove` item removed nothing and a re-ordered `$upsert` /
// unique `$insert` item was appended next to the equal element). What is
// stored keeps its own property order.

let server: any;
let client: MongoClient;
let table: any;
let adapter: MongoAdapter;
let raw: Collection;

beforeAll(async () => {
  await prepareFixtures();
  const fx = await import("./fixtures/keyless-order.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  const db = client.db("keyless_order");
  const space = new DbSpace(() => new MongoAdapter(db, client));
  await new SchemaSync(space).run([fx.KeylessOrder], { force: true });
  table = space.getTable(fx.KeylessOrder);
  adapter = space.getAdapter(fx.KeylessOrder) as unknown as MongoAdapter;
  raw = db.collection("keyless_order");
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

let nextId = 1;
/** The row after `patch` is applied to one seeded with `row`. */
async function run(row: Record<string, unknown>, patch: Record<string, unknown>) {
  const id = nextId++;
  await table.insertOne({ id, ...row });
  await table.updateOne({ id, ...patch });
  return table.findOne({ filter: { id } });
}

/**
 * The stored document after the pipeline the patcher builds for `patch` —
 * applied without validation, to reach stored shapes and items the schema
 * does not allow. `stored` is written as it is.
 */
async function runRaw(stored: Record<string, unknown>, patch: Record<string, unknown>) {
  const id = nextId++;
  const { insertedId } = await raw.insertOne({ id, ...stored });
  const args = new CollectionPatcher(adapter.getPatcherContext(), {
    _id: insertedId,
    ...patch,
  })
    .preparePatch()
    .toArgs();
  await raw.updateOne(...(args as [any, any, any]));
  return raw.findOne({ _id: insertedId });
}

const keysOf = (elements: object[]) => elements.map((el) => Object.keys(el));

describe("MongoDB: elements without key props, whatever the order of their properties", () => {
  it("$remove of a re-ordered item takes out every equal element; the others stay as stored", async () => {
    const row = await run(
      {
        entries: [
          { label: "x", note: "n" },
          { note: "k", label: "keep" },
          { label: "x", note: "n" },
          { note: "n", label: "x" },
        ],
      },
      { entries: { $remove: [{ note: "n", label: "x" }] } },
    );
    expect(row.entries).toEqual([{ note: "k", label: "keep" }]);
    expect(keysOf(row.entries)).toEqual([["note", "label"]]);
  });

  it("nested objects are compared the same way, an empty one included", async () => {
    const row = await run(
      {
        entries: [
          { label: "m", meta: { a: 1, b: "z" } },
          { label: "m", meta: { a: 1 } },
          { label: "e", meta: {} },
          { label: "e", meta: { a: 1 } },
        ],
      },
      {
        entries: {
          $remove: [
            { meta: { b: "z", a: 1 }, label: "m" },
            { label: "e", meta: {} },
          ],
        },
      },
    );
    expect(row.entries).toEqual([
      { label: "m", meta: { a: 1 } },
      { label: "e", meta: { a: 1 } },
    ]);
  });

  it("an array inside an element is compared in order, its objects whatever their order", async () => {
    const stored = [
      {
        label: "p",
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        codes: ["a", "b"],
      },
    ];
    const reversed = await run(
      { entries: stored },
      {
        entries: {
          $remove: [
            { label: "p", points: [stored[0]!.points[1], stored[0]!.points[0]], codes: ["a", "b"] },
            { label: "p", points: stored[0]!.points, codes: ["b", "a"] },
          ],
        },
      },
    );
    expect(reversed.entries).toEqual(stored);
    const reordered = await run(
      { entries: stored },
      {
        entries: {
          $remove: [
            {
              codes: ["a", "b"],
              points: [
                { y: 2, x: 1 },
                { y: 4, x: 3 },
              ],
              label: "p",
            },
          ],
        },
      },
    );
    expect(reordered.entries).toEqual([]);
  });

  it("a missing property is not null", async () => {
    const entries = [{ label: "a" }, { label: "a", note: null }];
    const nullItem = await run({ entries }, { entries: { $remove: [{ note: null, label: "a" }] } });
    expect(nullItem.entries).toEqual([{ label: "a" }]);
    const missing = await run({ entries }, { entries: { $remove: [{ label: "a" }] } });
    expect(missing.entries).toEqual([{ label: "a", note: null }]);
  });

  it("$upsert of a re-ordered equal item appends nothing; a new item is stored as sent, once", async () => {
    const row = await run(
      { entries: [{ label: "u", note: "n" }] },
      {
        entries: {
          $upsert: [
            { note: "n", label: "u" },
            { note: "w", label: "new" },
            { label: "new", note: "w" },
          ],
        },
      },
    );
    expect(row.entries).toEqual([
      { label: "u", note: "n" },
      { note: "w", label: "new" },
    ]);
    expect(keysOf(row.entries)).toEqual([
      ["label", "note"],
      ["note", "label"],
    ]);
  });

  it("$insert under uniqueItems skips a re-ordered equal item, nested objects included", async () => {
    const stored = { name: "a", score: 1, extra: { p: 1, q: 2 } };
    const row = await run(
      { uniq: [stored] },
      {
        uniq: {
          $insert: [
            { extra: { q: 2, p: 1 }, score: 1, name: "a" },
            { score: 2, name: "b" },
          ],
        },
      },
    );
    expect(row.uniq).toEqual([stored, { score: 2, name: "b" }]);
    expect(keysOf(row.uniq)).toEqual([
      ["name", "score", "extra"],
      ["score", "name"],
    ]);
    expect(Object.keys(row.uniq[0].extra)).toEqual(["p", "q"]);
  });

  it("operators on one field apply remove → upsert → insert", async () => {
    const row = await run(
      { entries: [{ label: "a" }, { label: "b", note: "n" }] },
      {
        entries: {
          $insert: [{ label: "a" }],
          $upsert: [{ note: "n", label: "b" }, { label: "c" }],
          $remove: [{ label: "a" }],
        },
      },
    );
    expect(row.entries).toEqual([{ label: "b", note: "n" }, { label: "c" }, { label: "a" }]);
  });

  it("merge strategy: $remove finds the element the same way", async () => {
    const row = await run(
      {
        merged: [
          { a: 1, b: 2 },
          { a: 2, b: 1 },
        ],
      },
      { merged: { $remove: [{ b: 2, a: 1 }] } },
    );
    expect(row.merged).toEqual([{ a: 2, b: 1 }]);
  });

  // The 0.1.180 security fix holds: item values are `$literal`s
  it("a $-prefixed string in an item is data", async () => {
    const row = await run(
      { secret: "s3cret", entries: [{ label: "s3cret" }, { label: "$secret" }] },
      {
        entries: {
          $remove: [{ label: "$secret" }],
          $upsert: [{ note: "$secret", label: "$$ROOT" }],
        },
        uniq: { $insert: [{ score: 1, name: "$secret" }] },
      },
    );
    expect(row.entries).toEqual([{ label: "s3cret" }, { note: "$secret", label: "$$ROOT" }]);
    expect(row.uniq).toEqual([{ score: 1, name: "$secret" }]);
  });
});

describe("MongoDB: stored shapes and items the schema does not allow", () => {
  it("stored null, scalar and array elements are kept and never equal an object", async () => {
    const odd = [null, "x", [{ label: "x" }], { label: "x" }];
    const removed = await runRaw({ entries: odd }, { entries: { $remove: [{ label: "x" }] } });
    expect(removed!.entries).toEqual([null, "x", [{ label: "x" }]]);
    const upserted = await runRaw(
      { entries: odd.slice(0, 3) },
      { entries: { $upsert: [{ label: "x" }] } },
    );
    expect(upserted!.entries).toEqual([...odd.slice(0, 3), { label: "x" }]);
  });

  it("scalar items next to object items", async () => {
    const doc = await runRaw(
      { entries: [null, "x", { label: "x" }, { label: "y" }] },
      { entries: { $remove: ["x", { label: "x" }] } },
    );
    expect(doc!.entries).toEqual([null, { label: "y" }]);
  });

  it("property names a field path cannot spell", async () => {
    const element = { "a.b": 1, $x: 2, label: "q" };
    const doc = await runRaw(
      { entries: [element, { label: "q" }] },
      { entries: { $remove: [{ label: "q", $x: 2, "a.b": 1 }] } },
    );
    expect(doc!.entries).toEqual([{ label: "q" }]);
    const different = await runRaw(
      { entries: [element] },
      { entries: { $remove: [{ label: "q", $x: 3, "a.b": 1 }] } },
    );
    expect(different!.entries).toEqual([element]);
  });
});
