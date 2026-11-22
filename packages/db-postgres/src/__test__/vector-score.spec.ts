import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.183 every vector row carries `$score` (the MongoDB Atlas
// `vectorSearchScore` scale) computed from pgvector's distance, and the
// threshold becomes the exact inverse distance cap per metric. Before, a
// `euclidean` threshold was a raw distance cap and a `dotProduct` one capped
// `<#>` at `-threshold` (dot >= threshold). Since 0.1.184 the distance rides
// in the internal `__atscript_distance` column, which `$score` replaces: rows
// no longer carry `_distance`. The live spec runs the same rules against a
// server with pgvector.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/vector-score.as");
});

async function makeTable(Type: unknown, rows: unknown[] = []) {
  const driver = createMockDriver({
    allResult: (sql) => (sql.includes("__atscript_distance") ? rows : []),
    getResult: { cnt: "7" },
  });
  const table = new AtscriptDbTable(Type as any, new PostgresAdapter(driver));
  await table.ensureTable();
  driver.calls.length = 0;
  return { driver, table };
}

/** The ranked SELECT of the last vector search (not its COUNT companion). */
const searchCall = (driver: { calls: Array<{ sql: string; params?: unknown[] }> }) =>
  driver.calls.find((c) => c.sql.includes("::vector") && !c.sql.includes("COUNT(*)"))!;

describe("[postgres] vector $score (since 0.1.183)", () => {
  it("scores each metric from pgvector's distance with the Atlas formula", async () => {
    const cases: Array<[string, number, number]> = [
      ["VsCos", 0.5, 0.75], // <=> 1 − cos: (1 + cos) / 2
      ["VsL2", 1, 0.5], // <-> straight-line: 1 / (1 + d)
      ["VsDot", -0.8, 0.9], // <#> −dot: (1 + dot) / 2
    ];
    for (const [type, distance, score] of cases) {
      const { table } = await makeTable(fx[type], [
        { id: "a", title: "x", embedding: "[1,0]", __atscript_distance: distance },
      ]);
      const [row] = (await table.vectorSearch([1, 0], { filter: {}, controls: {} })) as any[];
      expect(row).toEqual({
        id: "a",
        title: "x",
        embedding: [1, 0],
        $score: expect.closeTo(score, 12),
      });
    }
  });

  it("the threshold caps the distance at its exact inverse per metric", async () => {
    const cases: Array<[string, number, number]> = [
      ["VsCos", 0.9, 0.2], // 2 (1 − s)
      ["VsL2", 0.25, 3], // 1 / s − 1 (was: s itself as the cap)
      ["VsDot", 0.75, -0.5], // 1 − 2s, i.e. dot >= 2s − 1 (was: −s)
    ];
    for (const [type, threshold, cap] of cases) {
      const { driver, table } = await makeTable(fx[type]);
      await table.vectorSearchWithCount([1, 0], {
        filter: {},
        controls: { $threshold: threshold },
      });
      const select = searchCall(driver);
      expect(select.sql).toContain(`WHERE "__atscript_distance" <= $2 ORDER BY`);
      expect(select.params![1]).toBeCloseTo(cap, 12);
      const count = driver.calls.find((c) => c.sql.includes("COUNT(*)"))!;
      expect(count.params!.at(-1)).toBeCloseTo(cap, 12);
    }
  });

  it("a schema-level euclidean threshold is a score too", async () => {
    const { driver, table } = await makeTable(fx.VsSchema);
    await table.vectorSearch([0, 0], { filter: {}, controls: {} });
    // @db.search.vector.threshold 0.3 → distance <= 1 / 0.3 − 1
    expect(searchCall(driver).params![1]).toBeCloseTo(1 / 0.3 - 1, 12);
  });

  it("a euclidean threshold at or below 0 caps nothing", async () => {
    const { driver, table } = await makeTable(fx.VsL2);
    await table.vectorSearch([0, 0], { filter: {}, controls: { $threshold: 0 } });
    expect(searchCall(driver).sql).not.toContain(`"__atscript_distance" <=`);
  });

  it("leaves out rows without a stored vector (a NULL distance), with or without a threshold", async () => {
    const { driver, table } = await makeTable(fx.VsL2);
    await table.vectorSearchWithCount([0, 0], { filter: {}, controls: {} });
    const count = driver.calls.find((c) => c.sql.includes("COUNT(*)"))!;
    for (const sql of [searchCall(driver).sql, count.sql]) {
      expect(sql).toContain(`) AS "_d" WHERE "__atscript_distance" IS NOT NULL) AS "_v"`);
    }
  });

  it("$select keeps $score, and vectorSearchWithCount scores its rows", async () => {
    const { table } = await makeTable(fx.VsCos, [{ title: "x", __atscript_distance: 0 }]);
    const included = await table.vectorSearch([1, 0], {
      filter: {},
      controls: { $select: ["title"] },
    });
    expect(included).toEqual([{ title: "x", $score: 1 }]);

    // `$score` replaces the distance column in place: a fresh mock row
    const { table: paged } = await makeTable(fx.VsCos, [{ title: "x", __atscript_distance: 0 }]);
    const page = await paged.vectorSearchWithCount([1, 0], {
      filter: {},
      controls: { $select: { embedding: 0 } },
    });
    expect(page).toEqual({ data: [{ title: "x", $score: 1 }], count: 7 });
  });
});
