import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { AtscriptDbTable, DbSpace } from "@atscript/db";
import dbPlugin from "@atscript/db/plugin";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { MysqlAdapter } from "../mysql-adapter";
import MysqlPlugin from "../plugin/index";
import { annotations } from "../plugin/annotations";
import { prepareFixtures, createMockDriver } from "./test-utils";

// `@db.mysql.engine`, `charset` and `onUpdate`: the listed values are
// completion hints, not a closed list. A value MySQL could never take
// fails the build; a name the server lacks fails the schema sync.

async function errorsFor(annotation: string, onInterface = false): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "mysql-hints-"));
  writeFileSync(
    join(rootDir, "fixture.as"),
    `
@db.table 'mh_t'
${onInterface ? annotation : ""}
export interface MhT {
    @meta.id
    id: number

    @db.mysql.type "TIMESTAMP(3)"
    ${onInterface ? "" : annotation}
    at?: number.timestamp
}
`,
  );
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin(), MysqlPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()]
    .flat()
    .filter((m) => m.severity === 1)
    .map((m) => m.message);
}

const scope = (name: "engine" | "charset" | "onUpdate") => {
  const arg = (annotations[name] as any).config.argument;
  return {
    values: arg.values,
    candidates: arg.valueScope().map((c: { value: string }) => c.value),
  };
};

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/on-update-precision.as");
});

describe("@db.mysql.onUpdate", () => {
  it.each([
    "CURRENT_TIMESTAMP",
    "CURRENT_TIMESTAMP()",
    "CURRENT_TIMESTAMP(3)",
    "current_timestamp(6)",
    "NOW()",
    "NOW(3)",
    "LOCALTIMESTAMP",
    "LOCALTIME(0)",
  ])("accepts %s", async (value) => {
    expect(await errorsFor(`@db.mysql.onUpdate "${value}"`)).toEqual([]);
  });

  it.each(["CURRENT_TIMESTAMP(7)", "NOW", "UTC_TIMESTAMP()", "CURRENT_TIMESTAMP; DROP TABLE x"])(
    "rejects %s",
    async (value) => {
      expect(await errorsFor(`@db.mysql.onUpdate "${value}"`)).toEqual([
        `@db.mysql.onUpdate takes CURRENT_TIMESTAMP, optionally with a precision 0–6 (CURRENT_TIMESTAMP(3)), got '${value}'`,
      ]);
    },
  );

  it("offers CURRENT_TIMESTAMP with and without a precision as completion", () => {
    expect(scope("onUpdate")).toEqual({
      values: undefined,
      candidates: ["CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP(3)", "CURRENT_TIMESTAMP(6)"],
    });
  });

  it("DDL: a written precision is kept, none takes the column's; renamed and nested columns keep the clause", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new MysqlAdapter(driver));
    await space.getTable(fx.OuEvent).dbAdapter.ensureTable();
    const create = driver.calls
      .filter((c) => c.method === "exec")
      .map((c) => c.sql)
      .find((s) => s.startsWith("CREATE TABLE"))!;
    expect(create).toContain(
      "`changedAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)",
    );
    expect(create).toContain("`touchedAt` DATETIME(6) ON UPDATE CURRENT_TIMESTAMP(6)");
    expect(create).toContain(
      "`updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
    );
    expect(create).toContain(
      "`audit__at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
    );
    // A character set without @db.mysql.collate takes the set's default
    // collation: no COLLATE of another set (MySQL ERROR 1253).
    expect(create).toMatch(/ ENGINE=innodb DEFAULT CHARSET=utf8mb3$/);
  });
});

describe("@db.mysql.engine / @db.mysql.charset", () => {
  it.each([
    `@db.mysql.engine "Aria"`,
    `@db.mysql.engine "BLACKHOLE"`,
    `@db.mysql.engine "innodb"`,
    `@db.mysql.charset "cp1251"`,
    `@db.mysql.charset "utf8mb3"`,
  ])("accepts %s (not limited to the completion list)", async (annotation) => {
    expect(await errorsFor(annotation, true)).toEqual([]);
  });

  it.each([
    [
      `@db.mysql.engine "Inno DB"`,
      `@db.mysql.engine takes a storage engine name (letters, digits, _), got 'Inno DB'`,
    ],
    [
      `@db.mysql.charset "utf-8"`,
      `@db.mysql.charset takes a character set name (letters, digits, _), got 'utf-8'`,
    ],
  ])("rejects %s (not a name)", async (annotation, message) => {
    expect(await errorsFor(annotation, true)).toEqual([message]);
  });

  it("offers the common names as completion, without closing the list", () => {
    expect(scope("engine").values).toBeUndefined();
    expect(scope("engine").candidates).toEqual(
      expect.arrayContaining(["InnoDB", "MyISAM", "Aria"]),
    );
    expect(scope("charset").values).toBeUndefined();
    expect(scope("charset").candidates).toEqual(
      expect.arrayContaining(["utf8mb4", "utf8mb3", "latin1", "cp1251"]),
    );
  });

  it("an engine / charset written in another case matches the server's spelling (no ALTER)", async () => {
    const driver = createMockDriver({
      get: [
        ["INFORMATION_SCHEMA.TABLES", { ENGINE: "InnoDB", TABLE_COLLATION: "utf8mb3_general_ci" }],
      ],
    });
    const adapter = new MysqlAdapter(driver);
    void new AtscriptDbTable(fx.OuEvent, adapter).fieldDescriptors; // builds the metadata
    const existing = await adapter.getExistingTableOptions();
    expect(existing.filter((o) => o.key !== "collation")).toEqual([
      { key: "engine", value: "innodb" },
      { key: "charset", value: "utf8mb3" },
    ]);
  });
});
