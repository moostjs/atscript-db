import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Keys under a case-insensitive collation (`@db.column.collate 'nocase'`;
// MySQL's default): the database treats "abc" and "ABC" as one key, and the
// nested writes match stored rows the same way — they ask the database when
// an exact comparison finds no match.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/nocase-links.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  const types = Object.values(fx).filter((v) => typeof v === "function");
  expect((await new SchemaSync(space).run(types as never, { force: true })).status).toBe("synced");
});

afterEach(() => {
  driver.close();
});

const t = (type: unknown) => space.getTable(type as never) as any;
const all = (type: unknown) => t(type).findMany({ filter: {} });

describe("nested writes over case-insensitive keys", () => {
  it("VIA: an existing target's unique field echoed in another case links by the stored value", async () => {
    const tag = await t(fx.NcTag).insertOne({ name: "tag" });
    await t(fx.NcPost).insertOne({ title: "a", tags: [{ id: tag.insertedId, name: "TAG" }] });
    expect(await all(fx.NcPostTag)).toMatchObject([{ tagName: "tag" }]);
  });

  it("VIA: a string primary key in another case names the stored target", async () => {
    await t(fx.NcCode).insertOne({ code: "abc" });
    await t(fx.NcPost).insertOne({ title: "b", codes: [{ code: "ABC" }] });
    expect(await all(fx.NcPostCode)).toMatchObject([{ code: "abc" }]);
    expect(await all(fx.NcCode)).toHaveLength(1);
  });

  it("FROM replace: a child key in another case replaces the child, never deletes it", async () => {
    const { insertedId } = await t(fx.NcPost).insertOne({
      title: "c",
      notes: [{ key: "n1", body: "x" }],
    });
    await t(fx.NcPost).replaceOne({
      id: insertedId,
      title: "c2",
      notes: [{ key: "N1", body: "y" }],
    });
    expect(await all(fx.NcNote)).toMatchObject([{ postId: insertedId, body: "y" }]);
  });

  it("FROM patch: $update by a key in another case patches the parent's own child", async () => {
    const { insertedId } = await t(fx.NcPost).insertOne({
      title: "d",
      notes: [{ key: "n1", body: "x" }],
    });
    await t(fx.NcPost).updateOne({
      id: insertedId,
      notes: { $update: [{ key: "N1", body: "z" }] },
    });
    expect(await all(fx.NcNote)).toMatchObject([{ key: "n1", body: "z" }]);
  });

  it("a key that differs by more than case is still a different key", async () => {
    const tag = await t(fx.NcTag).insertOne({ name: "tag" });
    const error = await t(fx.NcPost)
      .insertOne({ title: "e", tags: [{ id: tag.insertedId, name: "other" }] })
      .then(
        () => undefined,
        (e: { code?: string }) => e,
      );
    expect(error?.code).toBe("INVALID_QUERY");
    const missing = await t(fx.NcPost)
      .insertOne({ title: "f", codes: [{ code: "zzz" }] })
      .then(
        () => undefined,
        (e: { code?: string }) => e,
      );
    expect(missing?.code).toBe("FK_VIOLATION");
    expect(await all(fx.NcPost)).toEqual([]);
  });

  it("TO patch: the stored key echoed in another case patches the referenced row; another key is refused", async () => {
    await t(fx.NcTag).insertOne({ name: "tag" });
    await t(fx.NcTag).insertOne({ name: "other" });
    await t(fx.NcComment).insertOne({ id: 1, tagName: "tag", body: "b" });
    await t(fx.NcComment).updateOne({ id: 1, tagName: "TAG", tag: { name: "TAG" } });
    // the echo is written as given — the same key under the column's collation
    expect((await t(fx.NcComment).findById(1)).tagName.toLowerCase()).toBe("tag");
    const error = await t(fx.NcComment)
      .updateOne({ id: 1, tag: { name: "other" } })
      .then(
        () => undefined,
        (e: { code?: string }) => e,
      );
    expect(error?.code).toBe("INVALID_QUERY");
  });
});
