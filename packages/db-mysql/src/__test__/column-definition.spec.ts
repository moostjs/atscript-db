import { describe, it, expect } from "vite-plus/test";
import type { TDbFieldMeta } from "@atscript/db";

import {
  buildColumnDefinition,
  buildCreateTable,
  mysqlDefaultLiteral,
  mysqlTypeDefault,
  type TMysqlColumnContext,
} from "../sql-builder";

// Pure matrix for the ONE MySQL column-definition renderer (since 0.1.128):
// required/optional × value/fn/no default × VARCHAR/TEXT/JSON/TIMESTAMP,
// with ON UPDATE / COLLATE / AUTO_INCREMENT.

function field(overrides: Partial<TDbFieldMeta> & { physicalName: string }): TDbFieldMeta {
  return {
    path: overrides.physicalName,
    designType: "string",
    optional: false,
    isPrimaryKey: false,
    ignored: false,
    storage: "column",
    type: { type: { tags: new Set() }, metadata: new Map() } as any,
    ...overrides,
  } as TDbFieldMeta;
}

function ctx(purpose: TMysqlColumnContext["purpose"], extra: Partial<TMysqlColumnContext> = {}) {
  return { purpose, ...extra };
}

describe("buildColumnDefinition", () => {
  it("never emits DEFAULT NULL — no model default means no DEFAULT clause", () => {
    const required = field({ physicalName: "name", type: maxLen(64) });
    const optional = field({ physicalName: "note", optional: true, type: maxLen(64) });
    for (const purpose of ["create", "add", "modify"] as const) {
      for (const f of [required, optional]) {
        const { def } = buildColumnDefinition(f, ctx(purpose));
        expect(def).not.toContain("DEFAULT NULL");
        expect(def).not.toMatch(/NOT NULL DEFAULT NULL/);
      }
    }
    expect(buildColumnDefinition(optional, ctx("modify")).def).toBe("`note` VARCHAR(64) NULL");
    expect(buildColumnDefinition(required, ctx("modify")).def).toBe("`name` VARCHAR(64) NOT NULL");
  });

  it("create: PRIMARY KEY / AUTO_INCREMENT columns carry no explicit nullability", () => {
    const pk = field({
      physicalName: "id",
      designType: "number",
      isPrimaryKey: true,
      defaultValue: { kind: "fn", fn: "increment" },
    });
    expect(buildColumnDefinition(pk, ctx("create", { incrementFields: new Set(["id"]) })).def).toBe(
      "`id` BIGINT AUTO_INCREMENT",
    );
    expect(buildColumnDefinition(field({ physicalName: "name" }), ctx("create")).def).toBe(
      "`name` TEXT NOT NULL",
    );
    expect(
      buildColumnDefinition(field({ physicalName: "note", optional: true }), ctx("create")).def,
    ).toBe("`note` TEXT");
  });

  it("add/modify: nullability is always explicit and key columns are NOT NULL", () => {
    const pk = field({ physicalName: "code", isPrimaryKey: true });
    expect(buildColumnDefinition(pk, ctx("modify")).def).toBe("`code` VARCHAR(255) NOT NULL");
    const inc = field({
      physicalName: "id",
      designType: "number",
      defaultValue: { kind: "fn", fn: "increment" },
    });
    expect(
      buildColumnDefinition(inc, ctx("modify", { incrementFields: new Set(["id"]) })).def,
    ).toBe("`id` BIGINT AUTO_INCREMENT NOT NULL");
    // Demoted: the model no longer declares increment → plain NOT NULL, no AUTO_INCREMENT
    expect(
      buildColumnDefinition(field({ physicalName: "id", designType: "number" }), ctx("modify")).def,
    ).toBe("`id` DOUBLE NOT NULL");
  });

  it("add: never emits AUTO_INCREMENT (it needs a key in the same statement — the PK rebuild owns it)", () => {
    const inc = field({
      physicalName: "id",
      designType: "number",
      isPrimaryKey: true,
      defaultValue: { kind: "fn", fn: "increment" },
    });
    expect(buildColumnDefinition(inc, ctx("add", { incrementFields: new Set(["id"]) }))).toEqual({
      def: "`id` BIGINT NOT NULL",
      inventedDefault: false,
    });
    // A non-key increment column: no invented default either (fn default) —
    // MySQL fills a NOT NULL add with the implicit type default
    const plain = field({
      physicalName: "seq",
      designType: "number",
      defaultValue: { kind: "fn", fn: "increment" },
    });
    expect(buildColumnDefinition(plain, ctx("add", { incrementFields: new Set(["seq"]) }))).toEqual(
      { def: "`seq` BIGINT NOT NULL", inventedDefault: false },
    );
    expect(
      buildColumnDefinition(plain, ctx("modify", { incrementFields: new Set(["seq"]) })).def,
    ).toBe("`seq` BIGINT AUTO_INCREMENT NOT NULL");
  });

  it("add: invents a type default for a required default-less column and reports it", () => {
    const cases: Array<[TDbFieldMeta, string]> = [
      [field({ physicalName: "n", designType: "number" }), "`n` DOUBLE NOT NULL DEFAULT 0"],
      [field({ physicalName: "b", designType: "boolean" }), "`b` TINYINT(1) NOT NULL DEFAULT 0"],
      [field({ physicalName: "s", type: maxLen(32) }), "`s` VARCHAR(32) NOT NULL DEFAULT ''"],
      [field({ physicalName: "t" }), "`t` TEXT NOT NULL DEFAULT ('')"],
      [field({ physicalName: "j", designType: "json" }), "`j` JSON NOT NULL DEFAULT ('{}')"],
      [
        field({
          physicalName: "ts",
          designType: "number",
          defaultValue: undefined,
          type: mysqlType("TIMESTAMP"),
        }),
        "`ts` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
      ],
      [
        field({ physicalName: "geo", type: mysqlType("POINT SRID 4326") }),
        "`geo` POINT SRID 4326 NOT NULL DEFAULT (ST_SRID(POINT(0, 0), 4326))",
      ],
    ];
    for (const [f, expected] of cases) {
      const out = buildColumnDefinition(f, ctx("add"));
      expect(out.def).toBe(expected);
      expect(out.inventedDefault).toBe(true);
    }
    // Optional, PK and defaulted columns never get an invented default
    expect(buildColumnDefinition(field({ physicalName: "o", optional: true }), ctx("add"))).toEqual(
      {
        def: "`o` TEXT NULL",
        inventedDefault: false,
      },
    );
    expect(
      buildColumnDefinition(
        field({ physicalName: "d", defaultValue: { kind: "value", value: "x" } }),
        ctx("add"),
      ),
    ).toEqual({ def: "`d` VARCHAR(255) NOT NULL DEFAULT 'x'", inventedDefault: false });
  });

  it("uses the expression form for TEXT/BLOB/JSON/GEOMETRY value defaults", () => {
    const text = field({
      physicalName: "t",
      defaultValue: { kind: "value", value: "n/a" },
      type: mysqlType("TEXT"),
    });
    expect(buildColumnDefinition(text, ctx("create")).def).toBe(
      "`t` TEXT NOT NULL DEFAULT ('n/a')",
    );
    const json = field({
      physicalName: "j",
      designType: "json",
      defaultValue: { kind: "value", value: "{}" },
    });
    expect(buildColumnDefinition(json, ctx("modify")).def).toBe("`j` JSON NOT NULL DEFAULT ('{}')");
    expect(mysqlDefaultLiteral("VARCHAR(10)", "string", "it's")).toBe("'it''s'");
    expect(mysqlDefaultLiteral("LONGTEXT", "string", "x")).toBe("('x')");
    expect(mysqlDefaultLiteral("TINYINT(1)", "boolean", "true")).toBe("1");
  });

  it("renders fn defaults, COLLATE and ON UPDATE on every purpose", () => {
    const stamped = field({
      physicalName: "updatedAt",
      designType: "number",
      defaultValue: { kind: "fn", fn: "now" },
    });
    const onUpdateFields = new Map([["updatedAt", "CURRENT_TIMESTAMP"]]);
    for (const purpose of ["create", "add", "modify"] as const) {
      const { def } = buildColumnDefinition(stamped, ctx(purpose, { onUpdateFields }));
      expect(def).toContain("DEFAULT CURRENT_TIMESTAMP");
      expect(def).toContain("ON UPDATE CURRENT_TIMESTAMP");
    }
    const uuid = field({
      physicalName: "id",
      isPrimaryKey: true,
      defaultValue: { kind: "fn", fn: "uuid" },
    });
    expect(buildColumnDefinition(uuid, ctx("create")).def).toBe(
      "`id` VARCHAR(255) DEFAULT (UUID())",
    );

    const collated = field({ physicalName: "name", collate: "nocase", type: maxLen(40) });
    expect(buildColumnDefinition(collated, ctx("modify")).def).toBe(
      "`name` VARCHAR(40) NOT NULL COLLATE utf8mb4_general_ci",
    );
    const native = field({
      physicalName: "name",
      collate: "nocase",
      type: {
        type: { tags: new Set() },
        metadata: new Map<string, unknown>([
          ["db.mysql.collate", "utf8mb4_0900_ai_ci"],
          ["expect.maxLength", { length: 40 }],
        ]),
      } as any,
    });
    expect(buildColumnDefinition(native, ctx("add")).def).toBe(
      "`name` VARCHAR(40) NOT NULL DEFAULT '' COLLATE utf8mb4_0900_ai_ci",
    );
  });

  it("uses the adapter type mapper when given", () => {
    const f = field({ physicalName: "emb", designType: "array" });
    expect(buildColumnDefinition(f, ctx("modify", { typeMapper: () => "VECTOR(3)" })).def).toBe(
      "`emb` VECTOR(3) NOT NULL",
    );
    // VECTOR cannot carry a default → no invented default on add
    expect(buildColumnDefinition(f, ctx("add", { typeMapper: () => "VECTOR(3)" }))).toEqual({
      def: "`emb` VECTOR(3) NOT NULL",
      inventedDefault: false,
    });
  });
});

describe("mysqlTypeDefault", () => {
  it("is type-aware", () => {
    const f = field({ physicalName: "x" });
    expect(mysqlTypeDefault("JSON", f)).toBe("('{}')");
    expect(mysqlTypeDefault("POINT SRID 4326", f)).toBe("(ST_SRID(POINT(0, 0), 4326))");
    expect(mysqlTypeDefault("TIMESTAMP", f)).toBe("CURRENT_TIMESTAMP");
    expect(mysqlTypeDefault("DATETIME(3)", f)).toBe("CURRENT_TIMESTAMP");
    expect(mysqlTypeDefault("MEDIUMTEXT", f)).toBe("('')");
    expect(mysqlTypeDefault("BLOB", f)).toBe("('')");
    expect(mysqlTypeDefault("VARCHAR(255)", f)).toBe("''");
    expect(mysqlTypeDefault("CHAR(1)", f)).toBe("''");
    expect(mysqlTypeDefault("BIGINT UNSIGNED", f)).toBe("0");
    expect(mysqlTypeDefault("DECIMAL(10,2)", f)).toBe("0");
    expect(mysqlTypeDefault("TINYINT(1)", f)).toBe("0");
    expect(mysqlTypeDefault("DATE", f)).toBe("'1970-01-01'");
  });
});

describe("buildCreateTable — shared builder regression guard", () => {
  it("renders the same CREATE TABLE as before for a plain table", () => {
    const sql = buildCreateTable(
      "users",
      [
        field({
          physicalName: "id",
          designType: "number",
          isPrimaryKey: true,
          defaultValue: { kind: "fn", fn: "increment" },
        }),
        field({ physicalName: "email", type: maxLen(120) }),
        field({ physicalName: "status", defaultValue: { kind: "value", value: "active" } }),
        field({ physicalName: "bio", optional: true }),
        field({
          physicalName: "createdAt",
          designType: "number",
          defaultValue: { kind: "fn", fn: "now" },
        }),
      ],
      undefined,
      { incrementFields: new Set(["id"]) },
    );
    expect(sql).toBe(
      "CREATE TABLE IF NOT EXISTS `users` (`id` BIGINT AUTO_INCREMENT PRIMARY KEY, `email` VARCHAR(120) NOT NULL, " +
        "`status` VARCHAR(255) NOT NULL DEFAULT 'active', `bio` TEXT, `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) " +
        "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
  });

  it("omits inline FKs to deferred targets (foreign-key cycles)", () => {
    const fks = new Map([
      ["b", { fields: ["bId"], targetTable: "cycle_b", targetFields: ["id"] }],
      ["p", { fields: ["pId"], targetTable: "parents", targetFields: ["id"] }],
    ]) as any;
    const sql = buildCreateTable(
      "cycle_a",
      [field({ physicalName: "id", designType: "number", isPrimaryKey: true })],
      fks,
      { deferForeignKeysTo: new Set(["cycle_b"]) },
    );
    expect(sql).not.toContain("REFERENCES `cycle_b`");
    expect(sql).toContain("FOREIGN KEY (`pId`) REFERENCES `parents` (`id`)");
  });
});

// ── helpers ───────────────────────────────────────────────────────────────

function maxLen(length: number): any {
  return { type: { tags: new Set() }, metadata: new Map([["expect.maxLength", { length }]]) };
}

function mysqlType(t: string): any {
  return { type: { tags: new Set() }, metadata: new Map([["db.mysql.type", t]]) };
}

// ── Index key-length prefix (since 0.1.128) ──────────────────────────────

import { mysqlIndexPrefix, mysqlBytesPerChar, mysqlCharLength } from "../sql-builder";

describe("mysqlIndexPrefix", () => {
  const utf8mb4 = mysqlBytesPerChar("utf8mb4");

  it("bytes per char follows the table charset", () => {
    expect(mysqlBytesPerChar(undefined)).toBe(4);
    expect(mysqlBytesPerChar("utf8mb4")).toBe(4);
    expect(mysqlBytesPerChar("utf8mb3")).toBe(3);
    expect(mysqlBytesPerChar("utf8")).toBe(3);
    expect(mysqlBytesPerChar("latin1")).toBe(1);
    expect(mysqlBytesPerChar("ascii")).toBe(1);
    expect(mysqlBytesPerChar("binary")).toBe(1);
    expect(mysqlBytesPerChar("gb18030")).toBe(4);
  });

  it("VARCHAR/CHAR within the 3072-byte key part need no prefix; longer ones get the limit", () => {
    for (const n of [1, 36, 64, 128, 255, 768]) {
      expect(mysqlIndexPrefix(`VARCHAR(${n})`, utf8mb4)).toBeUndefined();
    }
    expect(mysqlIndexPrefix("CHAR(1)", utf8mb4)).toBeUndefined();
    expect(mysqlIndexPrefix("CHAR(36)", utf8mb4)).toBeUndefined();
    expect(mysqlIndexPrefix("VARCHAR(769)", utf8mb4)).toBe(768);
    expect(mysqlIndexPrefix("VARCHAR(1000)", utf8mb4)).toBe(768);
    expect(mysqlIndexPrefix("VARCHAR(2000)", utf8mb4)).toBe(768);
    // Narrower charsets allow longer prefixes
    expect(mysqlIndexPrefix("VARCHAR(1000)", mysqlBytesPerChar("utf8mb3"))).toBeUndefined();
    expect(mysqlIndexPrefix("VARCHAR(1025)", mysqlBytesPerChar("utf8mb3"))).toBe(1024);
    expect(mysqlIndexPrefix("VARCHAR(3072)", mysqlBytesPerChar("latin1"))).toBeUndefined();
    expect(mysqlIndexPrefix("VARCHAR(3073)", mysqlBytesPerChar("latin1"))).toBe(3072);
    expect(mysqlIndexPrefix("varchar(255)", utf8mb4)).toBeUndefined();
  });

  it("TEXT/BLOB families always get 255", () => {
    for (const t of ["TINYTEXT", "TEXT", "MEDIUMTEXT", "LONGTEXT", "BLOB", "LONGBLOB", "text"]) {
      expect(mysqlIndexPrefix(t, utf8mb4)).toBe(255);
    }
  });

  it("never prefixes numeric, ENUM, JSON, VECTOR or geometry columns", () => {
    for (const t of [
      "INT",
      "BIGINT UNSIGNED",
      "DOUBLE",
      "DECIMAL(10,2)",
      "TINYINT(1)",
      "ENUM('a','b')",
      "JSON",
      "VECTOR(3)",
      "POINT SRID 4326",
      "TIMESTAMP",
    ]) {
      expect(mysqlIndexPrefix(t, utf8mb4)).toBeUndefined();
    }
    expect(mysqlIndexPrefix("VARBINARY(100)", utf8mb4)).toBeUndefined();
    expect(mysqlIndexPrefix("VARBINARY(4000)", utf8mb4)).toBe(3072);
  });

  it("mysqlCharLength parses declared lengths", () => {
    expect(mysqlCharLength("VARCHAR(255)")).toBe(255);
    expect(mysqlCharLength("char(36)")).toBe(36);
    expect(mysqlCharLength("TEXT")).toBeUndefined();
  });
});
