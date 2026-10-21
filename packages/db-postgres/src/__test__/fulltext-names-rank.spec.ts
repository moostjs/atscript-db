import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.165: a fulltext index is addressed and reported by its DECLARED
// name (the internal `atscript__fulltext__<name>` key stays a deprecated
// alias), and a search with no `$sort` comes back in relevance order
// (`ts_rank`, per-field weights) with the primary key as tie-breaker.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/fulltext-rank.as");
});

function setup(Type: unknown) {
  const driver = createMockDriver({ getResult: { cnt: "0" } });
  const adapter = new PostgresAdapter(driver);
  const table = new AtscriptDbTable(Type as any, adapter);
  table.getMetadata();
  return { driver, table, adapter };
}

const searchSql = (driver: ReturnType<typeof createMockDriver>) =>
  driver.calls.find((c) => c.sql.includes("plainto_tsquery") && !c.sql.includes("COUNT"))!;

describe("PostgresAdapter — fulltext index names", () => {
  it("getSearchIndexes reports the declared names, the key as an alias", () => {
    const { adapter } = setup(fx.FtDoc);
    expect(adapter.getSearchIndexes().map((i) => [i.name, i.aliases, i.isDefault])).toEqual([
      ["ft_body", ["atscript__fulltext__ft_body"], true],
      ["ft_tags", ["atscript__fulltext__ft_tags"], false],
    ]);
  });

  it("search() resolves an index by its declared name", async () => {
    const { driver, table } = setup(fx.FtDoc);
    await table.search("cat", {} as any, "ft_tags");
    expect(searchSql(driver).sql).toContain(`to_tsvector('english', coalesce("tags", ''))`);
  });

  it("the internal key still resolves (deprecated alias)", async () => {
    const { driver, table } = setup(fx.FtDoc);
    await table.search("cat", {} as any, "atscript__fulltext__ft_tags");
    expect(searchSql(driver).sql).toContain(`coalesce("tags", '')`);
  });

  it("an unknown name answers the shared not-found message", async () => {
    const { table } = setup(fx.FtDoc);
    await expect(table.search("cat", {} as any, "nope")).rejects.toThrow(
      'Search index "nope" not found',
    );
  });
});

describe("PostgresAdapter — fulltext relevance order", () => {
  it("no $sort: ORDER BY ts_rank DESC, then the primary key", async () => {
    const { driver, table } = setup(fx.FtPlain);
    await table.search("cat", { filter: {}, controls: { $limit: 10 } } as any);
    const call = searchSql(driver);
    const vec = `to_tsvector('english', coalesce("title", '') || ' ' || coalesce("body", ''))`;
    expect(call.sql).toContain(
      `ORDER BY ts_rank(${vec}, plainto_tsquery('english', $2)) DESC, "id" ASC LIMIT $3`,
    );
    expect(call.params).toEqual(["cat", "cat", 10]);
  });

  it("per-field weights rank through setweight buckets", async () => {
    const { driver, table } = setup(fx.FtDoc);
    await table.search("cat", {} as any);
    const call = searchSql(driver);
    expect(call.sql).toContain(
      `ORDER BY ts_rank('{0.2, 0.2, 0.2, 1}', setweight(to_tsvector('english', coalesce("title", '')), 'A') || setweight(to_tsvector('english', coalesce("body", '')), 'B'), plainto_tsquery('english', $2)) DESC, "id" ASC`,
    );
  });

  it("an explicit $sort replaces relevance order", async () => {
    const { driver, table } = setup(fx.FtPlain);
    await table.search("cat", { filter: {}, controls: { $sort: { title: 1 } } } as any);
    const call = searchSql(driver);
    expect(call.sql).not.toContain("ts_rank");
    expect(call.sql).toContain(`ORDER BY "title" ASC`);
  });

  it("searchWithCount ranks its page too; the count is unordered", async () => {
    const { driver, table } = setup(fx.FtPlain);
    await table.searchWithCount("cat", { filter: {}, controls: {} } as any);
    expect(searchSql(driver).sql).toContain("ts_rank(");
    const count = driver.calls.find((c) => c.sql.includes("COUNT(*)"))!;
    expect(count.sql).not.toContain("ORDER BY");
  });
});
