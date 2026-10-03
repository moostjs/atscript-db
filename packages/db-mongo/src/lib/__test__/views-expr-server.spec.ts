import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Db, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { buildViewPipeline } from "../mongo-view-pipeline";
import { prepareFixtures } from "./test-utils";

// First-row joins and computed view columns against a real MongoDB
// (mongodb-memory-server), since 0.1.147 — the same result matrix as the SQL
// engines: doubles (7 / 2 = 3.5), x / 0 = null (no error), ties by the lowest
// primary key, null as the smallest order key.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-expr.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("view_expr");
  space = new DbSpace(() => new MongoAdapter(db, client));

  const result = await new SchemaSync(space).run(
    [
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
    ],
    { force: true },
  );
  expect(result.status).toBe("synced");

  await space.getTable(fx.VxReporter).insertMany([
    { id: 1, name: "Rita" },
    { id: 2, name: "Sam" },
  ] as never);
  await space.getTable(fx.VxTicket).insertMany([
    { id: 1, title: "A" },
    { id: 2, title: "B" },
    { id: 3, title: "C" },
  ] as never);
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
  ] as never);
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

describe("MongoDB — first-row join pipeline", () => {
  it("renders a first-row join as a $lookup pipeline with $sort + $limit 1", () => {
    const lookup = buildViewPipeline(space.getView(fx.VxQueue))[2].$lookup;
    expect(lookup.from).toBe("vx_issues");
    expect(lookup.as).toBe("__joined_VxOldest");
    expect(lookup.pipeline.slice(1)).toEqual([{ $sort: { raised_at: 1, id: 1 } }, { $limit: 1 }]);
  });
});

/** `-0` → `0` (a negated zero may come back signed). */
const norm = (row: unknown) =>
  Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, v === 0 ? 0 : v]),
  );
const rows = async (type: any, controls: Record<string, unknown> = {}, filter = {}) =>
  (await space.getView(type).findMany({ filter, controls })).map(norm);

describe("MongoDB — first-row joins and computed columns", () => {
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
  it("a computed column over a JSON-extracted GROUP BY dimension", async () => {
    expect(await rows(fx.VxLevels, { $sort: { score: 1 } })).toEqual([
      { level: null, n: 2, score: 2 },
      { level: 2, n: 2, score: 6 },
      { level: 5, n: 1, score: 11 },
    ]);
  });
});
