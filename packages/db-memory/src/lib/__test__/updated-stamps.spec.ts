import { describe, it, expect, beforeAll } from "vite-plus/test";
import { SchemaSync } from "@atscript/db/sync";

import { createTestSpace, prepareFixtures } from "./test-utils";

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/updated-stamps.as");
});

const OLD = 1_700_000_000_000;
/** Whole seconds — a MySQL `TIMESTAMP` keeps no fraction. */
const sec = () => Math.floor(Date.now() / 1000) * 1000;
const doc = (id: number) => ({ id, title: "t", audit: {} });
const old = (id: number) => ({
  id,
  title: "t",
  updatedAt: OLD,
  aliased: OLD,
  nullable: OLD as number | null,
  audit: { at: OLD },
});

const stamps = (row: any) => [row.updatedAt, row.aliased, row.nullable, row.audit.at];

/** Every write path of a table of `UpdDoc`. */
async function checkUpdatedStamps(table: any): Promise<void> {
  let before = sec();
  await table.insertOne(doc(1));
  for (const v of stamps(await table.findById(1))) expect(v).toBeGreaterThanOrEqual(before);

  // an explicit value wins on insert
  await table.insertMany([old(2), old(3), old(4), { ...old(5), nullable: null }, old(6), old(7)]);
  expect(await table.findById(2)).toMatchObject(old(2));
  expect(((await table.findById(5)) as any).nullable).toBeNull();

  // a patch sets the row's own fields, overriding a supplied value; a nested
  // one only when the patch carries its object
  before = sec();
  await table.updateOne({ id: 2, title: "p", updatedAt: OLD });
  let row = (await table.findById(2)) as any;
  for (const v of [row.updatedAt, row.aliased, row.nullable]) {
    expect(v).toBeGreaterThanOrEqual(before);
  }
  expect(row.audit.at).toBe(OLD);
  await table.updateOne({ id: 2, audit: { note: "n" } });
  row = (await table.findById(2)) as any;
  expect(row.audit).toEqual({ note: "n", at: expect.any(Number) });
  expect(row.audit.at).toBeGreaterThanOrEqual(before);

  // a patch with nothing else to write is a no-op
  await table.updateOne({ id: 3, updatedAt: 5 });
  expect(await table.findById(3)).toMatchObject(old(3));

  // updateMany and bulkUpdate
  await table.updateMany({ id: 3 }, { title: "m" });
  await table.bulkUpdate([
    { id: 4, title: "b" },
    { id: 5, title: "b" },
  ]);
  for (const id of [3, 4, 5]) {
    row = (await table.findById(id)) as any;
    expect(row.updatedAt, `${id}`).toBeGreaterThanOrEqual(before);
    expect(row.nullable, `${id}`).toBeGreaterThanOrEqual(before);
    expect(row.audit.at, `${id}`).toBe(OLD);
  }

  // replaceOne, bulkReplace and replaceMany set every field, overriding supplied values
  await table.replaceOne(old(1));
  await table.bulkReplace([old(6)]);
  await table.replaceMany({ id: 7 }, old(7));
  for (const id of [1, 6, 7]) {
    for (const v of stamps(await table.findById(id))) {
      expect(v, `${id}`).toBeGreaterThanOrEqual(before);
    }
  }
}

/** A table synced as `UpdBefore` (the <= 0.1.155 layout), populated, then synced as `UpdAfter`. */
async function checkUpgrade(space: any, SchemaSync: any): Promise<void> {
  expect((await new SchemaSync(space).run([fx.UpdBefore], { force: true })).status).toBe("synced");
  await space.getTable(fx.UpdBefore).insertOne({ id: 1, title: "a", updatedAt: OLD, maybe: OLD });
  await space.getTable(fx.UpdBefore).insertOne({ id: 2, title: "a", updatedAt: OLD, maybe: null });
  const result = await new SchemaSync(space).run([fx.UpdAfter], { force: true });
  expect(result.status).toBe("synced");
  expect(result.entries[0]!.errors ?? []).toEqual([]);
  const table = space.getTable(fx.UpdAfter);
  expect(await table.findById(1)).toMatchObject({ updatedAt: OLD, maybe: OLD });
  expect(await table.findById(2)).toMatchObject({ updatedAt: OLD, maybe: null });
  const before = sec();
  await table.updateOne({ id: 1, title: "b" });
  const row = (await table.findById(1)) as any;
  expect(row.updatedAt).toBeGreaterThanOrEqual(before);
  expect(row.maybe).toBeGreaterThanOrEqual(before);
  await table.insertOne({ id: 3 });
  expect(((await table.findById(3)) as any).updatedAt).toBeGreaterThanOrEqual(before);
  expect((await new SchemaSync(space).run([fx.UpdAfter])).status).toBe("up-to-date");
}

describe("[memory] number.timestamp.updated", () => {
  it("is set on insert and by every patch and replace", async () => {
    const table = createTestSpace().getTable(fx.UpdDoc);
    await table.ensureTable();
    await checkUpdatedStamps(table);
  });

  it("a table from an earlier version keeps its rows, then sets it", async () => {
    await checkUpgrade(createTestSpace(), SchemaSync);
  });
});

describe("[memory] number.timestamp.updated — nested writes", () => {
  it("a JSON object and a related row are set; below a union of objects the value is kept", async () => {
    const space = createTestSpace();
    const owners = space.getTable(fx.UpdOwner);
    const orders = space.getTable(fx.UpdOrder);
    await owners.ensureTable();
    await orders.ensureTable();
    await owners.insertOne({ id: 1, name: "o", updatedAt: OLD });
    await orders.insertOne({
      id: 1,
      ownerId: 1,
      updatedAt: OLD,
      blob: { at: OLD },
      payment: { kind: "card", at: OLD },
    } as any);

    const before = Date.now();
    await orders.updateOne({ id: 1, blob: { note: "n", at: OLD } } as any);
    let row = (await orders.findById(1)) as any;
    expect(row.blob).toEqual({ note: "n", at: expect.any(Number) });
    expect(row.blob.at).toBeGreaterThanOrEqual(before);
    expect(row.updatedAt).toBe(row.blob.at);

    // the related row's own field, by its own write
    await orders.updateOne({ id: 1, owner: { name: "o2", updatedAt: OLD } } as any);
    expect(await owners.findById(1)).toEqual({
      id: 1,
      name: "o2",
      updatedAt: expect.any(Number),
    });
    expect(((await owners.findById(1)) as any).updatedAt).toBeGreaterThanOrEqual(before);

    // no certain place below a union of several object types: the payload's value is stored
    await orders.updateOne({ id: 1, payment: { kind: "bank", at: 5 } } as any);
    row = (await orders.findById(1)) as any;
    expect(row.payment).toEqual({ kind: "bank", at: 5 });
    expect(row.updatedAt).toBeGreaterThanOrEqual(before);
  });
});
