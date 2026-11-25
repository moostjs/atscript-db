import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { SqliteAdapter } from "../sqlite-adapter";
import { prepareFixtures } from "./test-utils";

// A boolean part of a composite primary key addressed by text — what a URL
// carries (`GET /one?id=a&active=true`). The column stores 0 / 1: the filter
// must carry the boolean, never the text 'true' (since 0.1.192).

let BkDraft: any;
let BkRevision: any;
let driver: BetterSqlite3Driver;
let drafts: any;
let revisions: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ BkDraft, BkRevision } = await import("./fixtures/boolean-key.as"));
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  const space = new DbSpace(() => new SqliteAdapter(driver));
  drafts = space.getTable(BkDraft);
  revisions = space.getTable(BkRevision);
  const types = [BkDraft, BkRevision];
  expect((await new SchemaSync(space).run(types, { force: true })).status).toBe("synced");
  await drafts.insertMany([
    { id: "a", active: true, title: "live" },
    { id: "a", active: false, title: "draft" },
  ]);
  await revisions.insertMany([
    { id: "a", rev: 1, title: "first" },
    { id: "a", rev: 2, title: "second" },
  ]);
});

afterEach(() => {
  driver.close();
});

describe("[sqlite] a boolean part of a composite primary key", () => {
  it("is stored as 0 / 1", () => {
    expect(driver.all("SELECT active FROM bk_drafts ORDER BY active")).toEqual([
      { active: 0 },
      { active: 1 },
    ]);
  });

  it.each([
    ["true", "live"],
    ["false", "draft"],
    [true, "live"],
    [false, "draft"],
  ])("findById with active %j finds the %s row", async (active, title) => {
    expect(await drafts.findById({ id: "a", active })).toMatchObject({ title });
  });

  it.each(["yes", "1", "", "TRUE"])("findById with active %j finds nothing", async (active) => {
    expect(await drafts.findById({ id: "a", active })).toBeNull();
  });
});

// A number key part addressed by text reaches the adapter as the text (the
// filter is not converted); SQLite's column affinity compares it as a number.
describe("[sqlite] a number part of a composite primary key", () => {
  it("text reaches the adapter and matches the numeric column", async () => {
    expect(revisions.resolveIdFilter({ id: "a", rev: "2" })).toEqual({ id: "a", rev: "2" });
    expect(await revisions.findById({ id: "a", rev: "2" })).toMatchObject({ title: "second" });
    expect(await revisions.findById({ id: "a", rev: "3" })).toBeNull();
  });
});
