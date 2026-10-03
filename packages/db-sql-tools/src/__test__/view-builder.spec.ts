import { describe, it, expect } from "vite-plus/test";
import type { TViewColumnMapping } from "@atscript/db";

import type { SqlDialect } from "../dialect";
import { quotedJsonPathSegments } from "../dialect";
import { jsonDollarPath } from "../common";
import { viewSourceExpr } from "../view-builder";

// JSON-leaf view columns (since 0.1.136): viewSourceExpr routes `mapping.json`
// to the dialect's jsonExtract; path segments are always quoted.

const base: SqlDialect = {
  quoteIdentifier: (name) => `[${name}]`,
  quoteTable: (name) => `[${name}]`,
  unlimitedLimit: "-1",
  toValue: (v) => v,
  toParam: (v) => v,
  regex: () => ({ sql: "", params: [] }),
  createViewPrefix: "CREATE VIEW",
};

const leaf: TViewColumnMapping = {
  viewColumn: "tag",
  viewPath: "tag",
  sourceTable: "items",
  sourceColumn: "data",
  json: { path: ["nested", "tag"], type: "string" },
};

describe("viewSourceExpr — JSON leaves", () => {
  it("renders a plain column as table.column", () => {
    expect(viewSourceExpr(base, { ...leaf, json: undefined })).toBe("[items].[data]");
  });

  it("hands the quoted column, path and type to dialect.jsonExtract", () => {
    const calls: unknown[] = [];
    const dialect: SqlDialect = {
      ...base,
      jsonExtract: (col, path, type) => {
        calls.push([col, path, type]);
        return `X(${col})`;
      },
    };
    expect(viewSourceExpr(dialect, leaf)).toBe("X([items].[data])");
    expect(calls).toEqual([["[items].[data]", ["nested", "tag"], "string"]]);
  });

  it("throws when the dialect has no jsonExtract", () => {
    expect(() => viewSourceExpr(base, leaf)).toThrow(
      'View column "tag": JSON extraction is not supported by this adapter',
    );
  });
});

describe("quotedJsonPathSegments", () => {
  it("double-quotes every segment, keeping dots, commas and single quotes", () => {
    expect(quotedJsonPathSegments(["a", "b.c", "1", "x,y", "it's"])).toEqual([
      '"a"',
      '"b.c"',
      '"1"',
      '"x,y"',
      `"it's"`,
    ]);
  });

  it.each([['a"b'], ["a\\b"], ["a\nb"], [""]])("rejects %j", (seg) => {
    expect(() => quotedJsonPathSegments([seg])).toThrow(/JSON path segment .* can't be extracted/);
  });

  it("rejects an empty path", () => {
    expect(() => quotedJsonPathSegments([])).toThrow("needs a path below the JSON column");
  });
});

describe("jsonDollarPath", () => {
  it("renders a $-rooted SQL literal with quoted segments and escaped single quotes", () => {
    expect(jsonDollarPath(["1", "a.b", "it's"])).toBe(`'$."1"."a.b"."it''s"'`);
  });
});

// ── buildCreateView — view sources and join aliases (since 0.1.141) ──────

import type { TViewPlan } from "@atscript/db";
import { buildCreateView } from "../view-builder";

const ref = (table: string, field: string, type = { id: table }) => ({
  type: () => type as never,
  field,
});
const eq = (l: ReturnType<typeof ref>, r: ReturnType<typeof ref>) => ({
  left: l,
  op: "$eq",
  right: r,
});
const resolve = (r: { type?: () => { id: string }; field: string }) =>
  `[${r.type ? r.type().id : "entry"}].[${r.field}]`;
const col = (name: string, sourceTable: string, sourceColumn = name): TViewColumnMapping => ({
  viewColumn: name,
  viewPath: name,
  sourceTable,
  sourceColumn,
});

describe("buildCreateView — view sources and join aliases", () => {
  it("renders a plain join exactly as before (no AS)", () => {
    const plan: TViewPlan = {
      entryType: () => ({}) as never,
      entryTable: "orders",
      joins: [
        {
          targetType: () => ({}) as never,
          targetTable: "customers",
          scope: "customers",
          condition: eq(ref("customers", "id"), ref("orders", "customerId")) as never,
          kind: "left",
        },
      ],
      materialized: false,
    };
    expect(
      buildCreateView(
        base,
        "v",
        plan,
        [col("id", "orders"), col("name", "customers")],
        resolve as never,
      ),
    ).toBe(
      "CREATE VIEW [v] AS SELECT [orders].[id] AS [id], [customers].[name] AS [name] FROM [orders] LEFT JOIN [customers] ON [customers].[id] = [orders].[customerId]",
    );
  });

  it("selects FROM a view and joins a view like any table", () => {
    const plan: TViewPlan = {
      entryType: () => ({}) as never,
      entryTable: "people_view",
      joins: [
        {
          targetType: () => ({}) as never,
          targetTable: "city_counts_view",
          scope: "city_counts_view",
          condition: eq(ref("city_counts_view", "city"), ref("people_view", "city")) as never,
          kind: "inner",
        },
      ],
      filter: { left: ref("people_view", "city"), op: "$ne", right: "Nowhere" } as never,
      materialized: false,
    };
    expect(
      buildCreateView(
        base,
        "v",
        plan,
        [col("id", "people_view"), col("people", "city_counts_view")],
        resolve as never,
      ),
    ).toBe(
      "CREATE VIEW [v] AS SELECT [people_view].[id] AS [id], [city_counts_view].[people] AS [people] FROM [people_view] JOIN [city_counts_view] ON [city_counts_view].[city] = [people_view].[city] WHERE [people_view].[city] != 'Nowhere'",
    );
  });

  it("renders an aliased join as `JOIN table AS Alias` and addresses it by the alias (self-join)", () => {
    const plan: TViewPlan = {
      entryType: () => ({}) as never,
      entryTable: "employees",
      joins: [
        {
          targetType: () => ({}) as never,
          targetTable: "employees",
          scope: "Manager",
          condition: eq(ref("Manager", "id"), ref("employees", "managerId")) as never,
          kind: "left",
        },
        {
          targetType: () => ({}) as never,
          targetTable: "employees",
          scope: "Mentor",
          condition: eq(ref("Mentor", "id"), ref("employees", "mentorId")) as never,
          kind: "left",
        },
      ],
      filter: { left: ref("Manager", "city"), op: "$eq", right: "Paris" } as never,
      materialized: false,
    };
    const columns = [
      col("id", "employees"),
      col("managerName", "Manager", "full_name"),
      col("mentorName", "Mentor", "full_name"),
    ];
    expect(buildCreateView(base, "staff", plan, columns, resolve as never)).toBe(
      "CREATE VIEW [staff] AS SELECT [employees].[id] AS [id], [Manager].[full_name] AS [managerName], [Mentor].[full_name] AS [mentorName] " +
        "FROM [employees] LEFT JOIN [employees] AS [Manager] ON [Manager].[id] = [employees].[managerId] " +
        "LEFT JOIN [employees] AS [Mentor] ON [Mentor].[id] = [employees].[mentorId] WHERE [Manager].[city] = 'Paris'",
    );
  });

  it("groups by an aliased dimension", () => {
    const plan: TViewPlan = {
      entryType: () => ({}) as never,
      entryTable: "employees",
      joins: [
        {
          targetType: () => ({}) as never,
          targetTable: "employees",
          scope: "Manager",
          condition: eq(ref("Manager", "id"), ref("employees", "managerId")) as never,
          kind: "inner",
        },
      ],
      materialized: false,
    };
    const columns: TViewColumnMapping[] = [
      col("managerName", "Manager", "full_name"),
      { ...col("reports", "employees", "id"), aggFn: "count", aggField: "id" },
    ];
    expect(buildCreateView(base, "spans", plan, columns, resolve as never)).toBe(
      "CREATE VIEW [spans] AS SELECT [Manager].[full_name] AS [managerName], COUNT([employees].[id]) AS [reports] " +
        "FROM [employees] JOIN [employees] AS [Manager] ON [Manager].[id] = [employees].[managerId] GROUP BY [Manager].[full_name]",
    );
  });
});

// Computed columns and first-row joins (since 0.1.147).
describe("buildCreateView — computed columns and first-row joins", () => {
  const dq = (n: string) => `"${n}"`;
  const sqlite: SqlDialect = {
    ...base,
    quoteIdentifier: dq,
    quoteTable: dq,
    castDouble: (e) => `CAST(${e} AS REAL)`,
  };
  const mysql: SqlDialect = {
    ...base,
    quoteIdentifier: (n) => `\`${n}\``,
    quoteTable: (n) => `\`${n}\``,
    bucketAliasInHaving: true,
    castDouble: (e) => `CAST(${e} AS DOUBLE)`,
  };
  const pg: SqlDialect = {
    ...base,
    quoteIdentifier: dq,
    quoteTable: dq,
    castDouble: (e) => `CAST(${e} AS DOUBLE PRECISION)`,
    nullsSortLargest: true,
  };

  /** A type getter whose `id` is the scope name, like a compiled `@db.alias` type. */
  const typeOf = (id: string) => () => ({ id }) as any;
  /** `Scope.field` → quoted `scope.column` (camelCase → snake_case, entry for unqualified). */
  const resolverFor =
    (d: SqlDialect) =>
    (ref: { type?: () => { id?: string }; field: string }): string =>
      `${d.quoteIdentifier(ref.type?.().id ?? "tickets")}.${d.quoteIdentifier(
        ref.field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      )}`;

  const col = (viewPath: string, extra: Partial<TViewColumnMapping>): TViewColumnMapping => ({
    viewColumn: viewPath,
    viewPath,
    sourceTable: "tickets",
    sourceColumn: viewPath,
    ...extra,
  });

  const grouped: TViewColumnMapping[] = [
    col("id", {}),
    col("openCount", { sourceTable: "Issue", sourceColumn: "id", aggFn: "count", aggField: "id" }),
    col("estimate", {
      sourceTable: "Issue",
      sourceColumn: "estimate",
      aggFn: "sum",
      aggField: "estimate",
    }),
    col("rank", {
      sourceColumn: "",
      expr: { op: "+", args: [{ op: "*", args: [{ field: "openCount" }, 10] }, { field: "id" }] },
    }),
    col("avg", {
      sourceColumn: "",
      expr: { op: "/", args: [{ field: "estimate" }, { field: "openCount" }] },
    }),
    col("score", {
      sourceColumn: "",
      expr: {
        op: "coalesce",
        args: [{ op: "neg", args: [{ op: "-", args: [{ field: "rank" }, -1] }] }, 0],
      },
    }),
  ];
  const plan = (extra: Partial<TViewPlan> = {}): TViewPlan => ({
    entryType: typeOf("tickets"),
    entryTable: "tickets",
    joins: [
      {
        targetType: typeOf("Issue"),
        targetTable: "issues",
        scope: "Issue",
        condition: {
          left: { type: typeOf("Issue"), field: "ticketId" },
          op: "$eq",
          right: { field: "id" },
        },
        kind: "left",
      },
    ],
    materialized: false,
    ...extra,
  });

  it("renders computed columns in double with NULLIF, parens and coalesce; keeps them out of GROUP BY", () => {
    expect(buildCreateView(sqlite, "q", plan(), grouped, resolverFor(sqlite))).toBe(
      'CREATE VIEW "q" AS SELECT "tickets"."id" AS "id", COUNT("Issue"."id") AS "openCount", ' +
        'SUM("Issue"."estimate") AS "estimate", ' +
        '((CAST(COUNT("Issue"."id") AS REAL) * CAST(10 AS REAL)) + CAST("tickets"."id" AS REAL)) AS "rank", ' +
        '(CAST(SUM("Issue"."estimate") AS REAL) / NULLIF(CAST(COUNT("Issue"."id") AS REAL), 0)) AS "avg", ' +
        'COALESCE((-(((CAST(COUNT("Issue"."id") AS REAL) * CAST(10 AS REAL)) + CAST("tickets"."id" AS REAL)) - CAST(-1 AS REAL))), CAST(0 AS REAL)) AS "score" ' +
        'FROM "tickets" LEFT JOIN "issues" AS "Issue" ON "Issue"."ticket_id" = "tickets"."id" ' +
        'GROUP BY "tickets"."id"',
    );
  });

  it("HAVING on a computed column: MySQL references the alias, PostgreSQL the expression", () => {
    const having = { left: { field: "rank" }, op: "$gte", right: 10 };
    expect(buildCreateView(mysql, "q", plan({ having }), grouped, resolverFor(mysql))).toContain(
      "GROUP BY `tickets`.`id` HAVING `rank` >= 10",
    );
    expect(buildCreateView(pg, "q", plan({ having }), grouped, resolverFor(pg))).toContain(
      'HAVING ((CAST(COUNT("Issue"."id") AS DOUBLE PRECISION) * CAST(10 AS DOUBLE PRECISION)) + CAST("tickets"."id" AS DOUBLE PRECISION)) >= 10',
    );
  });

  it("a JSON-extracted dimension leaf reads MIN(<extract>) in a grouped view only", () => {
    const json: SqlDialect = { ...sqlite, jsonExtract: (c, path) => `JX(${c},${path.join(".")})` };
    const level = col("level", { sourceColumn: "meta", json: { path: ["level"], type: "number" } });
    const score = col("score", {
      sourceColumn: "",
      expr: { op: "*", args: [{ field: "level" }, 2] },
    });
    const n = col("n", { sourceColumn: "*", aggFn: "count", aggField: "*" });
    const p = plan({ joins: [] });
    expect(buildCreateView(json, "q", p, [level, n, score], resolverFor(json))).toContain(
      '(CAST(MIN(JX("tickets"."meta",level)) AS REAL) * CAST(2 AS REAL)) AS "score"',
    );
    expect(buildCreateView(json, "q", p, [level, score], resolverFor(json))).toContain(
      '(CAST(JX("tickets"."meta",level) AS REAL) * CAST(2 AS REAL)) AS "score"',
    );
  });

  it("throws for a computed column on a dialect without castDouble", () => {
    expect(() =>
      buildCreateView(
        { ...sqlite, castDouble: undefined },
        "q",
        plan(),
        grouped,
        resolverFor(sqlite),
      ),
    ).toThrow('View column "rank": computed view columns are not supported by this adapter');
  });

  const firstRow = () =>
    plan({
      joins: [
        {
          targetType: typeOf("Oldest"),
          targetTable: "issues",
          scope: "Oldest",
          condition: {
            $and: [
              {
                left: { type: typeOf("Oldest"), field: "ticketId" },
                op: "$eq",
                right: { field: "id" },
              },
              { left: { type: typeOf("Oldest"), field: "status" }, op: "$eq", right: "open" },
            ],
          },
          kind: "left",
          first: {
            order: [
              { ref: { type: typeOf("Oldest"), field: "raisedAt" }, desc: false },
              { ref: { type: typeOf("Oldest"), field: "severity" }, desc: true },
              { ref: { type: typeOf("Oldest"), field: "id" }, desc: false },
            ],
            key: "id",
          },
        },
        {
          targetType: typeOf("Reporter"),
          targetTable: "reporters",
          scope: "Reporter",
          condition: {
            left: { type: typeOf("Reporter"), field: "id" },
            op: "$eq",
            right: { type: typeOf("Oldest"), field: "reporterId" },
          },
          kind: "left",
        },
      ],
    });
  const flat = [
    col("id", {}),
    col("oldestTitle", { sourceTable: "Oldest", sourceColumn: "title" }),
  ];

  it("renders a first-row join as a correlated scalar subquery reusing the alias (shadowing)", () => {
    expect(buildCreateView(sqlite, "q", firstRow(), flat, resolverFor(sqlite))).toBe(
      'CREATE VIEW "q" AS SELECT "tickets"."id" AS "id", "Oldest"."title" AS "oldestTitle" FROM "tickets" ' +
        'LEFT JOIN "issues" AS "Oldest" ON "Oldest"."id" = (SELECT "Oldest"."id" FROM "issues" AS "Oldest" ' +
        `WHERE "Oldest"."ticket_id" = "tickets"."id" AND "Oldest"."status" = 'open' ` +
        'ORDER BY "Oldest"."raised_at" ASC, "Oldest"."severity" DESC, "Oldest"."id" ASC LIMIT 1) ' +
        'LEFT JOIN "reporters" AS "Reporter" ON "Reporter"."id" = "Oldest"."reporter_id"',
    );
  });

  it("renders NULLS FIRST / NULLS LAST on PostgreSQL only", () => {
    expect(buildCreateView(pg, "q", firstRow(), flat, resolverFor(pg))).toContain(
      'ORDER BY "Oldest"."raised_at" ASC NULLS FIRST, "Oldest"."severity" DESC NULLS LAST, "Oldest"."id" ASC NULLS FIRST LIMIT 1)',
    );
    expect(buildCreateView(mysql, "q", firstRow(), flat, resolverFor(mysql))).toContain(
      "ORDER BY `Oldest`.`raised_at` ASC, `Oldest`.`severity` DESC, `Oldest`.`id` ASC LIMIT 1)",
    );
  });

  it("a non-aliased first-row join repeats the plain table name in the inner FROM", () => {
    const p = firstRow();
    p.joins = [
      {
        ...p.joins[0],
        targetType: typeOf("issues"),
        scope: "issues",
        first: {
          order: [{ ref: { type: typeOf("issues"), field: "id" }, desc: false }],
          key: "id",
        },
        condition: {
          left: { type: typeOf("issues"), field: "ticketId" },
          op: "$eq",
          right: { field: "id" },
        },
      },
    ];
    expect(buildCreateView(sqlite, "q", p, [col("id", {})], resolverFor(sqlite))).toContain(
      'LEFT JOIN "issues" ON "issues"."id" = (SELECT "issues"."id" FROM "issues" WHERE "issues"."ticket_id" = "tickets"."id" ORDER BY "issues"."id" ASC LIMIT 1)',
    );
  });
});
