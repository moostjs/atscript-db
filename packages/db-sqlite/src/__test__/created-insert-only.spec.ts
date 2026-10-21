import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.165 `number.timestamp.created` is insert-only: a replace keeps
// the stored value (before: it was reset to "now" when the payload left it
// out), and a replace or patch cannot overwrite it (before: it could be forged).

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let notes: any;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/created-insert-only.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  const space = new DbSpace(() => new SqliteAdapter(driver));
  notes = space.getTable(fx.CioNote);
  await notes.ensureTable();
  await notes.insertOne({ id: 1, title: "a", createdAt: 1000 });
});

afterEach(() => {
  driver.close();
});

const createdAt = async () => (await notes.findById(1)).createdAt;

describe("[sqlite] created is insert-only", () => {
  it("insert keeps a given value; a missing one is stamped", async () => {
    expect(await createdAt()).toBe(1000);
    await notes.insertOne({ id: 2, title: "b" });
    expect((await notes.findById(2)).createdAt).toBeGreaterThan(1000);
  });

  it("replaceOne without createdAt keeps the stored value", async () => {
    await notes.replaceOne({ id: 1, title: "b" });
    expect(await createdAt()).toBe(1000);
  });

  it("replaceOne / bulkReplace cannot overwrite it", async () => {
    await notes.replaceOne({ id: 1, title: "b", createdAt: 5 });
    expect(await createdAt()).toBe(1000);
    await notes.bulkReplace([{ id: 1, title: "c", createdAt: 6 }]);
    expect(await createdAt()).toBe(1000);
  });

  it("updateOne / updateMany / replaceMany cannot overwrite it", async () => {
    await notes.updateOne({ id: 1, createdAt: 5 });
    expect(await createdAt()).toBe(1000);
    await notes.updateMany({ id: 1 }, { createdAt: 6 });
    expect(await createdAt()).toBe(1000);
    await notes.replaceMany({ id: 1 }, { title: "d", createdAt: 7 });
    expect(await createdAt()).toBe(1000);
    expect((await notes.findById(1)).title).toBe("d");
  });
});
