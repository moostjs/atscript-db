import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { computeTableSnapshot, SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { quoteFtsTerm } from "../fts-term";
import { createAdapter } from "../index";
import type { SqliteAdapterOptions } from "../tx-gate";
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

async function tableOf(
  type: unknown,
  rows: Array<Record<string, unknown>> = [],
  options?: SqliteAdapterOptions,
) {
  const space = new DbSpace(() => new SqliteAdapter(driver, options), { logger: logger() as any });
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
      '[sqlite] fulltext index "ft_body": FTS5 has no russian stemmer — words are indexed unstemmed (unicode61); set the adapter\'s ftsTokenizers to use a stemming tokenizer',
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

// `ftsTokenizers` (since 0.1.175): the FTS5 tokenizer per language. The
// specs use FTS5's built-in tokenizers (`trigram`, `unicode61 …`); a stemmer
// such as `snowball` comes from an extension the app loads.
describe("[sqlite] ftsTokenizers", () => {
  const trigram = { ftsTokenizers: { russian: "trigram" } } as const;

  it("builds the FTS5 table with the configured tokenizer, without the no-stemmer warning", async () => {
    const table = await tableOf(fx.FtoRussian, [{ id: 1, body: "Привет мир" }], trigram);
    expect(ftsSql("fto_russian__fts__ft_body")).toContain("tokenize='trigram'");
    // trigram matches inside words — unicode61 would not
    expect(ids(await table.search("риве", {}))).toEqual([1]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("can replace english's Porter stemmer", async () => {
    const english = { ftsTokenizers: { english: "unicode61 remove_diacritics 2" } } as const;
    const table = await tableOf(fx.FtoEnglish, [{ id: 1, body: "running fast" }], english);
    expect(ftsSql("fto_plain__fts__ft_body")).toContain("tokenize='unicode61 remove_diacritics 2'");
    expect(await table.search("run", {})).toEqual([]);
  });

  it("other languages keep their defaults", async () => {
    await tableOf(fx.FtoEnglish, [], trigram);
    expect(ftsSql("fto_plain__fts__ft_body")).toContain("tokenize='porter unicode61'");
    await tableOf(fx.FtoAny, [], trigram);
    expect(ftsSql("fto_any__fts__ft_body")).not.toContain("tokenize");
  });

  it("changing it rebuilds the FTS5 table: the sync plan reports it, the run applies it", async () => {
    const spaceWith = (options?: SqliteAdapterOptions) =>
      new DbSpace(() => new SqliteAdapter(driver, options), { logger: logger() as any });
    expect((await new SchemaSync(spaceWith()).run([fx.FtoRussian])).status).toBe("synced");
    expect(ftsSql("fto_russian__fts__ft_body")).not.toContain("tokenize");

    const sync = new SchemaSync(spaceWith(trigram));
    const plan = await sync.plan([fx.FtoRussian]);
    expect(plan.status).toBe("changes-needed");
    expect(plan.entries.find((e) => e.name === "fto_russian")?.indexChanges).toEqual([
      { name: "fto_russian__fts__ft_body", action: "rebuild" },
    ]);
    expect((await sync.run([fx.FtoRussian])).status).toBe("synced");
    expect(ftsSql("fto_russian__fts__ft_body")).toContain("tokenize='trigram'");
    // the configured tokenizer is part of the stored hash: nothing left to do
    expect((await sync.plan([fx.FtoRussian])).status).toBe("up-to-date");
  });

  it("is part of the table snapshot only for the configured language", () => {
    const snapshot = (Type: unknown, options?: SqliteAdapterOptions) =>
      computeTableSnapshot(
        new DbSpace(() => new SqliteAdapter(driver, options)).getTable(Type as any),
      ).indexes.find((i) => i.type === "fulltext");
    expect(snapshot(fx.FtoRussian, trigram)).toMatchObject({ engineConfig: "trigram" });
    expect(snapshot(fx.FtoRussian)).not.toHaveProperty("engineConfig");
    expect(snapshot(fx.FtoEnglish, trigram)).not.toHaveProperty("engineConfig");
  });

  it("a tokenizer SQLite does not have: a clear error naming it and loadExtensions", async () => {
    const snowball = { ftsTokenizers: { russian: "snowball russian unicode61" } } as const;
    await expect(tableOf(fx.FtoRussian, [], snowball)).rejects.toThrow(
      /FTS5 tokenizer "snowball russian unicode61" is not available \(.*no such tokenizer.*\) — load the SQLite extension that provides it with the driver's loadExtensions option/,
    );
  });

  it("a rebuild to a missing tokenizer fails before it drops the live FTS5 table", async () => {
    const table = await tableOf(fx.FtoRussian, [{ id: 1, body: "Привет мир" }]);
    const snowball = { ftsTokenizers: { russian: "snowball russian unicode61" } } as const;
    const space = new DbSpace(() => new SqliteAdapter(driver, snowball));
    await expect(space.getTable(fx.FtoRussian).syncIndexes()).rejects.toThrow(
      /FTS5 tokenizer "snowball russian unicode61" is not available/,
    );
    // the old table, its triggers and the probe's leftovers: as before
    expect(ftsSql("fto_russian__fts__ft_body")).not.toContain("tokenize");
    expect(ids(await table.search("привет", {}))).toEqual([1]);
    await table.insertOne({ id: 2, body: "мир" });
    expect(ids(await table.search("мир", {}))).toEqual([1, 2]);
  });

  it("an index without a language keeps unicode61 — no key names it", async () => {
    await tableOf(fx.FtoPlain, [], { ftsTokenizers: { english: "trigram", none: "trigram" } });
    expect(ftsSql("fto_plain__fts__ft_body")).not.toContain("tokenize");
  });

  it("rejects a tokenizer that is not plain words, and an unknown language", () => {
    for (const bad of ["porter'), x('", "unicode61 tokenchars '-'", "", " porter", "a\nb"]) {
      expect(
        () => new SqliteAdapter(driver, { ftsTokenizers: { russian: bad } }),
        JSON.stringify(bad),
      ).toThrow(/ftsTokenizers\.russian: .* is not a tokenizer spec/);
    }
    expect(
      () => new SqliteAdapter(driver, { ftsTokenizers: { klingon: "porter" } as never }),
    ).toThrow('"klingon" is not a @db.index.fulltext.language value');
  });

  it("createAdapter passes it to the adapter, not to the driver", async () => {
    const bad = createAdapter(":memory:", { ftsTokenizers: { russian: "x'" } });
    expect(() => bad.getTable(fx.FtoRussian)).toThrow(/not a tokenizer spec/);
    const space = createAdapter(":memory:", trigram);
    const table = space.getTable(fx.FtoRussian) as any;
    await table.ensureTable();
    await table.syncIndexes();
    await table.insertOne({ id: 1, body: "Привет мир" });
    expect((await table.search("риве", {})).map((r: { id: number }) => r.id)).toEqual([1]);
    await space.close();
  });
});
