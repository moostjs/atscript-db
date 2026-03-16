import { describe, it, expect } from "vite-plus/test";
import {
  qi,
  quoteTableName,
  pgTypeFromField,
  buildCreateTable,
  collationToPg,
  pgDialect,
  offsetPlaceholders,
  defaultValueForType,
  defaultValueToSqlLiteral,
} from "../sql-builder";
import { buildInsert, buildSelect, buildUpdate, buildDelete } from "../sql-builder";
import type { TDbFieldMeta } from "@atscript/db";
import { finalizeParams } from "@atscript/db-sql-tools";

// ── Identifier quoting ──────────────────────────────────────────────────────

describe("qi (quote identifier)", () => {
  it("wraps name in double quotes", () => {
    expect(qi("users")).toBe('"users"');
  });

  it("escapes embedded double quotes", () => {
    expect(qi('my"column')).toBe('"my""column"');
  });
});

describe("quoteTableName", () => {
  it("quotes simple table name", () => {
    expect(quoteTableName("users")).toBe('"users"');
  });

  it("quotes schema.table format", () => {
    expect(quoteTableName("public.users")).toBe('"public"."users"');
  });
});

// ── Dialect: paramPlaceholder ───────────────────────────────────────────────

describe("pgDialect paramPlaceholder", () => {
  it("generates $N placeholders", () => {
    expect(pgDialect.paramPlaceholder!(1)).toBe("$1");
    expect(pgDialect.paramPlaceholder!(5)).toBe("$5");
  });

  it("keeps booleans native in toParam", () => {
    expect(pgDialect.toParam(true)).toBe(true);
    expect(pgDialect.toParam(false)).toBe(false);
  });

  it("converts undefined to null in toParam", () => {
    expect(pgDialect.toParam(undefined)).toBe(null);
  });
});

// ── DML builders: $N placeholders ───────────────────────────────────────────

describe("buildInsert", () => {
  it("uses $N placeholders", () => {
    const result = buildInsert("users", { name: "Alice", age: 30 });
    expect(result.sql).toBe('INSERT INTO "users" ("name", "age") VALUES ($1, $2)');
    expect(result.params).toEqual(["Alice", 30]);
  });
});

describe("buildSelect", () => {
  it("uses $N for WHERE + LIMIT + OFFSET", () => {
    // WHERE fragments use ? — finalizeParams inside the builder converts all ? to $N
    const where = { sql: '"active" = ?', params: [true] };
    const result = buildSelect("users", where, { $limit: 10, $skip: 5 });
    expect(result.sql).toBe('SELECT * FROM "users" WHERE "active" = $1 LIMIT $2 OFFSET $3');
    expect(result.params).toEqual([true, 10, 5]);
  });
});

describe("buildUpdate", () => {
  it("uses $N for SET + WHERE", () => {
    const where = { sql: '"id" = ?', params: [1] };
    const result = buildUpdate("users", { name: "Bob" }, where);
    expect(result.sql).toBe('UPDATE "users" SET "name" = $1 WHERE "id" = $2');
    expect(result.params).toEqual(["Bob", 1]);
  });
});

describe("buildDelete", () => {
  it("uses $N for WHERE", () => {
    const where = { sql: '"id" = ?', params: [42] };
    const result = buildDelete("users", where);
    expect(result.sql).toBe('DELETE FROM "users" WHERE "id" = $1');
    expect(result.params).toEqual([42]);
  });
});

// ── finalizeParams ──────────────────────────────────────────────────────────

describe("finalizeParams", () => {
  it("replaces ? with $N for pg dialect", () => {
    const result = finalizeParams(pgDialect, {
      sql: "SELECT * FROM t WHERE a = ? AND b = ? LIMIT ?",
      params: [1, 2, 10],
    });
    expect(result.sql).toBe("SELECT * FROM t WHERE a = $1 AND b = $2 LIMIT $3");
    expect(result.params).toEqual([1, 2, 10]);
  });

  it("is a no-op when paramPlaceholder is not set", () => {
    const dialect = { ...pgDialect, paramPlaceholder: undefined };
    const input = { sql: "SELECT * FROM t WHERE a = ?", params: [1] };
    const result = finalizeParams(dialect, input);
    expect(result).toBe(input); // same object reference
  });
});

// ── offsetPlaceholders ──────────────────────────────────────────────────────

describe("offsetPlaceholders", () => {
  it("offsets $N by given amount", () => {
    const result = offsetPlaceholders({ sql: '"a" = $1 AND "b" = $2', params: [1, 2] }, 3);
    expect(result.sql).toBe('"a" = $4 AND "b" = $5');
    expect(result.params).toEqual([1, 2]);
  });

  it("returns same fragment when offset is 0", () => {
    const input = { sql: '"a" = $1', params: [1] };
    expect(offsetPlaceholders(input, 0)).toBe(input);
  });
});

// ── Type mapping ────────────────────────────────────────────────────────────

describe("pgTypeFromField", () => {
  function field(overrides: Partial<TDbFieldMeta>): TDbFieldMeta {
    return {
      path: "test",
      physicalName: "test",
      designType: "string",
      optional: false,
      isPrimaryKey: false,
      ignored: false,
      ...overrides,
    } as TDbFieldMeta;
  }

  it("maps boolean to BOOLEAN (native)", () => {
    expect(pgTypeFromField(field({ designType: "boolean" }))).toBe("BOOLEAN");
  });

  it("maps number to DOUBLE PRECISION", () => {
    expect(pgTypeFromField(field({ designType: "number" }))).toBe("DOUBLE PRECISION");
  });

  it("maps string to TEXT", () => {
    expect(pgTypeFromField(field({ designType: "string" }))).toBe("TEXT");
  });

  it("maps string PK to VARCHAR(255)", () => {
    expect(pgTypeFromField(field({ designType: "string", isPrimaryKey: true }))).toBe(
      "VARCHAR(255)",
    );
  });

  it("maps string with nocase collation to CITEXT", () => {
    expect(pgTypeFromField(field({ designType: "string", collate: "nocase" }))).toBe("CITEXT");
  });

  it("maps json/object/array to JSONB", () => {
    expect(pgTypeFromField(field({ designType: "json" }))).toBe("JSONB");
    expect(pgTypeFromField(field({ designType: "object" }))).toBe("JSONB");
    expect(pgTypeFromField(field({ designType: "array" }))).toBe("JSONB");
  });

  it("maps decimal to NUMERIC(10,2)", () => {
    expect(pgTypeFromField(field({ designType: "decimal" }))).toBe("NUMERIC(10,2)");
  });

  it("maps number with increment default to BIGINT", () => {
    expect(
      pgTypeFromField(
        field({
          designType: "number",
          defaultValue: { kind: "fn", fn: "increment" },
        }),
      ),
    ).toBe("BIGINT");
  });

  it("maps number with now default to BIGINT (epoch ms)", () => {
    expect(
      pgTypeFromField(
        field({
          designType: "number",
          defaultValue: { kind: "fn", fn: "now" },
        }),
      ),
    ).toBe("BIGINT");
  });

  it("maps signed int types to matching PG types", () => {
    const mkField = (tag: string) =>
      field({
        designType: "number",
        type: { type: { tags: new Set(["int", tag]) } } as any,
      });
    expect(pgTypeFromField(mkField("int8"))).toBe("SMALLINT");
    expect(pgTypeFromField(mkField("int16"))).toBe("SMALLINT");
    expect(pgTypeFromField(mkField("int32"))).toBe("INTEGER");
    expect(pgTypeFromField(mkField("int64"))).toBe("BIGINT");
  });

  it("promotes unsigned int types to next-larger PG type", () => {
    const mkField = (tag: string) =>
      field({
        designType: "number",
        type: { type: { tags: new Set(["int", tag]) } } as any,
      });
    expect(pgTypeFromField(mkField("uint8"))).toBe("SMALLINT");
    expect(pgTypeFromField(mkField("uint16"))).toBe("INTEGER");
    expect(pgTypeFromField(mkField("uint32"))).toBe("BIGINT");
    expect(pgTypeFromField(mkField("uint64"))).toBe("BIGINT");
  });
});

// ── Collation mapping ───────────────────────────────────────────────────────

describe("collationToPg", () => {
  it('maps binary to "C"', () => {
    expect(collationToPg("binary")).toBe('"C"');
  });

  it("maps nocase to null (CITEXT type used instead of collation)", () => {
    expect(collationToPg("nocase")).toBeNull();
  });
});

// ── Boolean default helpers ──────────────────────────────────────────────────

describe("defaultValueForType (PG-aware)", () => {
  it("returns false for boolean (not 0)", () => {
    expect(defaultValueForType("boolean")).toBe("false");
  });

  it("returns 0 for number", () => {
    expect(defaultValueForType("number")).toBe("0");
  });
});

describe("defaultValueToSqlLiteral (PG-aware)", () => {
  it("converts boolean 0 to false", () => {
    expect(defaultValueToSqlLiteral("boolean", "0")).toBe("false");
  });

  it("converts boolean 1 to true", () => {
    expect(defaultValueToSqlLiteral("boolean", "1")).toBe("true");
  });

  it('converts boolean "true" to true', () => {
    expect(defaultValueToSqlLiteral("boolean", "true")).toBe("true");
  });

  it("keeps number as-is", () => {
    expect(defaultValueToSqlLiteral("number", "42")).toBe("42");
  });
});

// ── CREATE TABLE ────────────────────────────────────────────────────────────

describe("buildCreateTable", () => {
  it("uses GENERATED BY DEFAULT AS IDENTITY for increment", () => {
    const fields: TDbFieldMeta[] = [
      {
        path: "id",
        physicalName: "id",
        designType: "number",
        optional: false,
        isPrimaryKey: true,
        ignored: false,
        defaultValue: { kind: "fn", fn: "increment" },
      } as TDbFieldMeta,
    ];
    const sql = buildCreateTable("users", fields, undefined, {
      incrementFields: new Set(["id"]),
    });
    expect(sql).toContain("GENERATED BY DEFAULT AS IDENTITY");
    expect(sql).not.toContain("AUTO_INCREMENT");
  });

  it("uses gen_random_uuid() for uuid default", () => {
    const fields: TDbFieldMeta[] = [
      {
        path: "id",
        physicalName: "id",
        designType: "string",
        optional: false,
        isPrimaryKey: true,
        ignored: false,
        defaultValue: { kind: "fn", fn: "uuid" },
      } as TDbFieldMeta,
    ];
    const sql = buildCreateTable("tokens", fields);
    expect(sql).toContain("DEFAULT gen_random_uuid()");
  });

  it("uses epoch ms expression for now default (BIGINT)", () => {
    const fields: TDbFieldMeta[] = [
      {
        path: "createdAt",
        physicalName: "created_at",
        designType: "number",
        optional: true,
        isPrimaryKey: false,
        ignored: false,
        defaultValue: { kind: "fn", fn: "now" },
      } as TDbFieldMeta,
    ];
    const sql = buildCreateTable("events", fields);
    expect(sql).toContain("extract(epoch from now())");
    expect(sql).toContain("::bigint");
    expect(sql).not.toContain("TIMESTAMPTZ");
  });

  it("uses false/true for boolean defaults (not 0/1)", () => {
    const fields: TDbFieldMeta[] = [
      {
        path: "id",
        physicalName: "id",
        designType: "number",
        optional: false,
        isPrimaryKey: true,
        ignored: false,
      } as TDbFieldMeta,
      {
        path: "completed",
        physicalName: "completed",
        designType: "boolean",
        optional: false,
        isPrimaryKey: false,
        ignored: false,
        defaultValue: { kind: "value", value: "0" },
      } as TDbFieldMeta,
    ];
    const sql = buildCreateTable("todos", fields);
    expect(sql).toContain("DEFAULT false");
    expect(sql).not.toContain("DEFAULT 0");
  });

  it("generates no ENGINE/CHARSET/COLLATE suffix", () => {
    const fields: TDbFieldMeta[] = [
      {
        path: "id",
        physicalName: "id",
        designType: "number",
        optional: false,
        isPrimaryKey: true,
        ignored: false,
      } as TDbFieldMeta,
    ];
    const sql = buildCreateTable("t", fields);
    expect(sql).not.toContain("ENGINE");
    expect(sql).not.toContain("CHARSET");
    expect(sql).not.toContain("utf8mb4");
  });
});
