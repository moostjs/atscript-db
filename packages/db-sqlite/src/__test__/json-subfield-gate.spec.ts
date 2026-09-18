import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

/**
 * Finding 62 on a real engine (since 0.1.128): a descendant of a `@db.json` /
 * array column has no column on SQLite — every read / aggregate / mutation
 * entry point rejects it with `INVALID_QUERY` before any SQL is built (no
 * `no such column: metadata.clicks` 500s), while the JSON parent itself stays
 * selectable as a whole value.
 */

type Row = Record<string, any>;
let GateWidget: any;

describe("SQLite — JSON descendant paths are rejected before SQL", () => {
  let driver: BetterSqlite3Driver;
  let table: AtscriptDbTable<any, Row, any, any, any, any, any>;
  let executed: string[];

  beforeAll(async () => {
    await prepareFixtures();
    ({ GateWidget } = await import("./fixtures/guard-fixtures.as"));
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    const adapter = new SqliteAdapter(driver);
    table = new AtscriptDbTable(GateWidget, adapter);
    await table.ensureTable();
    await table.insertOne({ name: "w1", metadata: { clicks: 1, impressions: 10 }, tags: ["a"] });
    executed = [];
    const origAll = driver.all.bind(driver);
    const origRun = driver.run.bind(driver);
    (driver as any).all = (sql: string, ...rest: unknown[]) => {
      executed.push(sql);
      return (origAll as any)(sql, ...rest);
    };
    (driver as any).run = (sql: string, ...rest: unknown[]) => {
      executed.push(sql);
      return (origRun as any)(sql, ...rest);
    };
  });

  afterEach(() => {
    driver.close();
  });

  const expectGuard = async (promise: Promise<unknown>, path: string) => {
    await expect(promise).rejects.toMatchObject({
      code: "INVALID_QUERY",
      errors: [{ path, message: expect.stringContaining("JSON-stored column") }],
    });
  };

  it("$select of a JSON descendant → INVALID_QUERY, no SQL executed", async () => {
    await expectGuard(
      table.findMany({ filter: {}, controls: { $select: ["id", "metadata.clicks"] } } as any),
      "metadata.clicks",
    );
    expect(executed).toEqual([]);
  });

  it("filter / $sort / $groupBy / aggregate $field on a JSON descendant → INVALID_QUERY", async () => {
    await expectGuard(
      table.findMany({ filter: { "metadata.clicks": 1 } } as any),
      "metadata.clicks",
    );
    await expectGuard(table.count({ filter: { "tags.0": "a" } } as any), "tags.0");
    await expectGuard(
      table.findMany({ filter: {}, controls: { $sort: { "metadata.clicks": 1 } } } as any),
      "metadata.clicks",
    );
    await expectGuard(
      table.aggregate({
        filter: {},
        controls: {
          $groupBy: ["metadata.clicks"],
          $select: ["metadata.clicks", { $fn: "count", $field: "*" }],
        },
      } as any),
      "metadata.clicks",
    );
    await expectGuard(
      table.aggregate({
        filter: {},
        controls: {
          $groupBy: ["name"],
          $select: ["name", { $fn: "sum", $field: "metadata.clicks", $as: "c" }],
        },
      } as any),
      "metadata.clicks",
    );
    expect(executed).toEqual([]);
  });

  it("updateMany / deleteMany with a JSON-descendant filter → INVALID_QUERY, rows untouched", async () => {
    await expectGuard(
      table.updateMany({ "metadata.clicks": 1 } as any, { name: "changed" } as any),
      "metadata.clicks",
    );
    await expectGuard(
      table.deleteMany({ "metadata.impressions": 10 } as any),
      "metadata.impressions",
    );
    expect(executed).toEqual([]);
    const rows = await table.findMany({ filter: {} });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("w1");
  });

  it("the JSON parent is selectable as a whole value; unknown paths say Unknown field", async () => {
    const rows = await table.findMany({
      filter: {},
      controls: { $select: ["id", "metadata"] },
    } as any);
    expect(rows[0]!.metadata).toEqual({ clicks: 1, impressions: 10 });
    await expect(table.findMany({ filter: { nope: 1 } } as any)).rejects.toMatchObject({
      code: "INVALID_QUERY",
      errors: [{ path: "nope", message: 'Unknown field "nope"' }],
    });
  });
});
