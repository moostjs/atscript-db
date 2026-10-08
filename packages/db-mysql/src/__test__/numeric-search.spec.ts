import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Integer members of a fulltext index (since 0.1.150): never part of the
// FULLTEXT index, matched by `= n` when the whole term is a whole number.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/numeric-search.as");
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

const MATCH = "MATCH(`title`) AGAINST(? IN NATURAL LANGUAGE MODE)";
const sqlOf = (driver: { calls: Array<{ sql: string; method?: string }> }, marker: string) =>
  driver.calls.find((c) => c.sql.includes(marker))!;

describe("MysqlAdapter — integer fulltext members", () => {
  it("DDL: the FULLTEXT index lists the text members only", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.syncIndexes();
    const ddl = driver.calls.map((c) => c.sql).filter((s) => s.includes("FULLTEXT INDEX"));
    expect(ddl).toHaveLength(1);
    expect(ddl[0]).toContain("(`title`)");
    expect(ddl[0]).not.toContain("ref_no");
    expect(ddl[0]).not.toContain("alt_no");
  });

  it("DDL: an integer-only index creates nothing", async () => {
    const { driver, table } = setup(fx.NsCode);
    await table.syncIndexes();
    expect(driver.calls.map((c) => c.sql).filter((s) => s.includes("FULLTEXT"))).toEqual([]);
  });

  it("a text-only search keeps today's MATCH shape", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.search("quokka", { filter: { id: { $gt: 0 } } } as any);
    const call = sqlOf(driver, "MATCH");
    expect(call.sql).toContain(`WHERE \`id\` > ? AND ${MATCH}`);
    expect(call.sql).not.toContain("UNION");
    expect((call as any).params).toEqual([0, "quokka"]);
  });

  it("a whole-number term unions the primary keys of each arm (single PK)", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.search("2946", { filter: { id: { $gt: 0 } } } as any);
    const call = sqlOf(driver, "UNION");
    expect(call.sql).toContain(
      "WHERE `id` > ? AND `id` IN (SELECT `id` FROM (" +
        `SELECT \`id\` FROM \`ns_items\` WHERE ${MATCH} UNION ` +
        "SELECT `id` FROM `ns_items` WHERE `ref_no` = ? UNION " +
        "SELECT `id` FROM `ns_items` WHERE `alt_no` = ?) AS `_atscript_search`)",
    );
    expect((call as any).params).toEqual([0, "2946", 2946, 2946]);
  });

  it("a composite primary key uses a row-value IN", async () => {
    const { driver, table } = setup(fx.NsPair);
    await table.search("7", {} as any);
    const call = sqlOf(driver, "UNION");
    expect(call.sql).toContain("(`tenant`, `code`) IN (SELECT `tenant`, `code` FROM (");
    expect((call as any).params).toEqual(["7", 7]);
  });

  it("a table without a primary key falls back to a plain OR", async () => {
    const { driver, table } = setup(fx.NsLoose);
    await table.search("7", {} as any);
    const call = sqlOf(driver, "MATCH");
    expect(call.sql).toContain(
      "WHERE (MATCH(`title`) AGAINST(? IN NATURAL LANGUAGE MODE) OR `ref_no` = ?)",
    );
    expect((call as any).params).toEqual(["7", 7]);
  });

  it("an integer-only index matches by number, and a non-number matches nothing", async () => {
    const { driver, table } = setup(fx.NsCode);
    await table.search("4", {} as any);
    const hit = sqlOf(driver, "_atscript_search");
    expect(hit.sql).toContain(
      "`id` IN (SELECT `id` FROM (SELECT `id` FROM `ns_codes` WHERE `id` = ?) AS `_atscript_search`)",
    );
    expect(hit.sql).not.toContain("MATCH");

    driver.calls.length = 0;
    await table.search("abc", {} as any);
    expect(driver.calls.find((c) => c.sql.includes("FROM"))!.sql).toContain("WHERE 0=1");
  });

  it("searchWithCount counts with the same predicate", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.searchWithCount("2946", {} as any);
    const count = driver.calls.find((c) => c.sql.includes("COUNT(*)"))!;
    expect(count.sql).toContain("UNION");
  });

  it("aggregate $search uses it too", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["title"],
        $select: ["title", { $fn: "count", $field: "*", $as: "n" }],
        $search: "2946",
      },
    } as any);
    expect(driver.calls[0]!.sql).toContain("`id` IN (SELECT `id` FROM (");
  });

  it("describes integer members in the index list", () => {
    const { adapter } = setup(fx.NsItem);
    const [index] = adapter.getSearchIndexes();
    expect(index!.fields).toEqual(["title", "ref_no", "alt_no"]);
    expect(index!.description).toBe(
      "FULLTEXT index on title + exact number on ref_no + exact number on alt_no",
    );
  });

  it("$regex on an integer renders a cast to the decimal text", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.findMany({ filter: { ref_no: { $regex: "^29" } } } as any);
    const call = sqlOf(driver, "REGEXP");
    expect(call.sql).toContain("CAST(CAST(`ref_no` AS SIGNED) AS CHAR) REGEXP ?");
  });
});
