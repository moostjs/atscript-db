import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgAdmin, pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";
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

// Server-gated: runs against a live PostgreSQL with pgvector available, skips
// otherwise (CI has no server). Override the server with
// `ATSCRIPT_PG_TEST_URL` (or `POSTGRES_TEST_URI`; an admin connection — the
// spec creates and drops its own `vector_score` database).
//
// Since 0.1.183 every vector row carries `$score` (the MongoDB Atlas
// `vectorSearchScore` scale) and the threshold is that score on every metric:
// a row is returned iff its `$score` reaches it. Before, a `euclidean`
// threshold was a raw distance cap and a `dotProduct` one required
// `dot >= threshold` — the euclidean / dotProduct cases below are their
// regression tests.

const DB = "vector_score";

const reachable = await pgReachable();
const pgvector =
  reachable &&
  (await pgAdmin(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN RAISE EXCEPTION 'pgvector is not available'; END IF; END $$`,
  ));

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

const t = (type: unknown): any => space.getTable(type as never);

async function search(type: unknown, vector: number[], controls = {}): Promise<Row[]> {
  return t(type).vectorSearch(vector, { filter: {}, controls });
}

describe.skipIf(!pgvector)("[postgres live] vector $score (since 0.1.183)", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/vector-score.as");
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver));
    const result = await syncSchema(space, [fx.VsCos, fx.VsL2, fx.VsDot, fx.VsSchema, fx.VsOpt]);
    expect(result.status).toBe("synced");
    await t(fx.VsCos).insertMany(ANGLES);
    await t(fx.VsDot).insertMany(ANGLES);
    await t(fx.VsL2).insertMany(POINTS);
    await t(fx.VsSchema).insertMany(POINTS);
    await t(fx.VsOpt).insertMany([...POINTS, { id: "n", title: "no vector" }]);
  });

  afterAll(async () => {
    await driver?.close();
    await dropPgDatabase(DB);
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

  it("dotProduct: $score = (1 + dot) / 2, from the <#> distance (the negative dot)", async () => {
    const rows = await search(fx.VsDot, Q_ANGLE);
    expect(ids(rows)).toEqual(["a", "b", "c", "e", "d"]);
    // unit vectors: dot = cos
    expectScores(rows, ANGLE_SCORES);
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

  it("euclidean threshold is a score: 0.3 keeps distance <= 2.33 (it was a 0.3 distance cap)", async () => {
    const rows = await search(fx.VsL2, Q_POINT, { $threshold: 0.3 });
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expectAtLeast(rows, 0.3);
    // d scores 0.25: in at 0.24, out at 0.26
    expect(ids(await search(fx.VsL2, Q_POINT, { $threshold: 0.24 }))).toEqual(["a", "b", "c", "d"]);
    expect(ids(await search(fx.VsL2, Q_POINT, { $threshold: 0.26 }))).toEqual(["a", "b", "c"]);
  });

  it("euclidean threshold edges: 0 keeps every row, 1 exact matches only, above 1 none", async () => {
    expect(await search(fx.VsL2, Q_POINT, { $threshold: 0 })).toHaveLength(5);
    expect(ids(await search(fx.VsL2, Q_POINT, { $threshold: 1 }))).toEqual(["a"]);
    expect(await search(fx.VsL2, Q_POINT, { $threshold: 1.5 })).toEqual([]);
  });

  it("dotProduct threshold is (1 + dot) / 2: 0.93 keeps b at dot .866 (it required dot >= 0.93)", async () => {
    const rows = await search(fx.VsDot, Q_ANGLE, { $threshold: 0.93 });
    expect(ids(rows)).toEqual(["a", "b"]);
    expectAtLeast(rows, 0.93);
    expect(ids(await search(fx.VsDot, Q_ANGLE, { $threshold: 0.94 }))).toEqual(["a"]);
    // c (dot 0) scores 0.5
    expect(ids(await search(fx.VsDot, Q_ANGLE, { $threshold: 0.49 }))).toEqual(["a", "b", "c"]);
  });

  it("a schema-level euclidean @db.search.vector.threshold is a score too", async () => {
    const rows = await search(fx.VsSchema, Q_POINT);
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expectAtLeast(rows, 0.3);
  });

  it("vectorSearchWithCount: rows carry $score and the count agrees with them", async () => {
    for (const [type, vector, threshold, expected] of [
      [fx.VsCos, Q_ANGLE, 0.4, ["a", "b", "c"]],
      [fx.VsL2, Q_POINT, 0.3, ["a", "b", "c"]],
      [fx.VsDot, Q_ANGLE, 0.4, ["a", "b", "c"]],
    ] as const) {
      const all = await t(type).vectorSearchWithCount(vector, {
        filter: {},
        controls: { $threshold: threshold },
      });
      expect(ids(all.data)).toEqual(expected);
      expect(all.count).toBe(expected.length);
      expectAtLeast(all.data, threshold);

      const page = await t(type).vectorSearchWithCount(vector, {
        filter: {},
        controls: { $threshold: threshold, $limit: 2, $select: ["id"] },
      });
      expect(page.count).toBe(expected.length);
      expect(ids(page.data)).toEqual(expected.slice(0, 2));
      for (const row of page.data) expect(typeof row.$score).toBe("number");
    }
  });

  it("a row without a stored vector is never returned or counted, a euclidean threshold of 0 included", async () => {
    const all = ["a", "b", "c", "d", "e"];
    expect(ids(await search(fx.VsOpt, Q_POINT))).toEqual(all);
    expect(ids(await search(fx.VsOpt, Q_POINT, { $threshold: 0 }))).toEqual(all);
    const counted = await t(fx.VsOpt).vectorSearchWithCount(Q_POINT, {
      filter: {},
      controls: { $threshold: 0 },
    });
    expect([ids(counted.data), counted.count]).toEqual([all, 5]);
  });
});
