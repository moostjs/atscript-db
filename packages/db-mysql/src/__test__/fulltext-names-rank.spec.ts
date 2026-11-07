import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.165: a fulltext index is addressed and reported by its DECLARED
// name (the internal `atscript__fulltext__<name>` key stays a deprecated
// alias), and a search with no `$sort` has an explicit relevance order
// (`MATCH … AGAINST` DESC) with the primary key as tie-breaker.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/fulltext-rank.as");
});

function setup(Type: unknown) {
  const driver = createMockDriver({
    get: [["COUNT(*)", { cnt: 0 }]],
    allResult: [],
  } as any);
  const adapter = new MysqlAdapter(driver);
  const table = new AtscriptDbTable(Type as any, adapter);
  table.getMetadata();
  return { driver, table, adapter };
}

const searchSql = (driver: { calls: Array<{ sql: string; params?: unknown[] }> }) =>
  driver.calls.find((c) => c.sql.includes("AGAINST") && !c.sql.includes("COUNT"))!;

describe("MysqlAdapter — fulltext index names", () => {
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
    expect(searchSql(driver).sql).toContain("MATCH(`tags`)");
  });

  it("the internal key still resolves (deprecated alias)", async () => {
    const { driver, table } = setup(fx.FtDoc);
    await table.search("cat", {} as any, "atscript__fulltext__ft_tags");
    expect(searchSql(driver).sql).toContain("MATCH(`tags`)");
  });

  it("an unknown name answers the shared not-found message", async () => {
    const { table } = setup(fx.FtDoc);
    await expect(table.search("cat", {} as any, "nope")).rejects.toThrow(
      'Search index "nope" not found',
    );
  });
});

describe("MysqlAdapter — fulltext relevance order", () => {
  const MATCH = "MATCH(`title`, `body`) AGAINST(? IN NATURAL LANGUAGE MODE)";

  it("no $sort: ORDER BY relevance DESC, then the primary key", async () => {
    const { driver, table } = setup(fx.FtPlain);
    await table.search("cat", { filter: {}, controls: { $limit: 10 } } as any);
    const call = searchSql(driver);
    expect(call.sql).toContain(`WHERE ${MATCH} ORDER BY ${MATCH} DESC, \`id\` ASC LIMIT ?`);
    expect(call.params).toEqual(["cat", "cat", 10]);
  });

  it("an explicit $sort replaces relevance order", async () => {
    const { driver, table } = setup(fx.FtPlain);
    await table.search("cat", { filter: {}, controls: { $sort: { title: -1 } } } as any);
    const call = searchSql(driver);
    expect(call.sql).toContain("ORDER BY `title` DESC");
    expect(call.sql.match(/AGAINST/g)).toHaveLength(1);
  });

  it("searchWithCount ranks its page; the count is unordered", async () => {
    const { driver, table } = setup(fx.FtPlain);
    await table.searchWithCount("cat", { filter: {}, controls: {} } as any);
    expect(searchSql(driver).sql).toContain(`ORDER BY ${MATCH} DESC`);
    const count = driver.calls.find((c) => c.sql.includes("COUNT(*)"))!;
    expect(count.sql).not.toContain("ORDER BY");
  });
});

// `$rank: false` (since 0.1.175): no relevance ORDER BY — `$sort`, else the primary key.
describe("MysqlAdapter — $rank: false", () => {
  const MATCH = "MATCH(`title`, `body`) AGAINST(? IN NATURAL LANGUAGE MODE)";

  it("MATCH only filters: ORDER BY the primary key", async () => {
    const { driver, table } = setup(fx.FtPlain);
    await table.search("cat", { filter: {}, controls: { $rank: false, $limit: 10 } } as any);
    const call = searchSql(driver);
    expect(call.sql).toContain(`WHERE ${MATCH} ORDER BY \`id\` ASC LIMIT ?`);
    expect(call.sql.match(/AGAINST/g)).toHaveLength(1);
    expect(call.params).toEqual(["cat", 10]);
  });

  it("searchWithCount: the page unranked too", async () => {
    const { driver, table } = setup(fx.FtPlain);
    await table.searchWithCount("cat", { filter: {}, controls: { $rank: false } } as any);
    expect(searchSql(driver).sql.match(/AGAINST/g)).toHaveLength(1);
  });

  it("an explicit $sort still wins", async () => {
    const { driver, table } = setup(fx.FtPlain);
    await table.search("cat", {
      filter: {},
      controls: { $rank: false, $sort: { title: -1 } },
    } as any);
    expect(searchSql(driver).sql).toContain("ORDER BY `title` DESC");
  });
});
