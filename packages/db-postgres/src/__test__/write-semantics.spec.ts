import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

let VersionedItemTable: any;
let TokenTable: any;

/**
 * Recording-driver assertions for the write-semantics changes (since 0.1.128):
 * the versioned touch SQL for an empty patch with `$cas`, the count path for
 * an empty patch without it, and pruned `undefined` props on INSERT / UPDATE.
 */
describe("PostgresAdapter write semantics", () => {
  let driver: ReturnType<typeof createMockDriver>;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    VersionedItemTable = (await import("./fixtures/version-occ.as")).VersionedItemTable;
    TokenTable = (await import("./fixtures/default-fns.as")).TokenTable;
  });

  beforeEach(() => {
    driver = createMockDriver({ getResult: { cnt: 1 } });
    table = new AtscriptDbTable(VersionedItemTable, new PostgresAdapter(driver));
  });

  const updates = () =>
    driver.calls.filter((c) => c.method === "run" && c.sql.startsWith("UPDATE"));

  it('empty patch + $cas emits `SET "version" = "version" + 1 … AND "version" = $n` (versioned touch)', async () => {
    const result = await table.updateOne({ id: 1, $cas: { version: 4 } } as any);
    const [call] = updates();
    expect(call).toBeDefined();
    expect(call!.sql).toMatch(/SET "version" = "version" \+ 1 WHERE/);
    expect(call!.sql).toMatch(/AND "version" = \$\d/);
    expect(call!.params).toEqual([1, 4]);
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
  });

  it("empty patch without $cas issues a COUNT, never an UPDATE", async () => {
    const result = await table.updateOne({ id: 1 } as any);
    expect(updates()).toHaveLength(0);
    const count = driver.calls.find((c) => c.method === "get" && c.sql.includes("COUNT(*)"));
    expect(count).toBeDefined();
    expect(count!.params).toEqual([1]);
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 0 });
  });

  // Since 0.1.128 a static `@db.default` is filled SDK-side on every adapter
  // (`cap` → 10000, identical to the DDL DEFAULT); an undefined optional column
  // without a default is still pruned from the INSERT.
  it("INSERT prunes undefined columns: defaulted one SDK-filled, optional one omitted", async () => {
    await table.insertOne({ id: 1, name: "a", cap: undefined, note: undefined } as any);
    const insert = driver.calls.find((c) => c.method === "run" && c.sql.startsWith("INSERT"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('"name"');
    expect(insert!.sql).toContain('"cap"');
    expect(insert!.sql).not.toContain('"note"');
    expect(insert!.params).toEqual([1, "a", 10000]);
  });

  it("UPDATE never SETs an undefined column; null is an explicit SET", async () => {
    await table.updateOne({ id: 1, name: "b", note: undefined } as any);
    let [call] = updates();
    expect(call!.sql).toMatch(/SET "name" = \$1, "version" = "version" \+ 1 WHERE/);
    expect(call!.sql).not.toContain('"note"');

    driver.calls.length = 0;
    await table.updateOne({ id: 1, note: null } as any);
    [call] = updates();
    expect(call!.sql).toContain('"note" = $1');
    expect(call!.params![0]).toBeNull();
  });

  it("updateMany with an empty patch counts instead of emitting `UPDATE … SET  WHERE`", async () => {
    const result = await table.updateMany({ name: "a" } as any, { note: undefined } as any);
    expect(updates()).toHaveLength(0);
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 0 });
  });

  // ── Full replace (since 0.1.128) ──────────────────────────────────────────

  it("replaceOne assigns EVERY column: omitted optional → NULL, static default filled, CAS kept", async () => {
    const result = await table.replaceOne({ id: 1, name: "a", $cas: { version: 4 } } as any);
    const [call] = updates();
    expect(call).toBeDefined();
    // The PK stays in the SET list (pre-existing: the row is matched by the
    // filter), `cap` comes from the SDK-side value default, `note` is the null fill.
    expect(call!.sql).toBe(
      'UPDATE "versioned_items" SET "id" = $1, "name" = $2, "cap" = $3, "note" = $4, "version" = "version" + 1 WHERE "id" = (SELECT "id" FROM "versioned_items" WHERE "id" = $5 LIMIT 1) AND "version" = $6',
    );
    expect(call!.params).toEqual([1, "a", 10000, null, 1, 4]);
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
  });

  it("replaceOne hands a native function default back to the engine (`SET col = DEFAULT`)", async () => {
    const tokens = new AtscriptDbTable(TokenTable, new PostgresAdapter(driver));
    await tokens.replaceOne({ id: "t-1", label: "x" } as any);
    const [call] = updates();
    expect(call).toBeDefined();
    // `createdAt` (@db.default.now) is native on PostgreSQL: no param, DEFAULT keyword.
    expect(call!.sql).toBe(
      'UPDATE "tokens" SET "id" = $1, "label" = $2, "createdAt" = DEFAULT WHERE "id" = (SELECT "id" FROM "tokens" WHERE "id" = $3 LIMIT 1)',
    );
    expect(call!.params).toEqual(["t-1", "x", "t-1"]);
  });
});
