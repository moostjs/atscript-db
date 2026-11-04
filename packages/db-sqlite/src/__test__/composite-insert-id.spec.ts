import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.169 an insert into a composite-primary-key table reports the
// primary-key object (logical field names) as its id — never the rowid. A key
// part the database generates without reporting it yields no id (fail closed).

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;
let pairs: any;
let single: any;
let seq: any;
let coded: any;
let links: any;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/composite-insert-id.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  pairs = space.getTable(fx.CidPair);
  single = space.getTable(fx.CidSingle);
  seq = space.getTable(fx.CidSeq);
  coded = space.getTable(fx.CidCoded);
  links = space.getTable(fx.CidLink);
  const types = [
    fx.CidPair,
    fx.CidSingle,
    fx.CidSeq,
    fx.CidCoded,
    fx.CidLink,
    fx.CidTag,
    fx.CidCodedTag,
  ];
  expect((await new SchemaSync(space).run(types, { force: true })).status).toBe("synced");
});

afterEach(() => {
  driver.close();
});

describe("[sqlite] composite primary key — insertedId", () => {
  it("insertOne reports the primary-key object, by logical field names", async () => {
    const result = await pairs.insertOne({ left: 1, right: "a", label: "A" });
    expect(result).toEqual({ insertedId: { left: 1, right: "a" } });
    expect(await pairs.findById(result.insertedId)).toMatchObject({ left: 1, right: "a" });
  });

  it("insertMany reports one primary-key object per row", async () => {
    const result = await pairs.insertMany([
      { left: 1, right: "a", label: "A" },
      { left: 1, right: "b", label: "B" },
    ]);
    expect(result).toEqual({
      insertedCount: 2,
      insertedIds: [
        { left: 1, right: "a" },
        { left: 1, right: "b" },
      ],
    });
  });

  it("onConflict: ignore reports the inserted rows' primary-key objects", async () => {
    await pairs.insertOne({ left: 1, right: "a", label: "A" });
    const many = await pairs.insertMany(
      [
        { left: 1, right: "a", label: "dup" },
        { left: 2, right: "b", label: "B" },
      ],
      { onConflict: "ignore" },
    );
    expect(many).toEqual({
      insertedCount: 1,
      insertedIds: [{ left: 2, right: "b" }],
      inserted: [1],
      conflicts: [0],
    });
    const one = await pairs.insertOne(
      { left: 3, right: "c", label: "C" },
      { onConflict: "ignore" },
    );
    expect(one).toEqual({ insertedId: { left: 3, right: "c" }, conflict: false });
  });

  it("insertOne({ returning: true }) reads the inserted row back", async () => {
    const result = await pairs.insertOne({ left: 4, right: "d", label: "D" }, { returning: true });
    expect(result.insertedId).toEqual({ left: 4, right: "d" });
    expect(result.row).toMatchObject({ left: 4, right: "d", label: "D" });
  });

  it("regression: the read-back never lands on another row through a scalar unique key", async () => {
    // Before, the id was the rowid (2 here) — and `code: 2` names the FIRST row.
    await pairs.insertOne({ left: 10, right: "a", code: 2, label: "first" });
    const result = await pairs.insertOne(
      { left: 20, right: "b", code: 1, label: "second" },
      { returning: true },
    );
    expect(result.row).toMatchObject({ left: 20, right: "b", label: "second" });
    expect(result.insertedId).toEqual({ left: 20, right: "b" });
  });

  it("a key part the database generates but does not report: no id (fail closed)", async () => {
    const result = await seq.insertOne({ tenant: "t1", label: "x" });
    expect(result).toEqual({ insertedId: undefined });
    const returned = await seq.insertOne({ tenant: "t1", label: "y" }, { returning: true });
    expect(returned.insertedId).toBeUndefined();
    expect(returned.row).toBeUndefined();
  });

  it("a single primary key keeps its scalar id", async () => {
    expect(await single.insertOne({ label: "a" })).toEqual({ insertedId: 1 });
    expect(await single.insertMany([{ label: "b" }, { id: 7, label: "c" }])).toEqual({
      insertedCount: 2,
      insertedIds: [2, 7],
    });
  });
});

describe("[sqlite] nested inserts link by the referenced key", () => {
  it("TO: a composite foreign key is filled from the new parent's key", async () => {
    await links.insertOne({ note: "n", pair: { left: 5, right: "e", label: "E" } });
    const [link] = await links.findMany({ filter: {}, controls: {} });
    expect(link).toMatchObject({ pairLeft: 5, pairRight: "e" });
  });

  it("TO: a foreign key to a unique column gets that column, not the parent's id", async () => {
    await coded.insertOne({ code: "zz", label: "pad" }); // id 1
    await links.insertOne({ note: "n", coded: { code: "c1", label: "C1" } }); // id 2
    const [link] = await links.findMany({ filter: {}, controls: {} });
    expect(link).toMatchObject({ codedCode: "c1" });
  });

  it("FROM: children of a composite-key parent get its full key", async () => {
    await pairs.insertOne({ left: 6, right: "f", label: "F", links: [{ note: "child" }] });
    const [link] = await links.findMany({ filter: {}, controls: {} });
    expect(link).toMatchObject({ note: "child", pairLeft: 6, pairRight: "f" });
  });

  it("FROM: children referencing a unique column get that column", async () => {
    await coded.insertOne({ code: "zz", label: "pad" });
    await coded.insertOne({ code: "c2", label: "C2", links: [{ note: "child" }] });
    const [link] = await links.findMany({ filter: {}, controls: {} });
    expect(link).toMatchObject({ note: "child", codedCode: "c2" });
  });

  it("VIA: junction rows reference the unique fields both sides declare", async () => {
    await coded.insertOne({ code: "zz", label: "pad" });
    await space.getTable(fx.CidTag).insertOne({ name: "pad" });
    await coded.insertOne({ code: "c3", label: "C3", tags: [{ name: "t1" }] });
    const junction = await space.getTable(fx.CidCodedTag).findMany({ filter: {}, controls: {} });
    expect(junction).toEqual([{ id: 1, codedCode: "c3", tagName: "t1" }]);
  });
});
