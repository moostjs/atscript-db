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
