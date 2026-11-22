import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// A field operator inside a replace-strategy object of a related row is
// refused by the related table, and the error names the relation: `au.obj.n`
// (to-one; since 0.1.184 — the related table refuses it now, and its error
// was reported at `obj.n` before the prefix), `posts.obj.n` (to-many). The
// write is refused as a whole.

let fx: Record<string, any>;

/** The `[path, code]` of the errors a write rejects with (none when it resolves). */
const paths = (p: Promise<unknown>) =>
  p.then(
    () => [],
    (e: { errors?: Array<{ path: string; code?: string }> }) =>
      (e.errors ?? []).map((err) => [err.path, err.code]),
  );

describe("SqliteAdapter — a refused field operator in a related row names the relation", () => {
  let driver: BetterSqlite3Driver;
  let authors: any;
  let posts: any;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/nested-field-op-path.as");
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    const space = new DbSpace(() => new SqliteAdapter(driver));
    authors = space.getTable(fx.NfoAuthor);
    posts = space.getTable(fx.NfoPost);
    await authors.ensureTable();
    await posts.ensureTable();
    await authors.insertOne({ id: 1, obj: { n: 1 } });
    await posts.insertOne({ id: 1, authorId: 1, obj: { n: 1 } });
  });

  afterEach(() => driver.close());

  const inc = { obj: { n: { $inc: 1 } } };

  it("to-one: au.obj.n, through updateOne and bulkUpdate; nothing is written", async () => {
    expect(await paths(posts.updateOne({ id: 1, obj: { n: 5 }, au: { id: 1, ...inc } }))).toEqual([
      ["au.obj.n", "FIELD_OP_CONTEXT"],
    ]);
    expect(await paths(posts.bulkUpdate([{ id: 1, au: { id: 1, ...inc } }]))).toEqual([
      ["au.obj.n", "FIELD_OP_CONTEXT"],
    ]);
    expect((await posts.findOne({ filter: { id: 1 }, controls: {} })).obj).toEqual({ n: 1 });
    expect((await authors.findOne({ filter: { id: 1 }, controls: {} })).obj).toEqual({ n: 1 });
  });

  it("to-many: posts.obj.n, through updateOne and bulkUpdate", async () => {
    const patch = { id: 1, posts: { $update: [{ id: 1, ...inc }] } };
    expect(await paths(authors.updateOne(patch))).toEqual([["posts.obj.n", "FIELD_OP_CONTEXT"]]);
    expect(await paths(authors.bulkUpdate([patch]))).toEqual([["posts.obj.n", "FIELD_OP_CONTEXT"]]);
  });
});
