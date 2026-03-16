import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";
import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

let TokenTable: any;
let CounterTable: any;
let SimpleCounterTable: any;

describe("@db.default function defaults", () => {
  let driver: BetterSqlite3Driver;
  let adapter: SqliteAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/default-fns.as");
    TokenTable = fixtures.TokenTable;
    CounterTable = fixtures.CounterTable;
    SimpleCounterTable = fixtures.SimpleCounterTable;
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");
    adapter = new SqliteAdapter(driver);
  });

  afterEach(() => {
    driver.close();
  });

  describe("@db.default.uuid", () => {
    let table: AtscriptDbTable;

    beforeEach(async () => {
      table = new AtscriptDbTable(TokenTable, adapter);
      await table.ensureTable();
    });

    it("should auto-generate a UUID when id is not provided", async () => {
      const result = await table.insertOne({ label: "test-token" } as any);

      // The insertedId should be a UUID string
      expect(result.insertedId).toBeDefined();
      expect(typeof result.insertedId).toBe("string");
      expect(result.insertedId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      // Verify the row in the DB has the UUID
      const row = driver.get(`SELECT * FROM tokens WHERE id = ?`, [result.insertedId]);
      expect(row).toBeDefined();
      expect(row?.label).toBe("test-token");
    });

    it("should generate unique UUIDs for multiple inserts", async () => {
      const r1 = await table.insertOne({ label: "a" } as any);
      const r2 = await table.insertOne({ label: "b" } as any);

      expect(r1.insertedId).not.toBe(r2.insertedId);
    });

    it("should honor explicit id values", async () => {
      const explicitId = "my-custom-id-123";
      await table.insertOne({ id: explicitId, label: "explicit" } as any);

      const row = driver.get(`SELECT * FROM tokens WHERE id = ?`, [explicitId]);
      expect(row).toBeDefined();
      expect(row?.label).toBe("explicit");
    });
  });

  describe("@db.default.increment with start value", () => {
    let table: AtscriptDbTable;

    beforeEach(async () => {
      table = new AtscriptDbTable(CounterTable, adapter);
      await table.ensureTable();
    });

    it("should start auto-increment at the specified start value (1000)", async () => {
      const result = await table.insertOne({ label: "first" } as any);

      expect(result.insertedId).toBeGreaterThanOrEqual(1000);
    });

    it("should increment sequentially from start value", async () => {
      const r1 = await table.insertOne({ label: "first" } as any);
      const r2 = await table.insertOne({ label: "second" } as any);
      const r3 = await table.insertOne({ label: "third" } as any);

      expect(r1.insertedId).toBeGreaterThanOrEqual(1000);
      expect(r2.insertedId).toBe((r1.insertedId as number) + 1);
      expect(r3.insertedId).toBe((r1.insertedId as number) + 2);
    });

    it("should honor explicit id values", async () => {
      await table.insertOne({ id: 42, label: "explicit" } as any);

      const row = driver.get(`SELECT * FROM counters WHERE id = 42`);
      expect(row).toBeDefined();
      expect(row?.label).toBe("explicit");
    });
  });

  describe("@db.default.increment without start value", () => {
    let table: AtscriptDbTable;

    beforeEach(async () => {
      table = new AtscriptDbTable(SimpleCounterTable, adapter);
      await table.ensureTable();
    });

    it("should auto-increment from 1 by default", async () => {
      const r1 = await table.insertOne({ label: "first" } as any);
      const r2 = await table.insertOne({ label: "second" } as any);

      expect(r1.insertedId).toBe(1);
      expect(r2.insertedId).toBe(2);
    });
  });
});
