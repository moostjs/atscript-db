import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Array `$update` against a real MongoDB (mongodb-memory-server). The native
// pipeline gives what the read-modify-write of the other adapters gives: the
// default strategy replaces the matched element, `merge` merges into it, an
// item that matches nothing is not inserted, and an array without key props
// is left as it is (since 0.1.180; before, its items were added as a set
// union).

let server: any;
let client: MongoClient;
let table: any;

const stored = () => [
  { sku: "a", qty: 1, note: "keep" },
  { sku: "b", qty: 5, note: "other" },
];

beforeAll(async () => {
  await prepareFixtures();
  const fx = await import("./fixtures/array-update-strategy.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  const db = client.db("array_update_strategy");
  const space = new DbSpace(() => new MongoAdapter(db, client));
  await new SchemaSync(space).run([fx.AusItem], { force: true });
  table = space.getTable(fx.AusItem);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

let nextId = 1;
/** Inserts a row with both keyed arrays seeded and returns its id. */
async function seed(extra: Record<string, unknown> = {}) {
  const id = nextId++;
  await table.insertOne({ id, plain: stored(), merged: stored(), ...extra });
  return id;
}
const read = async (id: number) => table.findOne({ filter: { id } });

// Since 0.1.180: fixes that bring the native pipeline in line with the
// read-modify-write of the other adapters.
describe("MongoDB array operators", () => {
  // The items are data. Before, the pipeline read a `$`-prefixed string in
  // them as a field path and stored that field's value in its place.
  it("a $-prefixed string in an operator item is stored as it was sent", async () => {
    const id = await seed({ tags: ["a"], secret: "s3cret" });
    await table.updateOne({
      id,
      tags: { $insert: ["$secret"] },
      plain: { $update: [{ sku: "a", qty: 2, note: "$secret" }] },
      merged: { $upsert: [{ sku: "n", qty: 1, note: "$secret" }] },
    });
    let row = await read(id);
    expect(row.tags).toEqual(["a", "$secret"]);
    expect(row.plain[0]).toEqual({ sku: "a", qty: 2, note: "$secret" });
    expect(row.merged.at(-1)).toEqual({ sku: "n", qty: 1, note: "$secret" });

    await table.updateOne({ id, tags: { $remove: ["$secret"] } });
    expect((await read(id)).tags).toEqual(["a"]);
    await table.updateOne({ id, tags: { $replace: ["$secret", "$$ROOT"] } });
    row = await read(id);
    expect(row.tags).toEqual(["$secret", "$$ROOT"]);
    await table.updateOne({ id, plain: { $remove: [{ sku: "$secret" }] } });
    expect((await read(id)).plain).toHaveLength(2);
  });

  // Before, the operator object itself was stored as the field's value
  it("an operator on an array inside a replace-strategy nested object is applied", async () => {
    const id = await seed({ box: { caption: "c", labels: ["x"] } });
    await table.updateOne({ id, box: { caption: "c", labels: { $insert: ["y"] } } });
    expect((await read(id)).box).toEqual({ caption: "c", labels: ["x", "y"] });
    await table.updateOne({ id, box: { caption: "c", labels: { $remove: ["x"] } } });
    expect((await read(id)).box).toEqual({ caption: "c", labels: ["y"] });
  });

  // The documented order: remove → update → upsert → insert. Before, the
  // update ran last, so it changed an element the same patch inserted.
  it("operators on one field apply in the documented order", async () => {
    const id = await seed();
    await table.updateOne({
      id,
      merged: {
        $insert: [{ sku: "n", qty: 1 }],
        $update: [{ sku: "n", qty: 9 }],
        $remove: [{ sku: "b" }],
      },
    });
    expect((await read(id)).merged).toEqual([
      { sku: "a", qty: 1, note: "keep" },
      { sku: "n", qty: 1 },
    ]);
  });

  // Before, the other operators were applied to the new array
  it("$replace stands alone: operators sent with it are ignored", async () => {
    const id = await seed({ tags: ["a"] });
    await table.updateOne({ id, tags: { $replace: ["x"], $insert: ["y"], $remove: ["x"] } });
    expect((await read(id)).tags).toEqual(["x"]);
  });

  // The driver rejects an empty pipeline; the row is looked up instead
  it("an operator with an empty item list changes nothing and does not throw", async () => {
    const id = await seed({ tags: ["a"] });
    for (const op of ["$insert", "$upsert", "$update", "$remove"]) {
      expect(await table.updateOne({ id, tags: { [op]: [] } })).toMatchObject({
        matchedCount: 1,
        modifiedCount: 0,
      });
    }
    expect((await read(id)).tags).toEqual(["a"]);
  });
});

// The same cases as `array operators: one behaviour on every adapter` in
// @atscript/db's `array-ops-stored.spec.ts` (the read-modify-write of the
// other adapters). Before 0.1.180 MongoDB replaced the stored element on a
// keyed `$insert`, moved an upserted element to the end, and its key-less
// operators were set operations that also dropped stored duplicates.
describe("MongoDB array operators: one behaviour on every adapter", () => {
  /** The row after `patch` is applied to one seeded with `row`. */
  async function run(row: Record<string, unknown>, patch: Record<string, unknown>) {
    const id = nextId++;
    await table.insertOne({ id, ...row });
    await table.updateOne({ id, ...patch });
    return read(id);
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

describe("MongoDB array $update follows the patch strategy", () => {
  it("replace strategy (default): the matched element becomes the item", async () => {
    const id = await seed();
    await table.updateOne({ id, plain: { $update: [{ sku: "a", qty: 2 }] } });
    expect((await read(id)).plain).toEqual([
      { sku: "a", qty: 2 },
      { sku: "b", qty: 5, note: "other" },
    ]);
  });

  it("merge strategy: the matched element keeps the fields the item does not name", async () => {
    const id = await seed();
    await table.updateOne({ id, merged: { $update: [{ sku: "a", qty: 2 }] } });
    expect((await read(id)).merged).toEqual([
      { sku: "a", qty: 2, note: "keep" },
      { sku: "b", qty: 5, note: "other" },
    ]);
  });

  it("an item whose key matches nothing changes nothing", async () => {
    const id = await seed();
    await table.updateOne({
      id,
      plain: { $update: [{ sku: "zz", qty: 9 }] },
      merged: { $update: [{ sku: "zz", qty: 9 }] },
    });
    expect(await read(id)).toMatchObject({ plain: stored(), merged: stored() });
  });

  it("a key given twice: items apply in order", async () => {
    const id = await seed();
    const items = [
      { sku: "a", qty: 2, note: "first" },
      { sku: "a", qty: 3 },
    ];
    await table.updateOne({ id, plain: { $update: items }, merged: { $update: items } });
    const row = await read(id);
    expect(row.plain[0]).toEqual({ sku: "a", qty: 3 });
    expect(row.merged[0]).toEqual({ sku: "a", qty: 3, note: "first" });
  });

  it("an array without key props: $update changes nothing, alone or next to another change", async () => {
    const keyless = [{ label: "x", note: "n" }];
    const id = await seed({ keyless, tags: ["a"] });
    // nothing to set: the row is looked up, not written
    const only = await table.updateOne({
      id,
      keyless: { $update: [{ label: "x" }, { label: "new" }] },
      tags: { $update: ["a", "b"] },
    });
    expect(only).toMatchObject({ matchedCount: 1, modifiedCount: 0 });
    expect(await read(id)).toMatchObject({ keyless, tags: ["a"] });
    const missing = await table.updateOne({ id: 999_999, tags: { $update: ["b"] } });
    expect(missing).toMatchObject({ matchedCount: 0, modifiedCount: 0 });
    await table.updateOne({
      id,
      tags: { $update: ["b"] },
      plain: { $update: [{ sku: "b", qty: 6 }] },
    });
    const row = await read(id);
    expect(row.tags).toEqual(["a"]);
    expect(row.plain[1]).toEqual({ sku: "b", qty: 6 });
  });
});
