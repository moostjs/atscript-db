import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { mysqlDialect, mysqlStringLiteral } from "../sql-builder";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise. Override with `ATSCRIPT_MYSQL_TEST_URL` (an admin connection —
// the spec creates and drops its own database).
//
// String literals inlined into MySQL SQL (since 0.1.162) escape backslashes:
// MySQL reads `\` as an escape in a string literal, so a view filter value
// `a\\b` rendered as `'a\\b'` matched `a\b` instead. JSON path literals
// go through the same MySQL literal; a key with `\` or `"` is refused.

const DB = "escape_literals";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;

describe.skipIf(!reachable)("[mysql live] string literals with backslashes", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/escape-literals.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
    const result = await new SchemaSync(space).run([fx.EscItem, fx.EscBackslash], {
      force: true,
    });
    expect(result.status).toBe("synced");
    const filter = fx.EscBackslash.metadata.get("db.view.filter") as { right: string };
    const codes = [filter.right, filter.right.replace(/\\\\/g, "\\"), "ab", "a\\\\\\b"];
    await space.getTable(fx.EscItem).insertMany(
      codes.map((code, i) => ({
        id: i + 1,
        code,
        attrs: { "it's": `v${i + 1}`, plain: "p" },
      })) as never,
    );
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  it("a view filter value with a backslash matches exactly that value", async () => {
    const filter = fx.EscBackslash.metadata.get("db.view.filter") as { right: string };
    expect(filter.right).toContain("\\");
    const rows = await space.getView(fx.EscBackslash).findMany({ filter: {} } as never);
    expect(rows.map((r: any) => r.code)).toEqual([filter.right]);
  });

  it("JSON paths: a key with a quote reads its leaf; a backslash key is refused before any SQL", async () => {
    const doc = mysqlStringLiteral(JSON.stringify({ "it's": "a\\b", plain: "p" }));
    const expr = mysqlDialect.jsonExtract!(`CAST(${doc} AS JSON)`, ["it's"], "string");
    const [row] = await driver.all<{ v: string }>(`SELECT ${expr} AS v`);
    expect(row!.v).toBe("a\\b");
    expect(() => mysqlDialect.jsonExtract!("`attrs`", ["a\\b"], "string")).toThrow(
      /can't be extracted/,
    );
  });

  it("a forced re-sync keeps the view (its definition converged)", async () => {
    const plan = await new SchemaSync(space).plan([fx.EscItem, fx.EscBackslash], { force: true });
    expect(plan.entries.filter((e) => e.status !== "in-sync").map((e) => e.name)).toEqual([]);
  });
});
