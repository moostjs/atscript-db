import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable, DbSpace } from "@atscript/db";

import { mysqlOnUpdateExpr, mysqlName } from "../annotation-values";
import { MysqlAdapter } from "../mysql-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// `@db.mysql.charset` (Interface and Field): a table charset without
// `@db.mysql.collate` takes the charset's default collation (no COLLATE of
// another set — MySQL ERROR 1253), a column charset renders
// `CHARACTER SET <cs>` on character columns.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/charsets.as");
});

async function createSql(type: unknown): Promise<string> {
  const driver = createMockDriver();
  const space = new DbSpace(() => new MysqlAdapter(driver));
  await space.getTable(type as never).dbAdapter.ensureTable();
  return driver.calls
    .filter((c) => c.method === "exec")
    .map((c) => c.sql)
    .find((s) => s.startsWith("CREATE TABLE"))!;
}

function desiredOptions(type: unknown) {
  const adapter = new MysqlAdapter(createMockDriver());
  void new AtscriptDbTable(type as never, adapter).fieldDescriptors; // builds the metadata
  return adapter.getDesiredTableOptions();
}

describe("table-level @db.mysql.charset", () => {
  it("without a collation: no COLLATE, and the collation is not compared", async () => {
    expect(await createSql(fx.CsLatin)).toMatch(/ ENGINE=InnoDB DEFAULT CHARSET=latin1$/);
    expect(desiredOptions(fx.CsLatin)).toEqual([
      { key: "engine", value: "InnoDB" },
      { key: "charset", value: "latin1" },
    ]);
  });

  it("with @db.mysql.collate: that collation", async () => {
    expect(await createSql(fx.CsLatinSwedish)).toMatch(
      / DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci$/,
    );
  });

  it("the default stays utf8mb4 with utf8mb4_unicode_ci", async () => {
    expect(await createSql(fx.CsDefault)).toMatch(
      / DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci$/,
    );
    expect(desiredOptions(fx.CsDefault)).toEqual([
      { key: "engine", value: "InnoDB" },
      { key: "charset", value: "utf8mb4" },
      { key: "collation", value: "utf8mb4_unicode_ci" },
    ]);
  });
});

describe("field-level @db.mysql.charset", () => {
  it("renders CHARACTER SET on character columns, a portable collation in that set", async () => {
    const sql = await createSql(fx.CsColumns);
    expect(sql).toContain("`legacy` TEXT CHARACTER SET latin1 NOT NULL,");
    expect(sql).toContain(
      "`legacyNocase` TEXT CHARACTER SET latin1 NOT NULL COLLATE latin1_general_ci,",
    );
    expect(sql).toContain("`legacyBin` TEXT CHARACTER SET latin1 NOT NULL COLLATE latin1_bin,");
    expect(sql).toContain("`count` DOUBLE NOT NULL,");
    expect(sql).toContain("`plain` TEXT NOT NULL)");
  });
});

describe("names reaching the DDL", () => {
  it("a name or an ON UPDATE expression the compiler would refuse throws", () => {
    expect(mysqlName("@db.mysql.charset", "latin1")).toBe("latin1");
    expect(() => mysqlName("@db.mysql.engine", "InnoDB; DROP TABLE x")).toThrow(/not a MySQL name/);
    expect(mysqlOnUpdateExpr("CURRENT_TIMESTAMP(3)", "CURRENT_TIMESTAMP")).toBe(
      "CURRENT_TIMESTAMP(3)",
    );
    expect(() => mysqlOnUpdateExpr("NOW(); DROP TABLE x", "CURRENT_TIMESTAMP")).toThrow(
      /not CURRENT_TIMESTAMP/,
    );
  });
});
