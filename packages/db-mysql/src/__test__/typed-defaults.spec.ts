import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// `@db.default 0` / `true` / `"active"` / `10.50` render the same DDL
// DEFAULT as the string spelling (`@db.default "0"` …).

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/typed-defaults.as");
});

describe("MysqlAdapter — typed @db.default literals", () => {
  it("CREATE TABLE renders each literal as a typed DEFAULT", async () => {
    const driver = createMockDriver();
    const space = new DbSpace(() => new MysqlAdapter(driver));
    await space.getTable(fx.TypedDefaults).dbAdapter.ensureTable();
    const create = driver.calls
      .filter((c) => c.method === "exec")
      .map((c) => c.sql)
      .find((s) => s.startsWith("CREATE TABLE"));
    expect(create).toMatchInlineSnapshot(
      `"CREATE TABLE IF NOT EXISTS \`typed_defaults\` (\`id\` DOUBLE PRIMARY KEY, \`attempts\` INT NOT NULL DEFAULT 0, \`delta\` DOUBLE NOT NULL DEFAULT -1.5, \`enabled\` TINYINT(1) NOT NULL DEFAULT 1, \`archived\` TINYINT(1) NOT NULL DEFAULT 0, \`status\` VARCHAR(255) NOT NULL DEFAULT 'active', \`price\` DECIMAL(10,2) NOT NULL DEFAULT 10.5) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"`,
    );
  });
});
