import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.143: a `$with` relation loads even when `$select` leaves out the
// key it joins on (`/tasks/query?$select=id,title&$with=owner` used to answer
// `owner: null`) — the key is read for the join and stripped from the rows.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/with-join-keys.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  for (const t of [fx.WjUser, fx.WjTask, fx.WjNote]) await space.getTable(t).ensureTable();
  await space.getTable(fx.WjUser).insertOne({ id: 1, name: "u1" });
  await space.getTable(fx.WjTask).insertOne({ id: 1, title: "t1", ownerId: 1 });
  await space.getTable(fx.WjNote).insertOne({ id: 1, body: "n1", taskId: 1 });
});

afterEach(() => {
  driver.close();
});

describe("[sqlite] $with joins through keys $select omits", () => {
  it("TO relation: the foreign key is joined on, then stripped", async () => {
    const tasks = space.getTable(fx.WjTask) as any;
    const [row] = await tasks.findMany({
      filter: {},
      controls: { $select: ["id", "title"], $with: [{ name: "owner" }] },
    });
    expect(row).toEqual({ id: 1, title: "t1", owner: { id: 1, name: "u1" } });
  });

  it("FROM relation: the parent key is joined on, then stripped", async () => {
    const tasks = space.getTable(fx.WjTask) as any;
    const { data } = await tasks.findManyWithCount({
      filter: {},
      controls: { $select: ["title"], $with: [{ name: "notes" }] },
    });
    expect(data).toEqual([
      { title: "t1", notes: [expect.objectContaining({ id: 1, body: "n1" })] },
    ]);
  });

  it("exclusion form: an excluded key still joins and stays excluded", async () => {
    const tasks = space.getTable(fx.WjTask) as any;
    const row = await tasks.findOne({
      filter: { id: 1 },
      controls: { $select: { ownerId: 0 }, $with: [{ name: "owner" }] },
    });
    expect(row).toEqual({ id: 1, title: "t1", owner: { id: 1, name: "u1" } });
  });
});
