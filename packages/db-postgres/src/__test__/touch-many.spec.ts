import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

let VersionedItemTable: any;

/** `touchMany` statement shape on PostgreSQL (recording driver, since 0.1.129). */
describe("PostgresAdapter touchMany", () => {
  let driver: ReturnType<typeof createMockDriver>;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    VersionedItemTable = (await import("./fixtures/version-occ.as")).VersionedItemTable;
  });

  beforeEach(() => {
    driver = createMockDriver({ getResult: { cnt: 2 }, runResult: { affectedRows: 2 } });
    table = new AtscriptDbTable(VersionedItemTable, new PostgresAdapter(driver));
  });

  const updates = () =>
    driver.calls.filter((c) => c.method === "run" && c.sql.startsWith("UPDATE"));

  it("counts the OR filter first, then one `SET version = version + 1` over the same predicate", async () => {
    const result = await table.touchMany([
      { id: 1, version: 4 },
      { id: 2, version: 0 },
    ] as any);
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });

    const count = driver.calls.find((c) => c.method === "get" && c.sql.includes("COUNT(*)"));
    expect(count).toBeDefined();
    expect(count!.sql).toContain(
      'WHERE ("id" = $1 AND "version" = $2 OR "id" = $3 AND "version" = $4)',
    );
    expect(count!.params).toEqual([1, 4, 2, 0]);

    const [stmt] = updates();
    expect(updates()).toHaveLength(1);
    expect(stmt!.sql).toBe(
      'UPDATE "versioned_items" SET "version" = "version" + 1 WHERE ("id" = $1 AND "version" = $2 OR "id" = $3 AND "version" = $4)',
    );
    expect(stmt!.params).toEqual([1, 4, 2, 0]);
    expect(driver.calls.some((c) => c.method === "exec" && c.sql.startsWith("COMMIT"))).toBe(true);
  });

  it("a short pre-count → CAS_MISMATCH, no UPDATE", async () => {
    driver = createMockDriver({ getResult: { cnt: 1 } });
    table = new AtscriptDbTable(VersionedItemTable, new PostgresAdapter(driver));
    const err = await table
      .touchMany([
        { id: 1, version: 4 },
        { id: 2, version: 0 },
      ] as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("CAS_MISMATCH");
    expect(updates()).toHaveLength(0);
  });

  it("a short affectedRows after the write → CAS_MISMATCH and ROLLBACK", async () => {
    driver = createMockDriver({ getResult: { cnt: 2 }, runResult: { affectedRows: 1 } });
    table = new AtscriptDbTable(VersionedItemTable, new PostgresAdapter(driver));
    const err = await table
      .touchMany([
        { id: 1, version: 4 },
        { id: 2, version: 0 },
      ] as any)
      .catch((e: unknown) => e);
    expect((err as DbError).code).toBe("CAS_MISMATCH");
    expect(driver.calls.some((c) => c.method === "exec" && c.sql.startsWith("ROLLBACK"))).toBe(
      true,
    );
  });
});
