import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.183 every vector row carries `$score` (the MongoDB Atlas
// `vectorSearchScore` scale) computed from `_distance`, and the threshold
// becomes the exact inverse distance cap: `VEC_DISTANCE_COSINE` is
// `1 − cos`, `VEC_DISTANCE_EUCLIDEAN` the straight-line distance. Before,
// every metric used the cosine conversion. A `dotProduct` index is refused:
// the adapter has no MySQL dot-product distance.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/vector-score.as");
});

async function makeTable(Type: unknown, rows: unknown[] = []) {
  const driver = createMockDriver({
    get: [
      ["VERSION()", { v: "9.1.0" }],
      ["COUNT(*)", { cnt: 7 }],
    ],
    all: [["_distance", rows]],
  });
  const table = new AtscriptDbTable(Type as any, new MysqlAdapter(driver));
  await table.ensureTable();
  driver.calls.length = 0;
  return { driver, table };
}

/** The ranked SELECT of the last vector search (not its COUNT companion). */
const searchCall = (driver: { calls: Array<{ sql: string; params?: unknown[] }> }) =>
  driver.calls.find((c) => c.sql.includes("STRING_TO_VECTOR") && !c.sql.includes("COUNT(*)"))!;

describe("[mysql] vector $score (since 0.1.183)", () => {
  it("scores cosine and euclidean from the distance function with the Atlas formula", async () => {
    const cases: Array<[string, number, number]> = [
      ["VsCos", 0.5, 0.75], // VEC_DISTANCE_COSINE 1 − cos: (1 + cos) / 2
      ["VsL2", 1, 0.5], // VEC_DISTANCE_EUCLIDEAN: 1 / (1 + d)
    ];
    for (const [type, distance, score] of cases) {
      const { table } = await makeTable(fx[type], [{ id: "a", title: "x", _distance: distance }]);
      const [row] = (await table.vectorSearch([1, 0], { filter: {}, controls: {} })) as any[];
      expect(row).toMatchObject({ id: "a", _distance: distance });
      expect(row.$score).toBeCloseTo(score, 12);
    }
  });

  it("the threshold caps the distance at its exact inverse (euclidean used the cosine one)", async () => {
    const cases: Array<[string, number, number]> = [
      ["VsCos", 0.9, 0.2], // 2 (1 − s)
      ["VsL2", 0.25, 3], // 1 / s − 1 (was: 2 (1 − s))
    ];
    for (const [type, threshold, cap] of cases) {
      const { driver, table } = await makeTable(fx[type]);
      await table.vectorSearchWithCount([1, 0], {
        filter: {},
        controls: { $threshold: threshold },
      });
      const select = searchCall(driver);
      expect(select.sql).toContain("WHERE `_distance` <= ? ORDER BY");
      expect(select.params![1]).toBeCloseTo(cap, 12);
      const count = driver.calls.find((c) => c.sql.includes("COUNT(*)"))!;
      expect(count.params!.at(-1)).toBeCloseTo(cap, 12);
    }
  });

  it("leaves out rows without a stored vector (a NULL distance)", async () => {
    const { driver, table } = await makeTable(fx.VsL2);
    await table.vectorSearchWithCount([0, 0], { filter: {}, controls: {} });
    const count = driver.calls.find((c) => c.sql.includes("COUNT(*)"))!;
    for (const sql of [searchCall(driver).sql, count.sql]) {
      expect(sql).toContain(") AS `_d` WHERE `_distance` IS NOT NULL) AS `_v`");
    }
  });

  it("a euclidean threshold at or below 0 caps nothing", async () => {
    const { driver, table } = await makeTable(fx.VsL2);
    await table.vectorSearch([0, 0], { filter: {}, controls: { $threshold: 0 } });
    expect(searchCall(driver).sql).not.toContain("`_distance` <=");
  });

  it("refuses a dotProduct index before any query runs", async () => {
    const { driver, table } = await makeTable(fx.VsDot);
    for (const run of [
      () => table.vectorSearch([1, 0], { filter: {}, controls: {} }),
      () => table.vectorSearchWithCount([1, 0], { filter: {}, controls: {} }),
    ]) {
      const err = (await run().catch((e: unknown) => e)) as DbError;
      expect(err).toBeInstanceOf(DbError);
      expect(err.code).toBe("INVALID_QUERY");
      expect(err.errors[0]).toMatchObject({ path: "embedding" });
      expect(err.errors[0]!.message).toContain(`uses "dotProduct"`);
    }
    expect(driver.calls.some((c) => c.sql.includes("STRING_TO_VECTOR"))).toBe(false);
  });

  it("$select keeps $score, and vectorSearchWithCount scores its rows", async () => {
    const { table } = await makeTable(fx.VsCos, [{ title: "x", _distance: 0 }]);
    const included = await table.vectorSearch([1, 0], {
      filter: {},
      controls: { $select: ["title"] },
    });
    expect(included).toEqual([{ title: "x", _distance: 0, $score: 1 }]);

    const page = await table.vectorSearchWithCount([1, 0], {
      filter: {},
      controls: { $select: { embedding: 0 } },
    });
    expect(page).toEqual({ data: [{ title: "x", _distance: 0, $score: 1 }], count: 7 });
  });
});
