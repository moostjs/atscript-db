import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";
import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

let AccountTable: any;

describe("@db.column.collate", () => {
  let driver: BetterSqlite3Driver;
  let adapter: SqliteAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/collate.as");
    AccountTable = fixtures.AccountTable;
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");
    adapter = new SqliteAdapter(driver);
  });

  afterEach(() => {
    driver.close();
  });

  it("should include COLLATE NOCASE in CREATE TABLE DDL", async () => {
    const table = new AtscriptDbTable(AccountTable, adapter);
    await table.ensureTable();

    // Inspect the DDL used to create the table
    const row = driver.get<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'`,
    );
    expect(row?.sql).toContain("COLLATE NOCASE");
  });

  it("should make queries case-insensitive on collated field", async () => {
    const table = new AtscriptDbTable(AccountTable, adapter);
    await table.ensureTable();

    await table.insertOne({ nickname: "AlIcE", email: "alice@test.com" } as any);

    // Query with lowercase — should match due to NOCASE collation
    const result = await table.findMany({
      filter: { nickname: { $eq: "alice" } },
      controls: {},
    });
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).nickname).toBe("AlIcE");
  });

  it("should not affect non-collated fields", async () => {
    const table = new AtscriptDbTable(AccountTable, adapter);
    await table.ensureTable();

    await table.insertOne({ nickname: "Bob", email: "Bob@Test.com" } as any);

    // email has no collation — default BINARY, case-sensitive
    const result = await table.findMany({
      filter: { email: { $eq: "bob@test.com" } },
      controls: {},
    });
    expect(result).toHaveLength(0);
  });

  it("should propagate collate to fieldDescriptors", () => {
    const table = new AtscriptDbTable(AccountTable, adapter);
    const nicknameField = table.fieldDescriptors.find((f) => f.path === "nickname");
    const emailField = table.fieldDescriptors.find((f) => f.path === "email");

    expect(nicknameField?.collate).toBe("nocase");
    expect(emailField?.collate).toBeUndefined();
  });
});
