import { describe, it, expect } from "vite-plus/test";
import { DbError, UniquSelect, type DbControls } from "@atscript/db";

import { buildAggregateCount, buildAggregateSelect } from "../agg";
import { renderArith } from "../arith";
import { orderKeySql, type SqlDialect, type TSqlFragment } from "../dialect";

/**
 * Query-time arithmetic and first / last SQL (since 0.1.148): exact text per
 * dialect — casts, NULLIF, HAVING over the rendered expression, the
 * FIRST_VALUE derived table (reversed order for `last`, NULLS handling on
 * PostgreSQL, bucket partitions), the count query.
 */

const base: SqlDialect = {
  quoteIdentifier: (n) => `"${n}"`,
  quoteTable: (n) => `"${n}"`,
  unlimitedLimit: "-1",
  toValue: (v) => v as never,
  toParam: (v) => v as never,
  regex: (col, v) => ({ sql: `${col} LIKE ?`, params: [String(v)] }),
  createViewPrefix: "CREATE VIEW",
};
const sqlite: SqlDialect = { ...base, castDouble: (e) => `CAST(${e} AS REAL)` };
const mysql: SqlDialect = {
  ...base,
  quoteIdentifier: (n) => `\`${n}\``,
  quoteTable: (n) => `\`${n}\``,
  bucketAliasInHaving: true,
  castDouble: (e) => `CAST(${e} AS DOUBLE)`,
};
const pg: SqlDialect = {
  ...base,
  castDouble: (e) => `CAST(${e} AS DOUBLE PRECISION)`,
  nullsSortLargest: true,
};

const where: TSqlFragment = { sql: "status = ?", params: ["open"] };

const E = {
  mul: (a: unknown, b: unknown) => ({ op: "*", args: [a, b] }),
  div: (a: unknown, b: unknown) => ({ op: "/", args: [a, b] }),
  add: (a: unknown, b: unknown) => ({ op: "+", args: [a, b] }),
  f: (field: string) => ({ field }),
};

function controls(
  select: unknown[],
  computed: ConstructorParameters<typeof UniquSelect>[3],
  extra: Partial<DbControls> = {},
  buckets?: ConstructorParameters<typeof UniquSelect>[2],
): DbControls {
  return {
    $groupBy: ["ticket_id"],
    $select: new UniquSelect(select as never, undefined, buckets, computed),
    ...extra,
  } as DbControls;
}

describe("renderArith", () => {
  it("casts literals and leaves, NULLIFs the divisor, negates and coalesces", () => {
    const node = {
      op: "coalesce",
      args: [{ op: "/", args: [{ field: "a" }, 2] }, { op: "neg", args: [{ field: "b" }] }, 0],
    } as never;
    expect(renderArith(sqlite, node, (f) => `"${f}"`)).toBe(
      'COALESCE((CAST("a" AS REAL) / NULLIF(CAST(2 AS REAL), 0)), (-CAST("b" AS REAL)), CAST(0 AS REAL))',
    );
  });

  it("a leaf that already is a double is left as it is", () => {
    const node = { op: "+", args: [{ field: "a" }, { field: "b" }] } as never;
    expect(renderArith(sqlite, node, (f) => (f === "a" ? { double: "(x * 2)" } : `"${f}"`))).toBe(
      '((x * 2) + CAST("b" AS REAL))',
    );
  });

  it("a dialect without castDouble is AGG_EXPR_NOT_SUPPORTED", () => {
    expect(() => renderArith(base, 1, () => "x")).toThrow(DbError);
    try {
      renderArith(base, 1, () => "x");
    } catch (e) {
      expect((e as DbError).code).toBe("AGG_EXPR_NOT_SUPPORTED");
    }
  });

  it("a non-finite literal is INVALID_QUERY", () => {
    try {
      renderArith(sqlite, Number.POSITIVE_INFINITY, () => "x");
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as DbError).code).toBe("INVALID_QUERY");
    }
  });

  it("orderKeySql adds NULLS FIRST / LAST only where NULL sorts largest", () => {
    expect(orderKeySql(sqlite, '"x"', false)).toBe('"x" ASC');
    expect(orderKeySql(pg, '"x"', false)).toBe('"x" ASC NULLS FIRST');
    expect(orderKeySql(pg, '"x"', true)).toBe('"x" DESC NULLS LAST');
  });
});

describe("row-level expression aggregates", () => {
  const select = ["ticket_id"];
  const computed = {
    exprAggregates: [
      {
        fn: "sum" as const,
        alias: "revenue",
        expr: E.mul(E.f("price"), E.f("qty")) as never,
        names: ["price", "qty"],
      },
    ],
  };

  it.each([
    ["sqlite", sqlite, "REAL"],
    ["mysql", mysql, "DOUBLE"],
    ["postgres", pg, "DOUBLE PRECISION"],
  ])("%s: SUM over a double-cast product", (_name, d, type) => {
    const q = (n: string) => d.quoteIdentifier(n);
    const r = buildAggregateSelect(d, "issues", where, controls(select, computed));
    expect(r.sql).toBe(
      `SELECT ${q("ticket_id")}, SUM((CAST(${q("price")} AS ${type}) * CAST(${q("qty")} AS ${type}))) AS ${q("revenue")} ` +
        `FROM ${q("issues")} WHERE status = ? GROUP BY ${q("ticket_id")}`,
    );
    expect(r.params).toEqual(["open"]);
  });

  it("avg / min / max keep their function", () => {
    const r = buildAggregateSelect(
      sqlite,
      "issues",
      where,
      controls(select, {
        exprAggregates: [
          { fn: "avg", alias: "a", expr: E.f("price") as never, names: ["price"] },
          { fn: "min", alias: "m", expr: E.f("price") as never, names: ["price"] },
        ],
      }),
    );
    expect(r.sql).toContain('AVG(CAST("price" AS REAL)) AS "a", MIN(CAST("price" AS REAL)) AS "m"');
  });
});

describe("group-level expressions", () => {
  const select = [
    "ticket_id",
    { $fn: "count", $field: "*", $as: "open" },
    { $fn: "sum", $field: "estimate", $as: "est" },
  ];
  const computed = {
    exprs: [
      { alias: "avgEst", expr: E.div(E.f("est"), E.f("open")) as never, names: ["est", "open"] },
      {
        alias: "rank",
        expr: E.add(E.mul(E.f("avgEst"), 10), E.f("ticket_id")) as never,
        names: ["avgEst", "ticket_id"],
      },
    ],
  };
  const avgSql = '(CAST(SUM("estimate") AS REAL) / NULLIF(CAST(COUNT(*) AS REAL), 0))';

  it("renders each expression over the aggregate calls, in dependency order", () => {
    const r = buildAggregateSelect(sqlite, "issues", where, controls(select, computed));
    expect(r.sql).toBe(
      `SELECT "ticket_id", COUNT(*) AS "open", SUM("estimate") AS "est", ${avgSql} AS "avgEst", ` +
        `((CAST(${avgSql} AS REAL) * CAST(10 AS REAL)) + CAST("ticket_id" AS REAL)) AS "rank" ` +
        'FROM "issues" WHERE status = ? GROUP BY "ticket_id"',
    );
  });

  it("HAVING renders the expression itself (never the alias) on every dialect", () => {
    for (const d of [sqlite, mysql, pg]) {
      const q = (n: string) => d.quoteIdentifier(n);
      const r = buildAggregateSelect(
        d,
        "issues",
        where,
        controls(select, computed, { $having: { avgEst: { $gte: 2 } }, $sort: { avgEst: -1 } }),
      );
      expect(r.sql).toContain(
        ` HAVING (CAST(SUM(${q("estimate")}) AS ${(d.castDouble!("x").match(/AS (.+)\)$/) ?? [])[1]}) / NULLIF(`,
      );
      expect(r.sql).not.toContain(`HAVING ${q("avgEst")}`);
      expect(r.sql).toContain(`ORDER BY ${q("avgEst")} DESC`);
      expect(r.params).toEqual(["open", 2]);
    }
  });

  it("the count query applies the same HAVING", () => {
    const r = buildAggregateCount(
      sqlite,
      "issues",
      where,
      controls(select, computed, { $having: { avgEst: { $gte: 2 } } }),
    );
    expect(r.sql).toBe(
      `SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "issues" WHERE status = ? GROUP BY "ticket_id" HAVING ${avgSql} >= ?) AS "_groups"`,
    );
    expect(r.params).toEqual(["open", 2]);
  });
});

describe("first / last", () => {
  const select = [
    "ticket_id",
    { $fn: "count", $field: "*", $as: "open" },
    { $fn: "first", $field: "raised_at", $as: "oldestAt" },
    { $fn: "first", $field: "id", $as: "oldestId" },
    { $fn: "last", $field: "raised_at", $as: "newestAt" },
  ];
  const computed = {
    rowOrder: [
      { column: "raised_at", desc: false },
      { column: "id", desc: false },
    ],
  };

  it("sqlite: a FIRST_VALUE derived table with only the columns read, `last` over the reversed order, derived columns aggregated", () => {
    const r = buildAggregateSelect(sqlite, "issues", where, controls(select, computed));
    expect(r.sql).toBe(
      'SELECT "ticket_id", COUNT(*) AS "open", MIN("__as_fl0") AS "oldestAt", MIN("__as_fl1") AS "oldestId", MIN("__as_fl2") AS "newestAt" ' +
        'FROM (SELECT "ticket_id", ' +
        'FIRST_VALUE("raised_at") OVER (PARTITION BY "ticket_id" ORDER BY "raised_at" ASC, "id" ASC) AS "__as_fl0", ' +
        'FIRST_VALUE("id") OVER (PARTITION BY "ticket_id" ORDER BY "raised_at" ASC, "id" ASC) AS "__as_fl1", ' +
        'FIRST_VALUE("raised_at") OVER (PARTITION BY "ticket_id" ORDER BY "raised_at" DESC, "id" DESC) AS "__as_fl2" ' +
        'FROM "issues" WHERE status = ?) AS "__as_rows" ' +
        'GROUP BY "ticket_id"',
    );
    expect(r.params).toEqual(["open"]);
  });

  it("the derived table projects what the outer query reads: group keys, plain fields, aggregate fields, expression leaves", () => {
    const r = buildAggregateSelect(
      sqlite,
      "issues",
      where,
      controls(
        [
          "ticket_id",
          { $fn: "sum", $field: "estimate", $as: "est" },
          { $fn: "first", $field: "raised_at", $as: "oldestAt" },
        ],
        {
          ...computed,
          exprAggregates: [
            {
              fn: "sum",
              alias: "rev",
              expr: E.mul(E.f("price"), E.f("qty")) as never,
              names: ["price", "qty"],
            },
          ],
        },
      ),
    );
    expect(r.sql).toContain('FROM (SELECT "ticket_id", "estimate", "price", "qty", FIRST_VALUE(');
    // the $rowOrder columns and the first / last source stay inside the window
    expect(r.sql).not.toContain('SELECT "ticket_id", "estimate", "price", "qty", "raised_at"');
    expect(r.sql).not.toContain(".*");
  });

  it("postgres: a first / last aggregates through the type-agnostic pick, a min / max of a boolean with BOOL_AND / BOOL_OR", () => {
    const flag = { designType: "boolean" } as never;
    const sources = new Map([["flag", flag]]);
    const r = buildAggregateSelect(
      {
        ...pg,
        booleanAggregates: { min: "BOOL_AND", max: "BOOL_OR" },
        anyValue: (x: string) => `(ARRAY_AGG(${x}))[1]`,
      },
      "issues",
      where,
      controls(
        [
          "ticket_id",
          { $fn: "first", $field: "flag", $as: "f" },
          { $fn: "min", $field: "flag", $as: "lo" },
          { $fn: "max", $field: "flag", $as: "hi" },
          { $fn: "max", $field: "title", $as: "t" },
        ],
        { ...computed, sources },
      ),
    );
    expect(r.sql).toContain(
      'BOOL_AND("flag") AS "lo", BOOL_OR("flag") AS "hi", MAX("title") AS "t", (ARRAY_AGG("__as_fl0"))[1] AS "f"',
    );
  });

  it("an ungrouped query without a window column renders no GROUP BY (one row over no input)", () => {
    const r = buildAggregateSelect(
      sqlite,
      "issues",
      where,
      controls(select.slice(1, 3), computed, { $groupBy: [] }),
    );
    expect(r.sql).not.toContain("GROUP BY");
  });

  it("postgres: NULL is the smallest value — NULLS FIRST ascending, NULLS LAST descending", () => {
    const r = buildAggregateSelect(
      pg,
      "issues",
      { sql: "status = ?", params: ["open"] },
      controls(select, computed),
    );
    expect(r.sql).toContain(
      'FIRST_VALUE("raised_at") OVER (PARTITION BY "ticket_id" ORDER BY "raised_at" ASC NULLS FIRST, "id" ASC NULLS FIRST) AS "__as_fl0"',
    );
    expect(r.sql).toContain(
      'FIRST_VALUE("raised_at") OVER (PARTITION BY "ticket_id" ORDER BY "raised_at" DESC NULLS LAST, "id" DESC NULLS LAST) AS "__as_fl2"',
    );
  });

  it("mysql: backtick quoting", () => {
    const r = buildAggregateSelect(mysql, "issues", where, controls(select, computed));
    expect(r.sql).toContain(
      "FROM (SELECT `ticket_id`, FIRST_VALUE(`raised_at`) OVER (PARTITION BY `ticket_id` ORDER BY `raised_at` ASC, `id` ASC)",
    );
  });

  it("a descending $rowOrder key flips for first and for last", () => {
    const r = buildAggregateSelect(
      sqlite,
      "issues",
      where,
      controls(select.slice(0, 3), { rowOrder: [{ column: "raised_at", desc: true }] }),
    );
    expect(r.sql).toContain('ORDER BY "raised_at" DESC) AS "__as_fl0"');
  });

  it("partitions by the bucket expression of a bucket group key", () => {
    const bucketDialect: SqlDialect = {
      ...sqlite,
      calendarBucket: (col, b) => `bucket(${col},${b.unit})`,
    };
    const r = buildAggregateSelect(
      bucketDialect,
      "issues",
      where,
      controls(
        ["day", { $bucket: "day", $field: "raised_at", $as: "day" }, select[2]],
        computed,
        { $groupBy: ["day"] },
        [
          {
            alias: "day",
            field: "raised_at",
            unit: "day",
            tz: "UTC",
            weekStart: "mon",
            weekStartIso: 1,
            fd: {} as never,
          },
        ],
      ),
    );
    expect(r.sql).toContain('PARTITION BY bucket("raised_at",day) ORDER BY');
    expect(r.sql).toMatch(/GROUP BY bucket\("raised_at",day\)$/);
  });

  it("without a $groupBy the single partition has no PARTITION BY", () => {
    const r = buildAggregateSelect(
      sqlite,
      "issues",
      where,
      controls(select.slice(1, 3), computed, { $groupBy: [] }),
    );
    expect(r.sql).toContain('FIRST_VALUE("raised_at") OVER (ORDER BY "raised_at" ASC, "id" ASC)');
  });

  it("an expression can read a first alias, and HAVING reads the derived column", () => {
    const r = buildAggregateSelect(
      sqlite,
      "issues",
      where,
      controls(
        select.slice(0, 4),
        {
          ...computed,
          exprs: [{ alias: "age", expr: E.add(E.f("oldestId"), 1) as never, names: ["oldestId"] }],
        },
        { $having: { age: { $gt: 3 }, oldestId: { $lt: 9 } } },
      ),
    );
    expect(r.sql).toContain('(CAST(MIN("__as_fl1") AS REAL) + CAST(1 AS REAL)) AS "age"');
    expect(r.sql).toContain(
      'HAVING (CAST(MIN("__as_fl1") AS REAL) + CAST(1 AS REAL)) > ? AND MIN("__as_fl1") < ?',
    );
  });

  it("the count query reads the derived table only when a HAVING reads a first / last value", () => {
    const r = buildAggregateCount(
      sqlite,
      "issues",
      where,
      controls(select.slice(0, 3), computed, { $having: { oldestAt: { $gt: 5 } } }),
    );
    expect(r.sql).toBe(
      'SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM (SELECT "ticket_id", ' +
        'FIRST_VALUE("raised_at") OVER (PARTITION BY "ticket_id" ORDER BY "raised_at" ASC, "id" ASC) AS "__as_fl0" ' +
        'FROM "issues" WHERE status = ?) AS "__as_rows" GROUP BY "ticket_id" HAVING MIN("__as_fl0") > ?) AS "_groups"',
    );
    expect(r.params).toEqual(["open", 5]);
  });

  it("the count query reads the plain table when no HAVING reads one (X1)", () => {
    const plain = buildAggregateCount(
      sqlite,
      "issues",
      where,
      controls(select.slice(0, 3), computed),
    );
    expect(plain.sql).toBe(
      'SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "issues" WHERE status = ? GROUP BY "ticket_id") AS "_groups"',
    );
    const other = buildAggregateCount(
      sqlite,
      "issues",
      where,
      controls(select.slice(0, 3), computed, { $having: { open: { $gt: 1 } } }),
    );
    expect(other.sql).toBe(
      'SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "issues" WHERE status = ? GROUP BY "ticket_id" HAVING COUNT(*) > ?) AS "_groups"',
    );
  });

  it("the count query reads the derived table for an expression over a first / last alias", () => {
    const r = buildAggregateCount(
      sqlite,
      "issues",
      where,
      controls(
        select.slice(0, 4),
        {
          ...computed,
          exprs: [{ alias: "age", expr: E.add(E.f("oldestId"), 1) as never, names: ["oldestId"] }],
        },
        { $having: { age: { $gt: 3 } } },
      ),
    );
    expect(r.sql).toContain('FROM (SELECT "ticket_id", FIRST_VALUE(');
  });
});
