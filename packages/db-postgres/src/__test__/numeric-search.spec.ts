import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Integer members of a fulltext index (since 0.1.150): never part of the
// tsvector, matched by `= n` when the whole term is a whole number.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/numeric-search.as");
});

function setup(Type: unknown) {
  const driver = createMockDriver({ getResult: { cnt: "0" } });
  const adapter = new PostgresAdapter(driver);
  const table = new AtscriptDbTable(Type as any, adapter);
  table.getMetadata();
  return { driver, table, adapter };
}

const TS = `to_tsvector('english', coalesce("title", ''))`;

describe("PostgresAdapter — integer fulltext members", () => {
  it("DDL: the tsvector index holds the text members only", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.syncIndexes();
    const ddl = driver.calls.map((c) => c.sql).filter((s) => s.includes("USING gin"));
    expect(ddl).toHaveLength(1);
    expect(ddl[0]).toContain(`USING gin(${TS})`);
    expect(ddl[0]).not.toContain("ref_no");
    expect(ddl[0]).not.toContain("alt_no");
  });

  it("DDL: an integer-only index creates nothing", async () => {
    const { driver, table } = setup(fx.NsCode);
    await table.syncIndexes();
    expect(driver.calls.map((c) => c.sql).filter((s) => s.includes("gin"))).toEqual([]);
  });

  it("a whole-number term ORs exact equality into the text predicate", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.search("2946", { filter: { id: { $gt: 0 } } } as any);
    const call = driver.calls.find((c) => c.sql.includes("plainto_tsquery"))!;
    expect(call.sql).toContain(
      `"id" > $1 AND (${TS} @@ plainto_tsquery('english', $2) OR "ref_no" = CAST($3 AS BIGINT) OR "alt_no" = CAST($4 AS BIGINT))`,
    );
    expect(call.params).toEqual([0, "2946", 2946, 2946]);
  });

  it("a non-integer term keeps the text predicate only", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.search("quokka", {} as any);
    const call = driver.calls.find((c) => c.sql.includes("plainto_tsquery"))!;
    expect(call.sql).toContain(`WHERE ${TS} @@ plainto_tsquery('english', $1)`);
    expect(call.sql).not.toContain("BIGINT");
    expect(call.params).toEqual(["quokka"]);
  });

  it("an integer-only index matches by number and nothing else", async () => {
    const { driver, table } = setup(fx.NsCode);
    await table.search("4", {} as any);
    const hit = driver.calls.find((c) => c.sql.includes("BIGINT"))!;
    expect(hit.sql).toContain(`WHERE "id" = CAST($1 AS BIGINT)`);
    expect(hit.params).toEqual([4]);

    driver.calls.length = 0;
    await table.search("abc", {} as any);
    const miss = driver.calls.find((c) => c.method === "all")!;
    expect(miss.sql).toContain("WHERE 0=1");
  });

  it("aggregate $search and its $count use the same predicate", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["title"],
        $select: ["title", { $fn: "count", $field: "*", $as: "n" }],
        $search: "2946",
      },
    } as any);
    expect(driver.calls[0]!.sql).toContain(`OR "ref_no" = CAST($2 AS BIGINT)`);
  });

  it("searchWithCount counts with the numeric branch", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.searchWithCount("2946", {} as any);
    const count = driver.calls.find((c) => c.sql.includes("COUNT(*)"))!;
    expect(count.sql).toContain(`"ref_no" = CAST($2 AS BIGINT)`);
  });

  it("getSearchIndexes keeps the integer members in `fields` and describes them", () => {
    const { adapter } = setup(fx.NsItem);
    const [index] = adapter.getSearchIndexes();
    expect(index!.fields).toEqual(["title", "ref_no", "alt_no"]);
    expect(index!.description).toBe(
      "GIN tsvector index on title + exact number on ref_no + exact number on alt_no",
    );
  });

  it("$regex on an integer renders a cast to the decimal text", async () => {
    const { driver, table } = setup(fx.NsItem);
    await table.findMany({ filter: { ref_no: { $regex: "^29" } } } as any);
    const call = driver.calls.find((c) => c.sql.includes("~"))!;
    expect(call.sql).toContain(`CAST(CAST("ref_no" AS BIGINT) AS TEXT) ~ $1`);
    expect(call.params).toEqual(["^29"]);
  });
});
