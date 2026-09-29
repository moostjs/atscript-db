import { DbError } from "@atscript/db";
import type { AtscriptDbTable, BaseDbAdapter, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// `@db.column 'row_version'` on the logical `version` field: the table API
// speaks `version` ($cas key, rows read back); the memory adapter bumps,
// CASes, and backfills the PHYSICAL `row_version` key of its stored rows
// (`versionColumnPhysical`). ≤ 0.1.140 mixed the two and broke OCC.

let RenamedVersion: any;

describe("MemoryAdapter — OCC on a @db.column-renamed version column", () => {
  let space: DbSpace;
  let table: AtscriptDbTable;
  let adapter: BaseDbAdapter;

  beforeAll(async () => {
    await prepareFixtures();
    RenamedVersion = (await import("./fixtures/stored.as")).RenamedVersion;
  });

  beforeEach(async () => {
    space = createTestSpace();
    table = space.getTable(RenamedVersion);
    adapter = space.getAdapter(RenamedVersion);
    await bootstrapStoredTables(space, [RenamedVersion]);
    await table.insertOne({ id: 1, name: "Ada", counter: 0 } as any);
  });

  const read = async () => (await table.findOne({ filter: { id: 1 }, controls: {} })) as any;
  /** The stored row in its physical shape (adapter-level read). */
  const stored = async () => (await adapter.findOne({ filter: { id: 1 }, controls: {} })) as any;

  it("exposes logical versionColumn and physical versionColumnPhysical", () => {
    expect(table.versionColumn).toBe("version");
    expect(table.versionColumnPhysical).toBe("row_version");
  });

  it("backfills the physical key to 0 on insert and reads back the logical field", async () => {
    const raw = await stored();
    expect(raw.row_version).toBe(0);
    expect(raw).not.toHaveProperty("version");
    const row = await read();
    expect(row.version).toBe(0);
    expect(row).not.toHaveProperty("row_version");
  });

  it("auto-bumps the physical key on a plain update", async () => {
    await table.updateOne({ id: 1, name: "B" } as any);
    expect((await stored()).row_version).toBe(1);
    expect((await read()).version).toBe(1);
  });

  it("fresh `$cas: { version }` applies and bumps; stale reports { 0, 0 }", async () => {
    const fresh = await table.updateOne({ id: 1, name: "B", $cas: { version: 0 } } as any);
    expect(fresh).toEqual({ matchedCount: 1, modifiedCount: 1 });
    const stale = await table.updateOne({ id: 1, name: "C", $cas: { version: 0 } } as any);
    expect(stale).toEqual({ matchedCount: 0, modifiedCount: 0 });
    expect(await read()).toMatchObject({ name: "B", version: 1 });
  });

  it("replaceOne CASes on the physical key", async () => {
    const stale = await table.replaceOne({
      id: 1,
      name: "X",
      counter: 9,
      $cas: { version: 4 },
    } as any);
    expect(stale.matchedCount).toBe(0);
    const fresh = await table.replaceOne({
      id: 1,
      name: "R",
      counter: 9,
      $cas: { version: 0 },
    } as any);
    expect(fresh.matchedCount).toBe(1);
    expect(await read()).toMatchObject({ name: "R", counter: 9, version: 1 });
  });

  it("rejects a direct write to the logical version field", async () => {
    await expect(table.updateOne({ id: 1, version: 7 } as any)).rejects.toThrow(DbError);
    expect((await stored()).row_version).toBe(0);
  });

  it("touch + bulk mixed + updateMany bump the physical key", async () => {
    await table.insertOne({ id: 2, name: "B", counter: 0 } as any);
    expect(await table.updateOne({ id: 1, $cas: { version: 0 } } as any)).toEqual({
      matchedCount: 1,
      modifiedCount: 1,
    });
    const bulk = await table.bulkUpdate([
      { id: 1, name: "A2", $cas: { version: 1 } },
      { id: 2, name: "B2", $cas: { version: 9 } },
    ] as any[]);
    expect(bulk).toEqual({ matchedCount: 1, modifiedCount: 1 });
    await table.updateMany({ counter: 0 } as any, { name: "all" } as any);
    const rows = (await adapter.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows.map((r) => [r.id, r.row_version])).toEqual([
      [1, 3],
      [2, 1],
    ]);
  });
});
