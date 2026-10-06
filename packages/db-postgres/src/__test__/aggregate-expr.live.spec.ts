import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { AE_ROWS, defineAggregateExprCases } from "../../../db/test-kit/aggregate-expr-cases";
import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";

// Live DDL against a real server is slow under the parallel workspace run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (CI has no server). Override the server with
// `ATSCRIPT_PG_TEST_URL` (an admin connection; the spec creates and drops its
// own `aggexpr_live` database).
//
// Query-time arithmetic and first / last (since 0.1.148): the shared case table
// every adapter runs, plus what only a real server shows — the window derived
// table, the boolean aggregates, the overflow mapping.

const SERVER_URL =
  process.env.ATSCRIPT_PG_TEST_URL ?? "postgresql://postgres:test@127.0.0.1:54371/postgres";
const DB = "aggexpr_live";

async function adminQuery(sql: string): Promise<boolean> {
  try {
    const { Client } = (await import("pg")).default;
    const client = new Client({ connectionString: SERVER_URL, connectionTimeoutMillis: 1500 });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
    return true;
  } catch {
    return false;
  }
}

const reachable = await adminQuery("SELECT 1");

/** price * (2^53 - 1)^20, balanced (the expression depth is capped) — past a double's range. */
const power = (n: number): unknown =>
  n === 1
    ? Number.MAX_SAFE_INTEGER
    : { $op: "*", $args: [power(Math.ceil(n / 2)), power(Math.floor(n / 2))] };
const overflow = () => ({
  $op: "*",
  $args: ["price", { $op: "*", $args: [power(16), power(4)] }],
});

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

const issues = () => space.getTable(fx.AeIssue) as never;

describe.skipIf(!reachable)("[postgres live] aggregate arithmetic and first / last", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/agg-expr.as");
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}"`);
    await adminQuery(`CREATE DATABASE "${DB}"`);
    const url = new URL(SERVER_URL);
    url.pathname = `/${DB}`;
    driver = new PgDriver({ connectionString: url.toString() });
    space = new DbSpace(() => new PostgresAdapter(driver));
    const result = await syncSchema(space, [fx.AeIssue, fx.AeRef, fx.AeArray]);
    expect(result.status).toBe("synced");
    await (issues() as any).insertMany(AE_ROWS);
  });

  afterAll(async () => {
    await driver?.close();
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}"`);
  });

  defineAggregateExprCases("PostgreSQL", issues);

  describe("first / last over a type without MIN", () => {
    it("a uuid column renders through a type-agnostic pick", async () => {
      const refs = space.getTable(fx.AeRef) as any;
      const A = "11111111-1111-4111-8111-111111111111";
      const B = "22222222-2222-4222-8222-222222222222";
      await refs.insertMany([
        { id: 1, grp: 1, ref: B, at: 2 },
        { id: 2, grp: 1, ref: A, at: 1 },
        { id: 3, grp: 2, ref: B, at: 1 },
      ]);
      const rows = await refs.aggregate({
        filter: {},
        controls: {
          $groupBy: ["grp"],
          $select: [
            "grp",
            { $fn: "first", $field: "ref", $as: "firstRef" },
            { $fn: "last", $field: "ref", $as: "lastRef" },
          ],
          $rowOrder: { at: 1 },
          $sort: { grp: 1 },
        },
      });
      expect(rows).toEqual([
        { grp: 1, firstRef: A, lastRef: B },
        { grp: 2, firstRef: B, lastRef: B },
      ]);
    });
  });

  describe("first / last over a native array column", () => {
    it("picks a real array (not the 2-D ARRAY_AGG slice), skipping NULL and empty arrays", async () => {
      const arrays = space.getTable(fx.AeArray) as any;
      // the adapter's write path JSON-encodes arrays, so populate the way an external writer does
      await driver.run(
        `INSERT INTO "ae_arrays" ("id", "grp", "tags", "flags", "at") VALUES
         (1, 1, ARRAY['b','c'], ARRAY[true,false], 2),
         (2, 1, ARRAY['a'], ARRAY[false], 1),
         (3, 1, NULL, NULL, 3),
         (4, 1, '{}', '{}', 4),
         (5, 2, ARRAY['z'], ARRAY[true], 1)`,
      );
      const rows = await arrays.aggregate({
        filter: {},
        controls: {
          $groupBy: ["grp"],
          $select: [
            "grp",
            { $fn: "first", $field: "tags", $as: "tag" },
            { $fn: "first", $field: "flags", $as: "flag" },
          ],
          $rowOrder: { at: 1 },
          $sort: { grp: 1 },
        },
      });
      // the row-ordered first row's array; the NULL and empty rows of the group must not break the pick
      expect(rows).toEqual([
        { grp: 1, tag: ["a"], flag: [false] },
        { grp: 2, tag: ["z"], flag: [true] },
      ]);
    });
  });

  describe("overflow", () => {
    it("a double overflow in a row-level expression is INVALID_QUERY, not a 500", async () => {
      const error = await (issues() as any)
        .aggregate({
          filter: {},
          controls: {
            $groupBy: ["ticketId"],
            $select: ["ticketId", { $fn: "sum", $expr: overflow(), $as: "x" }],
          },
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe("INVALID_QUERY");
      expect((error as DbError).errors).toEqual([
        { path: "$select", message: "Arithmetic overflow" },
      ]);
    });

    it("so is a $count over the same expression's HAVING", async () => {
      const error = await (issues() as any)
        .aggregate({
          filter: {},
          controls: {
            $groupBy: ["ticketId"],
            $select: ["ticketId", { $fn: "sum", $expr: overflow(), $as: "x" }],
            $having: { x: { $gt: 0 } },
            $count: true,
          },
        })
        .catch((e: unknown) => e);
      expect((error as DbError).code).toBe("INVALID_QUERY");
    });
  });
});
