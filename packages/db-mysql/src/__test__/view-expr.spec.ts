import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures, createMockDriver } from "./test-utils";

// First-row joins and computed view columns (since 0.1.147): the CREATE VIEW
// DDL (mock driver), and — when MYSQL_TEST_URI points at a MySQL server — the
// same result matrix as the SQLite engine spec (doubles, x / 0 = NULL, ties by
// the lowest primary key, NULL as the smallest order key).

const URI = process.env.MYSQL_TEST_URI;

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-expr.as");
});

async function createViewSql(type: any): Promise<string> {
  const driver = createMockDriver();
  const space = new DbSpace(() => new MysqlAdapter(driver));
  await space.getView(type).dbAdapter.ensureTable();
  const ddl = driver.calls
    .filter((c) => c.method === "exec" && c.sql.includes("VIEW"))
    .map((c) => c.sql);
  expect(ddl).toHaveLength(1);
  return ddl[0];
}

describe("MysqlAdapter — first-row joins and computed columns (DDL)", () => {
  it("renders the first-row join as a correlated subquery and computed columns in double", async () => {
    const sql = await createViewSql(fx.VxQueue);
    expect(sql).toContain(
      "LEFT JOIN `vx_issues` AS `VxOldest` ON `VxOldest`.`id` = (SELECT `VxOldest`.`id` FROM `vx_issues` AS `VxOldest` WHERE `VxOldest`.`ticketId` = `vx_tickets`.`id` AND `VxOldest`.`status` = 'open' ORDER BY `VxOldest`.`raised_at` ASC, `VxOldest`.`id` ASC LIMIT 1)",
    );
    expect(sql).toContain(
      "((CAST(COUNT(CASE WHEN `vx_issues`.`status` = 'open' THEN `vx_issues`.`id` END) AS DOUBLE) * CAST(10 AS DOUBLE))",
    );
    expect(sql).toContain("NULLIF(");
    expect(sql).not.toContain("NULLS FIRST");
  });

  it("references a computed column in HAVING by its expression, not the SELECT alias", async () => {
    expect(await createViewSql(fx.VxBusy)).toContain(
      "HAVING (CAST(COUNT(CASE WHEN `vx_issues`.`status` = 'open' THEN `vx_issues`.`id` END) AS DOUBLE) * CAST(10 AS DOUBLE)) > 0",
    );
    // a bare `severity` would bind to the grouped `vx_issues`.`severity` on MySQL
    const collide = await createViewSql(fx.VxCollide);
    expect(collide).toContain("HAVING (CAST(COUNT(*) AS DOUBLE) * CAST(2 AS DOUBLE)) = 2");
    expect(collide).not.toContain("HAVING `severity`");
    // a JSON-extracted dimension aliased like a grouped column reads MIN(<extract>)
    const jsonCollide = await createViewSql(fx.VxJsonCollide);
    expect(jsonCollide).toContain("HAVING MIN(CASE WHEN JSON_TYPE(");
    expect(jsonCollide).not.toContain("HAVING `severity`");
  });
});

describe.skipIf(!URI)("MysqlAdapter — first-row joins and computed columns (MySQL server)", () => {
  let driver: Mysql2Driver;
  let space: DbSpace;
  const inventory = () => [
    fx.VxReporter,
    fx.VxTicket,
    fx.VxIssue,
    fx.VxQueue,
    fx.VxBusy,
    fx.VxLatest,
    fx.VxEarliest2,
    fx.VxRatio,
    fx.VxRanked,
    fx.VxLevels,
    fx.VxCollide,
    fx.VxJsonCollide,
  ];

  beforeAll(async () => {
    driver = new Mysql2Driver(URI!);
    for (const view of [
      "vx_json_collide",
      "vx_collide",
      "vx_levels",
      "vx_ranked",
      "vx_ratio",
      "vx_earliest",
      "vx_latest",
      "vx_busy",
      "vx_queue",
    ]) {
      await driver.exec(`DROP VIEW IF EXISTS ${view}`);
    }
    for (const table of ["vx_issues", "vx_tickets", "vx_reporters", "__atscript_control"]) {
      await driver.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    space = new DbSpace(() => new MysqlAdapter(driver));
    const result = await new SchemaSync(space).run(inventory(), { force: true });
    expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
    expect(result.status).toBe("synced");
    await space.getTable(fx.VxReporter).insertMany([
      { id: 1, name: "Rita" },
      { id: 2, name: "Sam" },
    ]);
    await space.getTable(fx.VxTicket).insertMany([
      { id: 1, title: "A" },
      { id: 2, title: "B" },
      { id: 3, title: "C" },
    ]);
    await space.getTable(fx.VxIssue).insertMany([
      {
        id: 1,
        ticketId: 1,
        reporterId: 1,
        raisedAt: 100,
        severity: 3,
        status: "open",
        overdue: true,
        estimate: 4,
        meta: { level: 2 },
      },
      {
        id: 2,
        ticketId: 1,
        reporterId: 2,
        raisedAt: 100,
        severity: 5,
        status: "open",
        overdue: false,
        estimate: 0,
        meta: { level: 2 },
      },
      { id: 3, ticketId: 1, raisedAt: 50, severity: 1, status: "closed", overdue: false },
      { id: 4, ticketId: 2, reporterId: 2, severity: 7, status: "open", overdue: false },
      {
        id: 5,
        ticketId: 2,
        raisedAt: 200,
        severity: 2,
        status: "open",
        overdue: true,
        estimate: 6,
        meta: { level: 5 },
      },
    ]);
    // ~40 sequential DDL / seed statements: a remote server needs more than the 10 s default
  }, 60_000);

  afterAll(async () => {
    await driver?.close();
  });

  /** `-0` → `0` (a negated zero may come back signed). */
  const norm = (row: unknown) =>
    Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, v === 0 ? 0 : v]),
    );
  const rows = async (type: any, controls: Record<string, unknown> = {}, filter = {}) =>
    (await space.getView(type).findMany({ filter, controls })).map(norm);

  it("grouped view: counts unaffected, first-row fields from one row, computed columns", async () => {
    expect(await rows(fx.VxQueue, { $sort: { id: 1 } })).toEqual([
      {
        id: 1,
        title: "A",
        openCount: 2,
        overdueCount: 1,
        openEstimate: 4,
        // tie on raisedAt 100 → lowest id; issue 3 (older) is closed
        oldestId: 1,
        oldestRaisedAt: 100,
        oldestSeverity: 3,
        reporterName: "Rita",
        rank: 21,
        avgEstimate: 2,
        priority: 321,
        negDiff: -2,
        plusOne: 3,
      },
      {
        id: 2,
        title: "B",
        openCount: 2,
        overdueCount: 1,
        openEstimate: 6,
        // NULL raisedAt is the smallest → issue 4
        oldestId: 4,
        oldestRaisedAt: null,
        oldestSeverity: 7,
        reporterName: "Sam",
        rank: 21,
        avgEstimate: 3,
        priority: 721,
        negDiff: -2,
        plusOne: 3,
      },
      {
        id: 3,
        title: "C",
        openCount: 0,
        overdueCount: 0,
        openEstimate: 0,
        oldestId: null,
        oldestRaisedAt: null,
        oldestSeverity: null,
        reporterName: null,
        rank: 0,
        // 0 / 0 → NULL
        avgEstimate: null,
        priority: 0,
        negDiff: 0,
        plusOne: 1,
      },
    ]);
  });

  it("sorts, filters and pages on computed columns", async () => {
    const sorted = await rows(fx.VxQueue, { $sort: { priority: -1, id: 1 }, $select: ["id"] });
    expect(sorted).toEqual([{ id: 2 }, { id: 1 }, { id: 3 }]);
    expect(
      await rows(fx.VxQueue, { $sort: { id: 1 }, $select: ["id"] }, { rank: { $gte: 10 } }),
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await rows(fx.VxQueue, { $select: ["id"] }, { avgEstimate: null })).toEqual([{ id: 3 }]);
    const page1 = await rows(fx.VxQueue, {
      $sort: { rank: -1, id: 1 },
      $limit: 2,
      $select: ["id"],
    });
    const page2 = await rows(fx.VxQueue, {
      $sort: { rank: -1, id: 1 },
      $skip: 2,
      $limit: 2,
      $select: ["id"],
    });
    expect([...page1, ...page2]).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("@db.view.having on a computed column", async () => {
    expect(await rows(fx.VxBusy, { $sort: { id: 1 } })).toEqual([
      { id: 1, openCount: 2, rank: 20 },
      { id: 2, openCount: 2, rank: 20 },
    ]);
  });

  it("inner first-row join, descending: newest issue, NULL last, ticket without issues dropped", async () => {
    expect(await rows(fx.VxLatest, { $sort: { id: 1 } })).toEqual([
      { id: 1, newestId: 1, newestRaisedAt: 100 },
      { id: 2, newestId: 5, newestRaisedAt: 200 },
    ]);
  });

  it("unfiltered first row: a NULL order key is the smallest", async () => {
    expect(await rows(fx.VxEarliest2, { $sort: { id: 1 } })).toEqual([
      { id: 1, earliestId: 3 },
      { id: 2, earliestId: 4 },
      { id: 3, earliestId: null },
    ]);
  });

  it("per-row computed columns: float division, division by zero and NULL propagation", async () => {
    expect(await rows(fx.VxRatio, { $sort: { id: 1 } })).toEqual([
      { id: 1, severity: 3, estimate: 4, weight: 12, half: 1.5, perEstimate: 0.75 },
      { id: 2, severity: 5, estimate: 0, weight: 0, half: 2.5, perEstimate: null },
      { id: 3, severity: 1, estimate: null, weight: 0, half: 0.5, perEstimate: null },
      { id: 4, severity: 7, estimate: null, weight: 0, half: 3.5, perEstimate: null },
      { id: 5, severity: 2, estimate: 6, weight: 12, half: 1, perEstimate: 1 / 3 },
    ]);
  });

  it("a view over a view reads and sorts on a computed column", async () => {
    expect(await rows(fx.VxRanked, { $sort: { priority: -1 } })).toEqual([
      { id: 2, rank: 21, priority: 721 },
      { id: 1, rank: 21, priority: 321 },
    ]);
  });
  it("HAVING on a computed column named like a grouped source column binds to the computed value", async () => {
    // `severity` (computed: n * 2 = 2 for every group) collides with the grouped `vx_issues.severity`
    expect(await rows(fx.VxCollide, { $sort: { sev: 1 } })).toEqual([
      { sev: 1, n: 1, severity: 2 },
      { sev: 2, n: 1, severity: 2 },
      { sev: 3, n: 1, severity: 2 },
      { sev: 5, n: 1, severity: 2 },
      { sev: 7, n: 1, severity: 2 },
    ]);
  });

  it("HAVING on a JSON-extracted dimension named like a grouped source column binds to the extracted value", async () => {
    // `severity` (meta.level) collides with the grouped `vx_issues.severity`; levels are 2, 2, 5, null, null
    expect(await rows(fx.VxJsonCollide, { $sort: { sev: 1 } })).toEqual([
      { sev: 3, severity: 2, n: 1 },
      { sev: 5, severity: 2, n: 1 },
    ]);
  });

  it("a computed column over a JSON-extracted GROUP BY dimension", async () => {
    expect(await rows(fx.VxLevels, { $sort: { score: 1 } })).toEqual([
      { level: null, n: 2, score: 2 },
      { level: 2, n: 2, score: 6 },
      { level: 5, n: 1, score: 11 },
    ]);
  });
});
