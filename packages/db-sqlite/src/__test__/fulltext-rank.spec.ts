import { describe, it, expect, beforeAll, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.165: a search with no `$sort` comes back in relevance order
// (FTS5 `bm25()`, per-field weights) with the primary key as tie-breaker;
// an explicit `$sort` replaces it. Before, rows came back in rowid order.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver | undefined;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/fulltext-rank.as");
});

afterEach(() => {
  driver?.close();
  driver = undefined;
});

async function setup(Type: unknown, rows: Record<string, unknown>[]) {
  driver = new BetterSqlite3Driver(":memory:");
  const table = new AtscriptDbTable(Type as any, new SqliteAdapter(driver));
  await table.ensureTable();
  await table.syncIndexes();
  for (const row of rows) await table.insertOne(row as any);
  return table;
}

const ids = (rows: unknown[]) => (rows as Array<Record<string, unknown>>).map((r) => r.id);

describe("SqliteAdapter — fulltext relevance order", () => {
  it("no $sort: the better match comes first (not rowid order)", async () => {
    const table = await setup(fx.FtPlain, [
      {
        id: 1,
        title: "notes",
        body: "a long rambling text that mentions a cat once among many other words here",
      },
      { id: 2, title: "cat", body: "cat cat" },
    ]);
    expect(ids(await table.search("cat", {} as any))).toEqual([2, 1]);
    const page = await table.searchWithCount("cat", { filter: {}, controls: {} } as any);
    expect(ids(page.data)).toEqual([2, 1]);
    expect(page.count).toBe(2);
  });

  it("per-field weights decide between otherwise equal hits", async () => {
    // Same text in different fields: the title (weight 5) outranks the body.
    const table = await setup(fx.FtDoc, [
      { id: 1, title: "dog", body: "cat", tags: "" },
      { id: 2, title: "cat", body: "dog", tags: "" },
    ]);
    expect(ids(await table.search("cat", {} as any))).toEqual([2, 1]);
  });

  it("an explicit $sort replaces relevance order", async () => {
    const table = await setup(fx.FtPlain, [
      { id: 1, title: "notes", body: "one cat among very many other words in this body" },
      { id: 2, title: "cat", body: "cat cat" },
    ]);
    const rows = await table.search("cat", { filter: {}, controls: { $sort: { id: 1 } } } as any);
    expect(ids(rows)).toEqual([1, 2]);
  });

  it("a whole-number term: exact-number hits first, then text relevance", async () => {
    const table = await setup(fx.FtNumbered, [
      { id: 1, title: "invoice 77 copy", refNo: 5 },
      { id: 2, title: "something else", refNo: 77 },
      { id: 3, title: "77 77", refNo: 6 },
    ]);
    expect(ids(await table.search("77", {} as any))).toEqual([2, 3, 1]);
  });

  // The numeric form ranks with one FTS5 pass (a materialized MATCH joined
  // once) — a per-row correlated bm25 lookup re-ran the MATCH for every hit.
  it("a whole-number term over 10k text matches keeps its order and stays fast", async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      id: i + 1,
      title: i % 3 === 0 ? "42 42 42" : `item 42 number ${i}`,
      refNo: i === 9_000 ? 42 : 100_000 + i,
    }));
    const table = await setup(fx.FtNumbered, []);
    await table.insertMany(rows);
    const t0 = performance.now();
    const hits = await table.search("42", { filter: {}, controls: { $limit: 5 } } as any);
    const ms = performance.now() - t0;
    // the exact-number hit first, then the dense "42 42 42" titles in key order
    expect(ids(hits)).toEqual([9001, 1, 4, 7, 10]);
    expect(ms).toBeLessThan(400);
  }, 30_000);
});
