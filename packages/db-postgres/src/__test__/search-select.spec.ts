import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.143: geo and vector search project `$select` exactly like
// findMany — inclusion and exclusion forms (the write-only seal HTTP layers
// pass is an exclusion projection), flattened object leaves included.

const SF: [number, number] = [-122.42, 37.77];
const VEC = Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0));

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/search-select.as");
});

async function makeTable(Type: unknown) {
  const driver = createMockDriver({ getResult: { cnt: "0" } });
  const table = new AtscriptDbTable(Type as any, new PostgresAdapter(driver));
  await table.ensureTable();
  driver.calls.length = 0;
  return { driver, table };
}

const searchSql = (driver: { calls: Array<{ sql: string }> }, marker: string) =>
  driver.calls.find((c) => c.sql.includes(marker) && !c.sql.includes("COUNT(*)"))!.sql;

describe("[postgres] geoSearch $select", () => {
  it("inclusion form projects only the selected columns (+ distance)", async () => {
    const { driver, table } = await makeTable(fx.SsPlace);
    await table.geoSearch(SF, { controls: { $select: ["id", "settings.theme"] } });
    const sql = searchSql(driver, "ST_Distance(");
    expect(sql).toContain(`SELECT "t"."id", "t"."settings__theme", ST_Distance(`);
    expect(sql).not.toContain(`"t".*`);
  });

  it("exclusion form keeps every other column and drops the excluded ones", async () => {
    const { driver, table } = await makeTable(fx.SsPlace);
    await table.geoSearchWithCount(SF, { controls: { $select: { pin: 0, settings: 0 } } });
    const sql = searchSql(driver, "ST_Distance(");
    expect(sql).toContain(`SELECT "t"."id", "t"."name", "t"."geo", ST_Distance(`);
    expect(sql).not.toContain(`"pin"`);
    expect(sql).not.toContain(`"settings__`);
  });

  it("no $select still reads every column", async () => {
    const { driver, table } = await makeTable(fx.SsPlace);
    await table.geoSearch(SF, { controls: {} });
    expect(searchSql(driver, "ST_Distance(")).toContain(`SELECT "t".*, ST_Distance(`);
  });
});

describe("[postgres] vectorSearch $select", () => {
  it("projects inclusion and exclusion forms, keeping _distance", async () => {
    const { driver, table } = await makeTable(fx.SsDoc);
    await table.vectorSearch(VEC, { filter: {}, controls: { $select: ["id"] } });
    // The projection applies to the outer query; the ranked source reads the rows.
    expect(searchSql(driver, "::vector")).toContain(
      `SELECT "_v"."id", "_v"."_distance" FROM (SELECT "t".*, ("embedding" <=> $1::vector) AS "_distance"`,
    );

    driver.calls.length = 0;
    await table.vectorSearchWithCount(VEC, { filter: {}, controls: { $select: { pin: 0 } } });
    const sql = searchSql(driver, "::vector");
    expect(sql).toContain(
      `SELECT "_v"."id", "_v"."title", "_v"."embedding", "_v"."_distance" FROM`,
    );
    expect(sql).not.toContain(`"pin"`);
  });

  it("no $select still reads every column", async () => {
    const { driver, table } = await makeTable(fx.SsDoc);
    await table.vectorSearch(VEC, { filter: {}, controls: {} });
    expect(searchSql(driver, "::vector")).toContain(
      `SELECT * FROM (SELECT "t".*, ("embedding" <=> $1::vector) AS "_distance"`,
    );
  });
});
