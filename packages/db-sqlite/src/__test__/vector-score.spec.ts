import { describe, it, expect, beforeAll, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";
import {
  ANGLES,
  POINTS,
  Q_ANGLE,
  Q_POINT,
  expectAtLeast,
  expectDescending,
  ids,
  type Row,
} from "../../../db/test-kit/vector-score-data";

// Since 0.1.183 every vector row carries `$score` (higher = closer, the
// MongoDB Atlas `vectorSearchScore` scale) next to the engine's `_distance`,
// and the threshold is that score on every metric: a row is returned iff its
// `$score` reaches it. Before, a `euclidean` threshold was a raw distance cap.

let sqliteVecAvailable = true;
try {
  new BetterSqlite3Driver(":memory:", { vector: true }).close();
} catch {
  sqliteVecAvailable = false;
}

let fx: Record<string, any>;
let driver: BetterSqlite3Driver | undefined;

async function seeded(Type: unknown, rows: unknown[]): Promise<AtscriptDbTable> {
  driver = new BetterSqlite3Driver(":memory:", { vector: true });
  const table = new AtscriptDbTable(Type as any, new SqliteAdapter(driver));
  await table.ensureTable();
  await table.syncIndexes();
  await table.insertMany(rows as never);
  return table;
}

async function search(table: AtscriptDbTable, vector: number[], controls = {}): Promise<Row[]> {
  return (await table.vectorSearch(vector, { filter: {}, controls } as never)) as never;
}

describe.skipIf(!sqliteVecAvailable)("[sqlite] vector $score (since 0.1.183)", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/vector-score.as");
  });

  afterEach(() => {
    driver?.close();
    driver = undefined;
  });

  it("cosine: every row has $score = 1 − _distance / 2, in 0–1, falling along the order", async () => {
    const rows = await search(await seeded(fx.VsCos, ANGLES), Q_ANGLE);
    expect(ids(rows)).toEqual(["a", "b", "c", "e", "d"]);
    for (const row of rows) {
      expect(row.$score).toBeCloseTo(1 - row._distance / 2, 12);
      expect(row.$score).toBeGreaterThanOrEqual(0);
      expect(row.$score).toBeLessThanOrEqual(1);
    }
    expect(rows.map((r) => r.$score)).toEqual([
      expect.closeTo(1, 6),
      expect.closeTo((1 + Math.cos(Math.PI / 6)) / 2, 6),
      expect.closeTo(0.5, 6),
      expect.closeTo(0.25, 6),
      expect.closeTo(0, 6),
    ]);
    expectDescending(rows);
  });

  it("euclidean: $score = 1 / (1 + _distance)", async () => {
    const rows = await search(await seeded(fx.VsL2, POINTS), Q_POINT);
    expect(ids(rows)).toEqual(["a", "b", "c", "d", "e"]);
    for (const row of rows) expect(row.$score).toBeCloseTo(1 / (1 + row._distance), 12);
    expect(rows.map((r) => r.$score)).toEqual([
      expect.closeTo(1, 6),
      expect.closeTo(2 / 3, 6),
      expect.closeTo(0.5, 6),
      expect.closeTo(0.25, 6),
      expect.closeTo(0.1, 6),
    ]);
    expectDescending(rows);
  });

  it("dotProduct runs as cosine on SQLite, so it is scored as cosine", async () => {
    const rows = await search(await seeded(fx.VsDot, ANGLES), Q_ANGLE);
    expect(ids(rows)).toEqual(["a", "b", "c", "e", "d"]);
    for (const row of rows) expect(row.$score).toBeCloseTo(1 - row._distance / 2, 12);
    expectDescending(rows);
  });

  it("$select keeps $score (and _distance) in its inclusion and exclusion forms", async () => {
    const table = await seeded(fx.VsCos, ANGLES);
    const included = await search(table, Q_ANGLE, { $select: ["title"] });
    expect(included[0]).toEqual({ title: "0°", _distance: expect.any(Number), $score: 1 });
    const excluded = await search(table, Q_ANGLE, { $select: { embedding: 0 } });
    expect(excluded[0]).toEqual({
      id: "a",
      title: "0°",
      _distance: expect.any(Number),
      $score: 1,
    });
    // not a field: it cannot be named
    await expect(search(table, Q_ANGLE, { $select: ["title", "$score"] })).rejects.toThrow(
      'Unknown field "$score"',
    );
  });

  it("cosine threshold: every row reaches it, the row just under it is out", async () => {
    const table = await seeded(fx.VsCos, ANGLES);
    // b scores 0.9330
    const atB = await search(table, Q_ANGLE, { $threshold: 0.93 });
    expect(ids(atB)).toEqual(["a", "b"]);
    expectAtLeast(atB, 0.93);
    expect(ids(await search(table, Q_ANGLE, { $threshold: 0.94 }))).toEqual(["a"]);
  });

  it("euclidean threshold is a score: 0.3 keeps distance <= 2.33 (it was a 0.3 distance cap)", async () => {
    const table = await seeded(fx.VsL2, POINTS);
    const rows = await search(table, Q_POINT, { $threshold: 0.3 });
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expectAtLeast(rows, 0.3);
    // d scores 0.25: in at 0.24, out at 0.26
    expect(ids(await search(table, Q_POINT, { $threshold: 0.24 }))).toEqual(["a", "b", "c", "d"]);
    expect(ids(await search(table, Q_POINT, { $threshold: 0.26 }))).toEqual(["a", "b", "c"]);
  });

  it("euclidean threshold edges: 0 keeps every row, 1 exact matches only, above 1 none", async () => {
    const table = await seeded(fx.VsL2, POINTS);
    expect(ids(await search(table, Q_POINT, { $threshold: 0 }))).toHaveLength(5);
    expect(ids(await search(table, Q_POINT, { $threshold: 1 }))).toEqual(["a"]);
    expect(await search(table, Q_POINT, { $threshold: 1.5 })).toEqual([]);
  });

  it("dotProduct threshold (scored as cosine): every row reaches it, the row just under it is out", async () => {
    const table = await seeded(fx.VsDot, ANGLES);
    const rows = await search(table, Q_ANGLE, { $threshold: 0.4 });
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expectAtLeast(rows, 0.4);
    // c scores 0.5
    expect(ids(await search(table, Q_ANGLE, { $threshold: 0.51 }))).toEqual(["a", "b"]);
  });

  it("a schema-level euclidean @db.search.vector.threshold is a score too", async () => {
    const rows = await search(await seeded(fx.VsSchema, POINTS), Q_POINT);
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expectAtLeast(rows, 0.3);
  });

  it("vectorSearchWithCount: rows carry $score and the count agrees with them", async () => {
    const table = await seeded(fx.VsCos, ANGLES);
    const all = await table.vectorSearchWithCount(Q_ANGLE, {
      filter: {},
      controls: { $threshold: 0.4 },
    } as never);
    expect(all.count).toBe(3);
    expect(ids(all.data as never)).toEqual(["a", "b", "c"]);
    expectAtLeast(all.data as never, 0.4);

    const page = await table.vectorSearchWithCount(Q_ANGLE, {
      filter: {},
      controls: { $threshold: 0.4, $limit: 2, $select: ["id"] },
    } as never);
    expect(page.count).toBe(3);
    expect(page.data).toEqual([
      { id: "a", _distance: expect.any(Number), $score: expect.closeTo(1, 6) },
      { id: "b", _distance: expect.any(Number), $score: expect.closeTo(0.933, 3) },
    ]);
  });
});
