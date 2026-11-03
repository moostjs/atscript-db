import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { quoteFtsTerm } from "../fts-term";
import { prepareFixtures } from "./test-utils";

// `@db.index.fulltext.language` / `.match` on SQLite (since 0.1.168): `english`
// builds the FTS5 table with the Porter stemmer (a change rebuilds it), other
// languages index unstemmed with a warning, `match "any"` OR-s the terms.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let warn: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/fulltext-options.as");
});

beforeEach(() => {
  driver = new BetterSqlite3Driver(":memory:");
  warn = vi.fn();
});

afterEach(() => {
  driver.close();
});

const logger = () => ({ error: vi.fn(), warn, log: vi.fn(), info: vi.fn(), debug: vi.fn() });

async function tableOf(type: unknown, rows: Array<Record<string, unknown>> = []) {
  const space = new DbSpace(() => new SqliteAdapter(driver), { logger: logger() as any });
  const table = space.getTable(type as any) as any;
  await table.ensureTable();
  await table.syncIndexes();
  if (rows.length > 0) await table.insertMany(rows);
  return table;
}

const ids = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => r.id as number).toSorted((a, b) => a - b);
const ftsSql = (name: string) =>
  driver.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = ?`, [name])!.sql;

describe("[sqlite] @db.index.fulltext.language", () => {
  it("english stems: 'run' finds 'running'; without a language it does not", async () => {
    const rows = [{ id: 1, body: "running fast" }];
    const plain = await tableOf(fx.FtoPlain, rows);
    expect(await plain.search("run", {})).toEqual([]);
    expect(ftsSql("fto_plain__fts__ft_body")).not.toContain("tokenize");

    // Same table, now `english`: the FTS5 table is rebuilt with the stemmer.
    const english = await tableOf(fx.FtoEnglish);
    expect(ftsSql("fto_plain__fts__ft_body")).toContain("tokenize='porter unicode61'");
    expect(ids(await english.search("run", {}))).toEqual([1]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a language FTS5 cannot stem: unicode61, with a warning at sync", async () => {
    const table = await tableOf(fx.FtoRussian, [{ id: 1, body: "Привет мир" }]);
    expect(ftsSql("fto_russian__fts__ft_body")).not.toContain("tokenize");
    expect(ids(await table.search("привет", {}))).toEqual([1]);
    expect(warn).toHaveBeenCalledWith(
      '[sqlite] fulltext index "ft_body": FTS5 has no russian stemmer — words are indexed unstemmed (unicode61)',
    );
  });
});

describe("[sqlite] @db.index.fulltext.match", () => {
  const rows = [
    { id: 1, body: "alpha beta" },
    { id: 2, body: "gamma zeta" },
    { id: 3, body: "alpha zeta" },
  ];

  it("default: every term", async () => {
    const table = await tableOf(fx.FtoPlain, rows);
    expect(ids(await table.search("alpha zeta", {}))).toEqual([3]);
  });

  it('"any": any term, best match first', async () => {
    const table = await tableOf(fx.FtoAny, rows);
    expect(ids(await table.search("alpha zeta", {}))).toEqual([1, 2, 3]);
    expect((await table.search("alpha zeta", {}))[0].id).toBe(3);
    expect(await table.count({ filter: {}, controls: { $search: "alpha zeta" } })).toBe(3);
  });

  it("quoteFtsTerm OR-s the quoted terms under any", () => {
    expect(quoteFtsTerm('a "b c" d*', "any")).toBe('a OR "b c" OR d*');
    expect(quoteFtsTerm('a "b c" d*')).toBe('a "b c" d*');
  });
});
