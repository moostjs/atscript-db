import { describe, it, expect } from "vite-plus/test";
import type { TDbFieldMeta, TViewJsonType } from "@atscript/db";

import { derivedColumnExpr, replaceColumnsFor } from "../sql-builder";
import type { SqlDialect } from "../dialect";

// `@db.column.derived` helpers shared by the SQL adapters (since 0.1.141).

const plain = {
  quoteIdentifier: (s: string) => `"${s}"`,
  createViewPrefix: "CREATE VIEW",
} as unknown as SqlDialect;
const dialect: SqlDialect = {
  ...plain,
  jsonExtract: (col: string, path: readonly string[], type: TViewJsonType) =>
    `extract(${col}, ${path.join("/")}, ${type})`,
};

const field = (over: Partial<TDbFieldMeta>): TDbFieldMeta =>
  ({
    path: "customerId",
    physicalName: "customerId",
    designType: "string",
    optional: true,
    isPrimaryKey: false,
    ignored: false,
    storage: "column",
    ...over,
  }) as TDbFieldMeta;

const derived = field({
  derived: {
    sourcePath: "payload.customer.id",
    sourceColumn: "payload_json",
    jsonPath: ["customer", "id"],
    type: "string",
  },
});

describe("derivedColumnExpr", () => {
  it("renders the dialect's typed JSON extraction over the quoted source column", () => {
    expect(derivedColumnExpr(dialect, derived)).toBe(
      'extract("payload_json", customer/id, string)',
    );
  });

  it("refuses a non-derived field and a dialect without JSON extraction", () => {
    expect(() => derivedColumnExpr(dialect, field({}))).toThrow(
      'Column "customerId" is not a derived column',
    );
    expect(() => derivedColumnExpr(plain, derived)).toThrow(
      'Derived column "customerId": JSON extraction is not supported by this adapter',
    );
  });
});

describe("replaceColumnsFor", () => {
  it("never lists a derived column — a REPLACE assigns every stored column but computed ones", () => {
    const columns = replaceColumnsFor(
      [
        field({ path: "id", physicalName: "id", isPrimaryKey: true }),
        field({ path: "status", physicalName: "status" }),
        derived,
      ],
      new Set(),
    );
    expect(columns.map((c) => c.name)).toEqual(["status"]);
  });
});
