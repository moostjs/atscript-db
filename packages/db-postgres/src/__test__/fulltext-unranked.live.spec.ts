import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import type { TPostgresAdapterOptions } from "../types";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (CI has no server). Override with `ATSCRIPT_PG_TEST_URL` (an admin
// connection; the spec creates and drops its own `fulltext_unranked` database).
// Since 0.1.175: `$rank: false` (no ts_rank — `$sort`, else primary-key order)
// and `textSearchConfigs` (a language's index and queries use the app's own
// text search configuration; changing it rebuilds the index).

const DB = "fulltext_unranked";

const reachable = await pgReachable();

let fx: Record<string, any>;
let opts: Record<string, any>;
let driver: PgDriver;

const spaceWith = (options?: TPostgresAdapterOptions) =>
  new DbSpace(() => new PostgresAdapter(driver, options));

const ids = (rows: unknown[]) => (rows as Array<{ id: number }>).map((r) => r.id);

/** The text search configuration of a live index (`pg_get_indexdef`). */
async function liveConfig(index: string): Promise<string | undefined> {
  const row = await driver.get<{ def: string }>(
    `SELECT pg_get_indexdef(c.oid) AS def FROM pg_class c WHERE c.relname = $1`,
    [index],
  );
  return row ? /to_tsvector\('([^']+)'::regconfig/.exec(row.def)?.[1] : undefined;
}

describe.skipIf(!reachable)("[postgres live] $rank: false and textSearchConfigs", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/fulltext-rank.as");
    opts = await import("./fixtures/fulltext-options.as");
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    await driver.exec(`CREATE TEXT SEARCH CONFIGURATION atscript_ru (COPY = russian)`);
    const result = await new SchemaSync(spaceWith()).run([fx.FtPlain], { force: true });
    expect(result.status).toBe("synced");
    await spaceWith()
      .getTable(fx.FtPlain)
      .insertMany([
        { id: 1, title: "notes", body: "a long text that mentions a cat once among many words" },
        { id: 2, title: "cat", body: "cat cat" },
      ] as never);
  });

  afterAll(async () => {
    await driver?.close();
    await dropPgDatabase(DB);
  });

  it("$rank: false returns primary-key order; ranked, the better match first", async () => {
    const table = spaceWith().getTable(fx.FtPlain);
    expect(ids(await table.search("cat", { filter: {}, controls: {} }))).toEqual([2, 1]);
    const unranked = { filter: {}, controls: { $rank: false } } as never;
    expect(ids(await table.search("cat", unranked))).toEqual([1, 2]);
    const page = await table.searchWithCount("cat", unranked);
    expect([ids(page.data), page.count]).toEqual([[1, 2], 2]);
    const sorted = { filter: {}, controls: { $rank: false, $sort: { id: -1 } } } as never;
    expect(ids(await table.search("cat", sorted))).toEqual([2, 1]);
  });

  it("textSearchConfigs builds the index with the app's configuration; changing it rebuilds", async () => {
    const custom = { textSearchConfigs: { russian: "atscript_ru" } } as const;
    const first = await new SchemaSync(spaceWith(custom)).run([opts.FtoDoc], { force: true });
    expect(first.status).toBe("synced");
    expect(await liveConfig("atscript__fulltext__ft_body")).toBe("atscript_ru");
    const table = spaceWith(custom).getTable(opts.FtoDoc);
    await table.insertOne({ id: 1, body: "кошки спят", title: "x" } as never);
    expect(ids(await table.search("кошка", { filter: {}, controls: {} }, "ft_body"))).toEqual([1]);
    // the same configuration again: nothing to do
    expect((await new SchemaSync(spaceWith(custom)).plan([opts.FtoDoc])).status).toBe("up-to-date");

    // back to the built-in configuration: the plan reports the rebuild, the run applies it
    const sync = new SchemaSync(spaceWith());
    const plan = await sync.plan([opts.FtoDoc]);
    expect(plan.entries.find((e) => e.name === "fto_docs")?.indexChanges).toEqual(
      expect.arrayContaining([{ name: "atscript__fulltext__ft_body", action: "rebuild" }]),
    );
    expect((await sync.run([opts.FtoDoc])).status).toBe("synced");
    expect(await liveConfig("atscript__fulltext__ft_body")).toBe("russian");
  });
});
