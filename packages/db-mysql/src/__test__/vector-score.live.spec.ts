import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import {
  mysqlAdmin,
  mysqlReachable,
  recreateMysqlDatabase,
  dropMysqlDatabase,
} from "./live-server";
import {
  ANGLES,
  ANGLE_SCORES,
  POINTS,
  POINT_SCORES,
  Q_ANGLE,
  Q_POINT,
  expectAtLeast,
  expectDescending,
  expectScores,
  ids,
  type Row,
} from "../../../db/test-kit/vector-score-data";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live server that evaluates the adapter's
// distance expressions (`VEC_DISTANCE_COSINE` / `VEC_DISTANCE_EUCLIDEAN` over
// `STRING_TO_VECTOR`), skips otherwise — and no released server has both
// (MariaDB has the former, MySQL the latter; see the MySQL adapter docs, vector
// support), so it skips everywhere today. Override with `ATSCRIPT_MYSQL_TEST_URL`
// (or `MYSQL_TEST_URI`; an admin connection — the spec creates and drops its
// own `vector_score` database).
//
// Since 0.1.183 every vector row carries `$score` (the MongoDB Atlas
// `vectorSearchScore` scale) and the threshold is that score: a row is
// returned iff its `$score` reaches it. Before, a `euclidean` threshold used
// the cosine conversion. `dotProduct` is not covered: `VEC_DISTANCE_DOT` has
// no documented scale.

const DB = "vector_score";

const reachable = await mysqlReachable();
const vectorSql =
  reachable &&
  (await mysqlAdmin(
    "SELECT VEC_DISTANCE_COSINE(STRING_TO_VECTOR('[1,0]'), STRING_TO_VECTOR('[0,1]')), " +
      "VEC_DISTANCE_EUCLIDEAN(STRING_TO_VECTOR('[1,0]'), STRING_TO_VECTOR('[0,1]'))",
  ));

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;

const t = (type: unknown): any => space.getTable(type as never);

async function search(type: unknown, vector: number[], controls = {}): Promise<Row[]> {
  return t(type).vectorSearch(vector, { filter: {}, controls });
}

describe.skipIf(!vectorSql)("[mysql live] vector $score (since 0.1.183)", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/vector-score.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver));
    const result = await syncSchema(space, [fx.VsCos, fx.VsL2, fx.VsSchema]);
    expect(result.status).toBe("synced");
    await t(fx.VsCos).insertMany(ANGLES);
    await t(fx.VsL2).insertMany(POINTS);
    await t(fx.VsSchema).insertMany(POINTS);
  });

  afterAll(async () => {
    await driver?.close();
    await dropMysqlDatabase(DB);
  });

  it("cosine: $score = (1 + cos) / 2, in 0–1, falling along the order; no _distance (since 0.1.184)", async () => {
    const rows = await search(fx.VsCos, Q_ANGLE);
    expect(ids(rows)).toEqual(["a", "b", "c", "e", "d"]);
    expectScores(rows, ANGLE_SCORES);
    expectDescending(rows);
  });

  it("euclidean: $score = 1 / (1 + distance); no _distance", async () => {
    const rows = await search(fx.VsL2, Q_POINT);
    expect(ids(rows)).toEqual(["a", "b", "c", "d", "e"]);
    expectScores(rows, POINT_SCORES);
    expectDescending(rows);
  });

  it("$select keeps $score in its inclusion and exclusion forms", async () => {
    const [included] = await search(fx.VsCos, Q_ANGLE, { $select: ["title"] });
    expect(included).toEqual({ title: "0°", $score: 1 });
    const [excluded] = await search(fx.VsCos, Q_ANGLE, { $select: { embedding: 0 } });
    expect(excluded).toEqual({ id: "a", title: "0°", $score: 1 });
  });

  it("cosine threshold: every row reaches it, the row just under it is out", async () => {
    // b scores 0.9330
    const rows = await search(fx.VsCos, Q_ANGLE, { $threshold: 0.93 });
    expect(ids(rows)).toEqual(["a", "b"]);
    expectAtLeast(rows, 0.93);
    expect(ids(await search(fx.VsCos, Q_ANGLE, { $threshold: 0.94 }))).toEqual(["a"]);
  });

  it("euclidean threshold is a score: 0.3 keeps distance <= 2.33", async () => {
    const rows = await search(fx.VsL2, Q_POINT, { $threshold: 0.3 });
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expectAtLeast(rows, 0.3);
    // d scores 0.25: in at 0.24 (the cosine conversion capped at 1.52 and dropped it), out at 0.26
    expect(ids(await search(fx.VsL2, Q_POINT, { $threshold: 0.24 }))).toEqual(["a", "b", "c", "d"]);
    expect(ids(await search(fx.VsL2, Q_POINT, { $threshold: 0.26 }))).toEqual(["a", "b", "c"]);
  });

  it("euclidean threshold edges: 0 keeps every row, 1 exact matches only, above 1 none", async () => {
    // the cosine conversion capped 0 at distance 2
    expect(await search(fx.VsL2, Q_POINT, { $threshold: 0 })).toHaveLength(5);
    expect(ids(await search(fx.VsL2, Q_POINT, { $threshold: 1 }))).toEqual(["a"]);
    expect(await search(fx.VsL2, Q_POINT, { $threshold: 1.5 })).toEqual([]);
  });

  it("a schema-level euclidean @db.search.vector.threshold is a score too", async () => {
    const rows = await search(fx.VsSchema, Q_POINT);
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expectAtLeast(rows, 0.3);
  });

  it("vectorSearchWithCount: rows carry $score and the count agrees with them", async () => {
    for (const [type, vector, threshold] of [
      [fx.VsCos, Q_ANGLE, 0.4],
      [fx.VsL2, Q_POINT, 0.3],
    ] as const) {
      const all = await t(type).vectorSearchWithCount(vector, {
        filter: {},
        controls: { $threshold: threshold },
      });
      expect(ids(all.data)).toEqual(["a", "b", "c"]);
      expect(all.count).toBe(3);
      expectAtLeast(all.data, threshold);

      const page = await t(type).vectorSearchWithCount(vector, {
        filter: {},
        controls: { $threshold: threshold, $limit: 2, $select: ["id"] },
      });
      expect(page.count).toBe(3);
      expect(ids(page.data)).toEqual(["a", "b"]);
      for (const row of page.data) expect(typeof row.$score).toBe("number");
    }
  });
});
