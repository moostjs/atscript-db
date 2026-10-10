import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { AE_ROWS, defineAggregateExprCases } from "../../../db/test-kit/aggregate-expr-cases";
import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

// Live DDL against a real server is slow under the parallel workspace run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL when one is reachable, skips
// otherwise (CI has no server). Override the server with
// `ATSCRIPT_MYSQL_TEST_URL` (no database in the URL — the spec creates and
// drops its own `aggexpr_live` database).
//
// Query-time arithmetic and first / last (since 0.1.148): the shared case table
// every adapter runs, plus what only a real server shows — the window derived
// table and the overflow mapping.

const DB = "aggexpr_live";

const reachable = await mysqlReachable();

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
let driver: Mysql2Driver;
let space: DbSpace;

const issues = () => space.getTable(fx.AeIssue) as never;

describe.skipIf(!reachable)("[mysql live] aggregate arithmetic and first / last", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/agg-expr.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver));
    const result = await syncSchema(space, [fx.AeIssue]);
    expect(result.status).toBe("synced");
    await (issues() as any).insertMany(AE_ROWS);
  });

  afterAll(async () => {
    await driver?.close();
    await dropMysqlDatabase(DB);
  });

  defineAggregateExprCases("MySQL", issues);

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
