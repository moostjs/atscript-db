import { beforeAll, describe, it, expect } from "vite-plus/test";

import {
  buildInsert,
  buildSelect,
  buildUpdate,
  buildDelete,
  buildCreateTable,
  mysqlTypeFromField,
  mysqlDialect,
  esc,
  qi,
  quoteTableName,
  sqlStringLiteral,
  collationToMysql,
  defaultValueForType,
} from "../sql-builder";
import { toSqlValue } from "@atscript/db-sql-tools";
import type { TDbFieldMeta } from "@atscript/db";
import { prepareFixtures } from "./test-utils";

beforeAll(() => prepareFixtures());

// ── Helper to create minimal TDbFieldMeta ─────────────────────────────────

function field(overrides: Partial<TDbFieldMeta> & { designType: string }): TDbFieldMeta {
  return {
    path: "test",
    physicalName: "test",
    optional: false,
    isPrimaryKey: false,
    ignored: false,
    storage: "column",
    type: { type: { tags: new Set() }, metadata: new Map() } as any,
    ...overrides,
  } as TDbFieldMeta;
}

function fieldWithTags(designType: string, tags: string[]): TDbFieldMeta {
  return field({
    designType,
    type: { type: { tags: new Set(tags) }, metadata: new Map() } as any,
  });
}

function fieldWithMetadata(
  designType: string,
  meta: Partial<AtscriptMetadata>,
  tags: string[] = [],
): TDbFieldMeta {
  const map = new Map(Object.entries(meta));
  return field({
    designType,
    type: {
      type: { tags: new Set(tags) },
      metadata: { get: (k: string) => map.get(k), has: (k: string) => map.has(k) },
    } as any,
  });
}

// ── Identifier quoting ──────────────────────────────────────────────────

describe("esc / qi / quoteTableName", () => {
  it("should escape backticks in identifiers", () => {
    expect(esc("my`field")).toBe("my``field");
  });

  it("should backtick-quote an identifier", () => {
    expect(qi("users")).toBe("`users`");
    expect(qi("my`table")).toBe("`my``table`");
  });

  it("should quote a simple table name", () => {
    expect(quoteTableName("users")).toBe("`users`");
  });

  it("should quote a schema.table name", () => {
    expect(quoteTableName("mydb.users")).toBe("`mydb`.`users`");
  });
});

// ── Value conversion ────────────────────────────────────────────────────

describe("toSqlValue", () => {
  it("should convert undefined to null", () => {
    expect(toSqlValue(undefined)).toBeNull();
  });

  it("should pass through null", () => {
    expect(toSqlValue(null)).toBeNull();
  });

  it("should stringify objects", () => {
    expect(toSqlValue({ a: 1 })).toBe('{"a":1}');
  });

  it("should stringify arrays", () => {
    expect(toSqlValue([1, 2])).toBe("[1,2]");
  });

  it("should convert booleans to 0/1", () => {
    expect(toSqlValue(true)).toBe(1);
    expect(toSqlValue(false)).toBe(0);
  });

  it("should pass through strings and numbers", () => {
    expect(toSqlValue("hello")).toBe("hello");
    expect(toSqlValue(42)).toBe(42);
  });
});

describe("mysqlDialect.toParam", () => {
  it("should convert undefined to null", () => {
    expect(mysqlDialect.toParam(undefined)).toBeNull();
  });

  it("should convert booleans to 0/1", () => {
    expect(mysqlDialect.toParam(true)).toBe(1);
    expect(mysqlDialect.toParam(false)).toBe(0);
  });

  it("should pass through strings, numbers, and null", () => {
    expect(mysqlDialect.toParam("hello")).toBe("hello");
    expect(mysqlDialect.toParam(42)).toBe(42);
    expect(mysqlDialect.toParam(null)).toBeNull();
  });
});

describe("sqlStringLiteral", () => {
  it("should quote and escape single quotes", () => {
    expect(sqlStringLiteral("it's")).toBe("'it''s'");
    expect(sqlStringLiteral("hello")).toBe("'hello'");
  });
});

// ── DML builders ────────────────────────────────────────────────────────

describe("buildInsert", () => {
  it("should build INSERT with backtick quoting", () => {
    const { sql, params } = buildInsert("users", { name: "John", age: 30 });
    expect(sql).toBe("INSERT INTO `users` (`name`, `age`) VALUES (?, ?)");
    expect(params).toEqual(["John", 30]);
  });

  it("should handle schema.table", () => {
    const { sql } = buildInsert("mydb.users", { name: "John" });
    expect(sql).toContain("`mydb`.`users`");
  });

  it("should convert objects to JSON", () => {
    const { params } = buildInsert("t", { data: { x: 1 } });
    expect(params).toEqual(['{"x":1}']);
  });
});

describe("buildSelect", () => {
  it("should build SELECT with WHERE", () => {
    const { sql, params } = buildSelect("users", { sql: "`age` > ?", params: [18] });
    expect(sql).toBe("SELECT * FROM `users` WHERE `age` > ?");
    expect(params).toEqual([18]);
  });

  it("should add ORDER BY", () => {
    const { sql } = buildSelect(
      "users",
      { sql: "1=1", params: [] },
      {
        $sort: { name: 1, age: -1 },
      },
    );
    expect(sql).toContain("ORDER BY `name` ASC, `age` DESC");
  });

  it("should add LIMIT", () => {
    const { sql, params } = buildSelect(
      "users",
      { sql: "1=1", params: [] },
      {
        $limit: 10,
      },
    );
    expect(sql).toContain("LIMIT ?");
    expect(params).toEqual([10]);
  });

  it("should use large LIMIT for OFFSET without LIMIT", () => {
    const { sql, params } = buildSelect(
      "users",
      { sql: "1=1", params: [] },
      {
        $skip: 5,
      },
    );
    expect(sql).toContain("LIMIT 18446744073709551615 OFFSET ?");
    expect(params).toEqual([5]);
  });

  it("should add LIMIT and OFFSET together", () => {
    const { sql, params } = buildSelect(
      "users",
      { sql: "1=1", params: [] },
      {
        $limit: 10,
        $skip: 20,
      },
    );
    expect(sql).toContain("LIMIT ? OFFSET ?");
    expect(params).toEqual([10, 20]);
  });
});

describe("buildUpdate", () => {
  it("should build UPDATE with SET and WHERE", () => {
    const { sql, params } = buildUpdate(
      "users",
      { name: "Jane" },
      { sql: "`id` = ?", params: [1] },
    );
    expect(sql).toBe("UPDATE `users` SET `name` = ? WHERE `id` = ?");
    expect(params).toEqual(["Jane", 1]);
  });

  it("should add LIMIT when specified", () => {
    const { sql } = buildUpdate("users", { name: "Jane" }, { sql: "1=1", params: [] }, 1);
    expect(sql).toContain("LIMIT 1");
  });
});

describe("buildDelete", () => {
  it("should build DELETE with WHERE", () => {
    const { sql, params } = buildDelete("users", { sql: "`id` = ?", params: [1] });
    expect(sql).toBe("DELETE FROM `users` WHERE `id` = ?");
    expect(params).toEqual([1]);
  });

  it("should add LIMIT when specified", () => {
    const { sql } = buildDelete("users", { sql: "1=1", params: [] }, 1);
    expect(sql).toContain("LIMIT 1");
  });
});

// ── Type mapper ─────────────────────────────────────────────────────────

describe("mysqlTypeFromField", () => {
  it("should map number to DOUBLE", () => {
    expect(mysqlTypeFromField(field({ designType: "number" }))).toBe("DOUBLE");
  });

  it("should map number with @db.default.increment to BIGINT (not DOUBLE)", () => {
    expect(
      mysqlTypeFromField(
        field({
          designType: "number",
          defaultValue: { kind: "fn", fn: "increment" },
        }),
      ),
    ).toBe("BIGINT");
  });

  it("should map FK field to target PK type via fkTargetField", () => {
    const targetPk = field({
      designType: "number",
      defaultValue: { kind: "fn", fn: "increment" },
    });
    expect(
      mysqlTypeFromField(
        field({
          designType: "number",
          fkTargetField: targetPk,
        }),
      ),
    ).toBe("BIGINT");
  });

  it("should map FK field to INT when target PK is integer", () => {
    const targetPk = field({ designType: "integer" });
    expect(
      mysqlTypeFromField(
        field({
          designType: "number",
          fkTargetField: targetPk,
        }),
      ),
    ).toBe("INT");
  });

  it("should map number with @db.default.now to TIMESTAMP (not DOUBLE)", () => {
    expect(
      mysqlTypeFromField(
        field({
          designType: "number",
          defaultValue: { kind: "fn", fn: "now" },
        }),
      ),
    ).toBe("TIMESTAMP");
  });

  it("should map number.int to INT (not DOUBLE)", () => {
    expect(mysqlTypeFromField(fieldWithTags("number", ["int", "number"]))).toBe("INT");
  });

  it("should map number.int with @db.mysql.unsigned to INT UNSIGNED", () => {
    expect(
      mysqlTypeFromField(
        fieldWithMetadata(
          "number",
          {
            "db.mysql.unsigned": true,
          },
          ["int", "number"],
        ),
      ),
    ).toBe("INT UNSIGNED");
  });

  it("should map number.int.int16 to SMALLINT", () => {
    expect(mysqlTypeFromField(fieldWithTags("number", ["int", "int16", "number"]))).toBe(
      "SMALLINT",
    );
  });

  it("should map number.int.int64 with @db.mysql.unsigned to BIGINT UNSIGNED", () => {
    expect(
      mysqlTypeFromField(
        fieldWithMetadata(
          "number",
          {
            "db.mysql.unsigned": true,
          },
          ["int", "int64", "number"],
        ),
      ),
    ).toBe("BIGINT UNSIGNED");
  });

  it("should map number with precision to DECIMAL", () => {
    expect(
      mysqlTypeFromField(
        fieldWithMetadata("number", {
          "db.column.precision": { precision: 10, scale: 2 },
        }),
      ),
    ).toBe("DECIMAL(10,2)");
  });

  it("should map integer to INT", () => {
    expect(mysqlTypeFromField(field({ designType: "integer" }))).toBe("INT");
  });

  it("should map int8 tag to TINYINT", () => {
    expect(mysqlTypeFromField(fieldWithTags("integer", ["int8"]))).toBe("TINYINT");
  });

  it("should map uint8 tag to TINYINT UNSIGNED", () => {
    expect(mysqlTypeFromField(fieldWithTags("integer", ["uint8"]))).toBe("TINYINT UNSIGNED");
  });

  it("should map byte tag to TINYINT UNSIGNED", () => {
    expect(mysqlTypeFromField(fieldWithTags("integer", ["byte"]))).toBe("TINYINT UNSIGNED");
  });

  it("should map int16 tag to SMALLINT", () => {
    expect(mysqlTypeFromField(fieldWithTags("integer", ["int16"]))).toBe("SMALLINT");
  });

  it("should map uint16 tag to SMALLINT UNSIGNED", () => {
    expect(mysqlTypeFromField(fieldWithTags("integer", ["uint16"]))).toBe("SMALLINT UNSIGNED");
  });

  it("should map port tag to SMALLINT UNSIGNED", () => {
    expect(mysqlTypeFromField(fieldWithTags("integer", ["port"]))).toBe("SMALLINT UNSIGNED");
  });

  it("should map int32 tag to INT", () => {
    expect(mysqlTypeFromField(fieldWithTags("integer", ["int32"]))).toBe("INT");
  });

  it("should map uint32 tag to INT UNSIGNED", () => {
    expect(mysqlTypeFromField(fieldWithTags("integer", ["uint32"]))).toBe("INT UNSIGNED");
  });

  it("should map int64 tag to BIGINT", () => {
    expect(mysqlTypeFromField(fieldWithTags("integer", ["int64"]))).toBe("BIGINT");
  });

  it("should map uint64 tag to BIGINT UNSIGNED", () => {
    expect(mysqlTypeFromField(fieldWithTags("integer", ["uint64"]))).toBe("BIGINT UNSIGNED");
  });

  it("should map integer with @db.mysql.unsigned to INT UNSIGNED", () => {
    expect(
      mysqlTypeFromField(
        fieldWithMetadata("integer", {
          "db.mysql.unsigned": true,
        }),
      ),
    ).toBe("INT UNSIGNED");
  });

  it("should map boolean to TINYINT(1)", () => {
    expect(mysqlTypeFromField(field({ designType: "boolean" }))).toBe("TINYINT(1)");
  });

  it("should map string without maxLength to TEXT", () => {
    expect(mysqlTypeFromField(field({ designType: "string" }))).toBe("TEXT");
  });

  it("should map string PK to VARCHAR(255)", () => {
    expect(mysqlTypeFromField(field({ designType: "string", isPrimaryKey: true }))).toBe(
      "VARCHAR(255)",
    );
  });

  it("should map indexed string to TEXT (index uses key length prefix)", () => {
    expect(mysqlTypeFromField(field({ designType: "string", isIndexed: true }))).toBe("TEXT");
  });

  it("should map string with default value to VARCHAR(255)", () => {
    expect(
      mysqlTypeFromField(
        field({ designType: "string", defaultValue: { kind: "value", value: "active" } }),
      ),
    ).toBe("VARCHAR(255)");
  });

  it("should map char tag to CHAR(1)", () => {
    expect(mysqlTypeFromField(fieldWithTags("string", ["char"]))).toBe("CHAR(1)");
  });

  it("should map string with maxLength to VARCHAR(N)", () => {
    expect(
      mysqlTypeFromField(
        fieldWithMetadata("string", {
          "expect.maxLength": { length: 500 },
        }),
      ),
    ).toBe("VARCHAR(500)");
  });

  it("should map string with large maxLength to LONGTEXT", () => {
    expect(
      mysqlTypeFromField(
        fieldWithMetadata("string", {
          "expect.maxLength": { length: 100000 },
        }),
      ),
    ).toBe("LONGTEXT");
  });

  it("should map string with @db.mysql.type override", () => {
    expect(
      mysqlTypeFromField(
        fieldWithMetadata("string", {
          "db.mysql.type": "MEDIUMTEXT",
        }),
      ),
    ).toBe("MEDIUMTEXT");
  });

  it("should map json to JSON", () => {
    expect(mysqlTypeFromField(field({ designType: "json" }))).toBe("JSON");
  });

  it("should map object to JSON", () => {
    expect(mysqlTypeFromField(field({ designType: "object" }))).toBe("JSON");
  });

  it("should map array to JSON", () => {
    expect(mysqlTypeFromField(field({ designType: "array" }))).toBe("JSON");
  });

  it("should map unknown designType to TEXT", () => {
    expect(mysqlTypeFromField(field({ designType: "anything" }))).toBe("TEXT");
  });
});

// ── Collation mapping ───────────────────────────────────────────────────

describe("collationToMysql", () => {
  it("should map binary to utf8mb4_bin", () => {
    expect(collationToMysql("binary")).toBe("utf8mb4_bin");
  });

  it("should map nocase to utf8mb4_general_ci", () => {
    expect(collationToMysql("nocase")).toBe("utf8mb4_general_ci");
  });

  it("should map unicode to utf8mb4_unicode_ci", () => {
    expect(collationToMysql("unicode")).toBe("utf8mb4_unicode_ci");
  });
});

// ── DDL builder ─────────────────────────────────────────────────────────

describe("buildCreateTable", () => {
  it("should build CREATE TABLE with basic columns", () => {
    const sql = buildCreateTable("users", [
      field({ physicalName: "id", designType: "integer", isPrimaryKey: true }),
      field({ physicalName: "name", designType: "string" }),
    ]);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `users`");
    expect(sql).toContain("`id` INT PRIMARY KEY");
    expect(sql).toContain("`name` TEXT NOT NULL");
    expect(sql).toContain("ENGINE=InnoDB");
    expect(sql).toContain("DEFAULT CHARSET=utf8mb4");
    expect(sql).toContain("COLLATE=utf8mb4_unicode_ci");
  });

  it("should add AUTO_INCREMENT for increment fields", () => {
    const sql = buildCreateTable(
      "users",
      [field({ physicalName: "id", designType: "integer", isPrimaryKey: true })],
      undefined,
      {
        incrementFields: new Set(["id"]),
      },
    );
    expect(sql).toContain("AUTO_INCREMENT");
  });

  it("should add AUTO_INCREMENT start value as table option", () => {
    const sql = buildCreateTable(
      "users",
      [field({ physicalName: "id", designType: "integer", isPrimaryKey: true })],
      undefined,
      {
        incrementFields: new Set(["id"]),
        autoIncrementStart: 1000,
      },
    );
    expect(sql).toContain("AUTO_INCREMENT=1000");
  });

  it("should add DEFAULT for string value", () => {
    const sql = buildCreateTable("t", [
      field({
        physicalName: "status",
        designType: "string",
        defaultValue: { kind: "value", value: "active" },
      }),
    ]);
    expect(sql).toContain("DEFAULT 'active'");
  });

  it("should add DEFAULT 0 for boolean false (not DEFAULT 'false')", () => {
    const sql = buildCreateTable("t", [
      field({
        physicalName: "completed",
        designType: "boolean",
        defaultValue: { kind: "value", value: "false" },
      }),
    ]);
    expect(sql).toContain("DEFAULT 0");
    expect(sql).not.toContain("DEFAULT 'false'");
  });

  it("should add DEFAULT 1 for boolean true", () => {
    const sql = buildCreateTable("t", [
      field({
        physicalName: "active",
        designType: "boolean",
        defaultValue: { kind: "value", value: "true" },
      }),
    ]);
    expect(sql).toContain("DEFAULT 1");
  });

  it("should add unquoted DEFAULT for number value", () => {
    const sql = buildCreateTable("t", [
      field({
        physicalName: "priority",
        designType: "integer",
        defaultValue: { kind: "value", value: "5" },
      }),
    ]);
    expect(sql).toContain("DEFAULT 5");
    expect(sql).not.toContain("DEFAULT '5'");
  });

  it("should add DEFAULT (UUID()) for uuid default", () => {
    const sql = buildCreateTable("t", [
      field({
        physicalName: "uid",
        designType: "string",
        defaultValue: { kind: "fn", fn: "uuid" },
      }),
    ]);
    expect(sql).toContain("DEFAULT (UUID())");
  });

  it("should add DEFAULT CURRENT_TIMESTAMP for now default", () => {
    const sql = buildCreateTable("t", [
      field({
        physicalName: "created",
        designType: "integer",
        defaultValue: { kind: "fn", fn: "now" },
      }),
    ]);
    expect(sql).toContain("DEFAULT CURRENT_TIMESTAMP");
  });

  it("should add FOREIGN KEY constraints", () => {
    const fks = new Map([
      [
        "userId",
        {
          fields: ["userId"],
          targetTable: "users",
          targetFields: ["id"],
          onDelete: "cascade" as const,
          onUpdate: "restrict" as const,
        },
      ],
    ]);
    const sql = buildCreateTable(
      "posts",
      [
        field({ physicalName: "id", designType: "integer", isPrimaryKey: true }),
        field({ physicalName: "userId", designType: "integer" }),
      ],
      fks,
    );
    expect(sql).toContain(
      "FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT",
    );
  });

  it("should use target PK type for FK columns via fkTargetField", () => {
    const targetPk = field({
      designType: "number",
      defaultValue: { kind: "fn", fn: "increment" },
      isPrimaryKey: true,
    });
    const fks = new Map([
      [
        "ownerId",
        {
          fields: ["ownerId"],
          targetTable: "users",
          targetFields: ["id"],
        },
      ],
    ]);
    const sql = buildCreateTable(
      "projects",
      [
        field({ physicalName: "id", designType: "integer", isPrimaryKey: true }),
        field({ physicalName: "ownerId", designType: "number", fkTargetField: targetPk }),
      ],
      fks,
    );
    expect(sql).toContain("`ownerId` BIGINT NOT NULL");
    expect(sql).not.toContain("`ownerId` DOUBLE");
  });

  it("should add composite primary key", () => {
    const sql = buildCreateTable("tags", [
      field({ physicalName: "postId", designType: "integer", isPrimaryKey: true }),
      field({ physicalName: "tagId", designType: "integer", isPrimaryKey: true }),
    ]);
    expect(sql).toContain("PRIMARY KEY (`postId`, `tagId`)");
    // Single-column PKs should NOT be present
    expect(sql).not.toContain("`postId` INT PRIMARY KEY");
  });

  it("should use custom engine/charset/collation options", () => {
    const sql = buildCreateTable(
      "t",
      [field({ physicalName: "id", designType: "integer", isPrimaryKey: true })],
      undefined,
      {
        engine: "MyISAM",
        charset: "latin1",
        collation: "latin1_swedish_ci",
      },
    );
    expect(sql).toContain("ENGINE=MyISAM");
    expect(sql).toContain("DEFAULT CHARSET=latin1");
    expect(sql).toContain("COLLATE=latin1_swedish_ci");
  });

  it("should skip ignored fields", () => {
    const sql = buildCreateTable("t", [
      field({ physicalName: "id", designType: "integer", isPrimaryKey: true }),
      field({ physicalName: "hidden", designType: "string", ignored: true }),
    ]);
    expect(sql).not.toContain("hidden");
  });

  it("should use VARCHAR(255) for string PK without maxLength", () => {
    const sql = buildCreateTable("__atscript_control", [
      field({ physicalName: "_id", designType: "string", isPrimaryKey: true }),
      field({ physicalName: "value", designType: "string", optional: true }),
    ]);
    expect(sql).toContain("`_id` VARCHAR(255) PRIMARY KEY");
    expect(sql).not.toContain("`_id` TEXT");
  });

  it("should allow optional fields (no NOT NULL)", () => {
    const sql = buildCreateTable("t", [
      field({ physicalName: "id", designType: "integer", isPrimaryKey: true }),
      field({ physicalName: "bio", designType: "string", optional: true }),
    ]);
    expect(sql).toContain("`bio` TEXT");
    expect(sql).not.toMatch(/`bio` TEXT NOT NULL/);
  });
});

// ── Default value for type ──────────────────────────────────────────────

describe("defaultValueForType", () => {
  it("should return 0 for number", () => {
    expect(defaultValueForType("number")).toBe("0");
  });

  it("should return 0 for integer", () => {
    expect(defaultValueForType("integer")).toBe("0");
  });

  it("should return 0 for boolean", () => {
    expect(defaultValueForType("boolean")).toBe("0");
  });

  it("should return empty string for string", () => {
    expect(defaultValueForType("string")).toBe("''");
  });
});
