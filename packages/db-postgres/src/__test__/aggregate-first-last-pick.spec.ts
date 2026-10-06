import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { pgAnyValue } from "../sql-builder";
import { PostgresAdapter } from "../postgres-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

// The pick a `first` / `last` derived column aggregates through: streaming MIN
// (BOOL_AND for a boolean) for ordered types; `(ARRAY_AGG(x))[1]` only for a
// physical type without MIN. Live uuid coverage: aggregate-expr.live.spec.ts.

let fx: any;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/agg-expr.as");
});

async function pickSql(model: unknown, field: string, group: string): Promise<string> {
  const driver = createMockDriver({ allResult: [] });
  const table = new AtscriptDbTable(model as any, new PostgresAdapter(driver));
  await table.aggregate({
    filter: {},
    controls: {
      $groupBy: [group],
      $select: [{ $fn: "first", $field: field, $as: "pick" }] as any,
      $rowOrder: { id: 1 },
    } as any,
  });
  return driver.calls[0]!.sql;
}

describe("PostgreSQL first / last pick", () => {
  it("number, text, decimal and timestamp columns pick through a streaming MIN", async () => {
    for (const field of ["price", "title", "status", "cost", "raisedAt"]) {
      const sql = await pickSql(fx.AeIssue, field, "ticketId");
      expect(sql, field).toContain('MIN("__as_fl0") AS "pick"');
      expect(sql, field).not.toContain("ARRAY_AGG");
    }
  });

  it("a boolean picks through BOOL_AND", async () => {
    expect(await pickSql(fx.AeIssue, "flag", "ticketId")).toContain(
      'BOOL_AND("__as_fl0") AS "pick"',
    );
  });

  it("a uuid (@db.pg.type) has no MIN: the type-agnostic pick", async () => {
    expect(await pickSql(fx.AeRef, "ref", "grp")).toContain('(ARRAY_AGG("__as_fl0"))[1] AS "pick"');
  });

  it("pgAnyValue by physical type: MIN-able types stream, the rest fall back", () => {
    const f = (designType: string, pgType?: string, extra: object = {}) =>
      ({
        designType,
        type: {
          type: { tags: new Set() },
          metadata: new Map(pgType ? [["db.pg.type", pgType]] : []),
        },
        ...extra,
      }) as never;
    expect(pgAnyValue("x", f("string", "TEXT"))).toBe("MIN(x)");
    expect(pgAnyValue("x", f("string", "VARCHAR(20)"))).toBe("MIN(x)");
    expect(pgAnyValue("x", f("number", "NUMERIC(10,2)"))).toBe("MIN(x)");
    expect(pgAnyValue("x", f("string", "TIMESTAMP WITH TIME ZONE"))).toBe("MIN(x)");
    for (const type of ["UUID", "BYTEA", "JSONB", "POINT", "CITEXT", "INET6"]) {
      expect(pgAnyValue("x", f("string", type)), type).toBe("(ARRAY_AGG(x))[1]");
    }
    // an array column picks through MIN(anyarray): ARRAY_AGG over arrays builds a 2-D array
    // (`[1]` is NULL) and rejects NULL / empty arrays; an array of booleans has no BOOL_AND (42883)
    for (const type of ["TEXT[]", "boolean[]", "bool[]", "BOOLEAN[]", "integer[]", "UUID[]"]) {
      expect(pgAnyValue("x", f("array", type)), type).toBe("MIN(x)");
    }
    expect(pgAnyValue("x", f("boolean", "BOOL"))).toBe("BOOL_AND(x)");
    expect(pgAnyValue("x", undefined)).toBe("(ARRAY_AGG(x))[1]");
  });
});
