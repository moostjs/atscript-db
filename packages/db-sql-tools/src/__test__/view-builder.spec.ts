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
