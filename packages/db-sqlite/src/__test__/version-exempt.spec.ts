import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures, RecordingDriver } from "./test-utils";

let VxRecord: any;

// `@db.column.version.exempt` (since 0.1.150): a patch writing only exempt
// columns neither bumps the version nor adds a version predicate.
describe("SqliteAdapter version-exempt patches", () => {
  let inner: BetterSqlite3Driver;
  let driver: RecordingDriver;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    VxRecord = (await import("./fixtures/version-exempt.as")).VxRecord;
  });

  beforeEach(async () => {
    inner = new BetterSqlite3Driver(":memory:");
    driver = new RecordingDriver(inner);
    table = new AtscriptDbTable(VxRecord, new SqliteAdapter(driver));
    await table.ensureTable();
    await table.insertOne({
      id: 1,
      title: "a",
      status: "open",
      score: 0,
      hits: 0,
      metrics: { impact: 1 },
      tags: [],
    } as any);
    await table.insertOne({
      id: 2,
      title: "b",
      status: "open",
      score: 0,
      hits: 0,
      metrics: { impact: 1 },
      tags: [],
    } as any);
    driver.statements.length = 0;
  });

  afterEach(() => inner.close());

  const row = async (id: number) => (await table.findOne({ filter: { id }, controls: {} })) as any;
  const updates = () => driver.statements.filter((s) => s.startsWith("UPDATE"));

  it("exempt-only updateOne keeps the version and emits no bump", async () => {
    const result = await table.updateOne({ id: 1, score: 5 } as any);
    expect(result.matchedCount).toBe(1);
    const [sql] = updates();
    expect(sql).toMatch(/SET "score" = \? WHERE/);
    expect(sql).not.toContain('"version"');
    const r = await row(1);
    expect(r.score).toBe(5);
    expect(r.version).toBe(0);
  });

  it("a mixed patch bumps", async () => {
    await table.updateOne({ id: 1, score: 5, title: "t2" } as any);
    expect(updates()[0]).toContain('"version" = "version" + 1');
    expect((await row(1)).version).toBe(1);
  });

  it("$cas + exempt-only still checks and bumps", async () => {
    await table.updateOne({ id: 1, score: 5, $cas: { version: 0 } } as any);
    const [sql] = updates();
    expect(sql).toContain('"version" = "version" + 1');
    expect(sql).toMatch(/AND "version" = \?/);
    expect((await row(1)).version).toBe(1);
    const stale = await table.updateOne({ id: 1, score: 6, $cas: { version: 0 } } as any);
    expect(stale.matchedCount).toBe(0);
  });

  it("$inc on an exempt column does not bump", async () => {
    await table.updateOne({ id: 1, hits: { $inc: 1 } } as any);
    const r = await row(1);
    expect(r.hits).toBe(1);
    expect(r.version).toBe(0);
    expect(updates()[0]).not.toContain('"version"');
  });

  it("nested exempt object flattens and does not bump", async () => {
    await table.updateOne({ id: 1, metrics: { impact: 3, rank: 2 } } as any);
    const [sql] = updates();
    expect(sql).toContain('"metrics__impact"');
    expect(sql).not.toContain('"version"');
    expect((await row(1)).version).toBe(0);
  });

  it("array op on an exempt array does not bump", async () => {
    await table.updateOne({ id: 1, tags: { $insert: ["a"] } } as any);
    const r = await row(1);
    expect(r.tags).toEqual(["a"]);
    expect(r.version).toBe(0);
  });

  it("updateMany: exempt-only keeps every version, mixed bumps", async () => {
    await table.updateOne({ id: 2, title: "bump" } as any);
    const r1 = await table.updateMany({ status: "open" } as any, { score: 1 } as any);
    expect(r1.matchedCount).toBe(2);
    expect((await row(1)).version).toBe(0);
    expect((await row(2)).version).toBe(1);
    driver.statements.length = 0;
    await table.updateMany({ status: "open" } as any, { title: "z" } as any);
    expect(updates()[0]).toContain('"version" = "version" + 1');
    expect((await row(1)).version).toBe(1);
    expect((await row(2)).version).toBe(2);
  });

  it("replaceOne still bumps", async () => {
    await table.replaceOne({
      id: 1,
      title: "r",
      status: "open",
      score: 1,
      hits: 1,
      metrics: { impact: 1 },
      tags: [],
    } as any);
    expect((await row(1)).version).toBe(1);
  });

  it("touchMany still bumps", async () => {
    await table.touchMany([{ id: 1, version: 0 }] as any);
    expect((await row(1)).version).toBe(1);
  });
});
