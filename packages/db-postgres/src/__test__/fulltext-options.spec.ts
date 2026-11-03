import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// `@db.index.fulltext.language` / `.match` on PostgreSQL (since 0.1.168): the
// language is the text search configuration of the index and the query (a
// change rebuilds the index); `match` switches to `websearch_to_tsquery`.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/fulltext-options.as");
  ({ FtPlain } = await import("./fixtures/fulltext-rank.as"));
});

let FtPlain: any;

function setup(Type: unknown, allResult?: (sql: string) => unknown[]) {
  const driver = createMockDriver({ getResult: { cnt: "0" }, allResult });
  const adapter = new PostgresAdapter(driver);
  const table = new AtscriptDbTable(Type as any, adapter);
  table.getMetadata();
  return { driver, table, adapter };
}

const execs = (driver: ReturnType<typeof createMockDriver>) =>
  driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
const searchCall = (driver: ReturnType<typeof createMockDriver>) =>
  driver.calls.find((c) => c.sql.includes("to_tsquery") && !c.sql.includes("COUNT"))!;

/** `listExisting` rows of fto_docs: `ft_body` built with `config`, `ft_title` with russian. */
const live = (config: string) => (sql: string) =>
  sql.includes("pg_index")
    ? [
        {
          name: "atscript__fulltext__ft_body",
          columns: null,
          def: `CREATE INDEX atscript__fulltext__ft_body ON public.fto_docs USING gin (to_tsvector('${config}'::regconfig, COALESCE(body, ''::text)))`,
        },
        {
          name: "atscript__fulltext__ft_title",
          columns: null,
          def: `CREATE INDEX atscript__fulltext__ft_title ON public.fto_docs USING gin (to_tsvector('russian'::regconfig, COALESCE(title, ''::text)))`,
        },
      ]
    : [];

describe("PostgresAdapter — @db.index.fulltext.language", () => {
  it("builds the GIN index with the language's configuration", async () => {
    const { driver, table } = setup(fx.FtoDoc);
    await table.syncIndexes();
    expect(execs(driver)).toContain(
      `CREATE INDEX IF NOT EXISTS "atscript__fulltext__ft_body" ON "fto_docs" USING gin(to_tsvector('russian', coalesce("body", '')))`,
    );
  });

  it('"none" is the simple configuration', async () => {
    const { driver, table } = setup(fx.FtoNone);
    await table.syncIndexes();
    expect(execs(driver).some((s) => s.includes(`to_tsvector('simple'`))).toBe(true);
  });

  it("rebuilds an index built with another configuration; keeps a matching one", async () => {
    const stale = setup(fx.FtoDoc, live("english"));
    const changes = await stale.adapter.syncIndexes();
    expect(changes).toEqual([{ name: "atscript__fulltext__ft_body", action: "rebuild" }]);
    expect(execs(stale.driver)).toContain(`DROP INDEX IF EXISTS "atscript__fulltext__ft_body"`);

    const current = setup(fx.FtoDoc, live("russian"));
    expect(await current.adapter.syncIndexes()).toEqual([]);
  });

  it("an index without a language stays english (no rebuild of existing indexes)", async () => {
    const { adapter } = setup(FtPlain, (sql) =>
      sql.includes("pg_index")
        ? [
            {
              name: "atscript__fulltext__ft_plain_idx",
              columns: null,
              def: `CREATE INDEX x ON t USING gin (to_tsvector('english'::regconfig, COALESCE(title, ''::text)))`,
            },
          ]
        : [],
    );
    expect(await adapter.syncIndexes()).toEqual([]);
  });

  it("queries with the language's configuration", async () => {
    const { driver, table } = setup(fx.FtoDoc);
    await table.search("кошки", {} as any, "ft_body");
    const call = searchCall(driver);
    expect(call.sql).toContain(
      `to_tsvector('russian', coalesce("body", '')) @@ websearch_to_tsquery('russian', $1)`,
    );
    expect(call.sql).toContain(
      `ts_rank(to_tsvector('russian', coalesce("body", '')), websearch_to_tsquery('russian', $2))`,
    );
  });
});

describe("PostgresAdapter — @db.index.fulltext.match", () => {
  it('"all": websearch_to_tsquery with the text as typed', async () => {
    const { driver, table } = setup(fx.FtoDoc);
    await table.search('red "big cat"', {} as any, "ft_body");
    expect(searchCall(driver).params?.[0]).toBe('red "big cat"');
  });

  it('"any": the terms OR-ed, phrases kept whole', async () => {
    const { driver, table } = setup(fx.FtoDoc);
    await table.search('red "big cat" dog', {} as any, "ft_title");
    const call = searchCall(driver);
    expect(call.sql).toContain("websearch_to_tsquery('russian', $1)");
    expect(call.params?.[0]).toBe('red or "big cat" or dog');
  });

  it('"any": a leading - is not an exclusion (it would match nearly every row)', async () => {
    const { driver, table } = setup(fx.FtoDoc);
    await table.search("foo -bar --", {} as any, "ft_title");
    expect(searchCall(driver).params?.[0]).toBe("foo or bar");
  });

  it("unset: plainto_tsquery, as before", async () => {
    const { driver, table } = setup(FtPlain);
    await table.search("cat", {} as any);
    expect(searchCall(driver).sql).toContain("plainto_tsquery('english', $1)");
  });
});
