import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

let VxRecord: any;
let driver: ReturnType<typeof createMockDriver>;
let table: AtscriptDbTable;

beforeAll(async () => {
  await prepareFixtures();
  VxRecord = (await import("./fixtures/version-exempt.as")).VxRecord;
});

/** The recorded driver calls: [method, sql, params]. */
const shape = () => driver.calls.map((c) => [c.method, c.sql, c.params]);

// `updateMany` with array operators (since 0.1.182) — recording-driver SQL:
// one transaction; the matched keys read `FOR UPDATE` in key order, the
// operator columns read by key (`FOR UPDATE` too: a plain read could return
// an older snapshot of a caller's REPEATABLE READ transaction), then one
// UPDATE per row by its primary key.
describe("PostgresAdapter updateMany with array operators", () => {
  beforeEach(() => {
    driver = createMockDriver({
      // the pick reads the keys; the batch read the keys and `tags`
      allResult: (sql) =>
        sql.includes('"tags"')
          ? [
              { id: 1, tags: ["a"] },
              { id: 2, tags: [] },
            ]
          : [{ id: 1 }, { id: 2 }],
    });
    table = new AtscriptDbTable(VxRecord, new PostgresAdapter(driver));
  });

  it("reads the keys and then each row's array, both FOR UPDATE, and writes each row by its key", async () => {
    const result = await table.updateMany(
      { status: "open" } as any,
      { title: "t", tags: { $insert: ["x"] } } as any,
    );
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    const update =
      'UPDATE "vx_records" SET "title" = $1, "tags" = $2, "version" = "version" + 1 WHERE "id" = $3';
    expect(shape()).toEqual([
      ["exec", "BEGIN", undefined],
      [
        "all",
        'SELECT "id" FROM "vx_records" WHERE "status" = $1 ORDER BY "id" ASC FOR UPDATE',
        ["open"],
      ],
      ["all", 'SELECT "id", "tags" FROM "vx_records" WHERE "id" IN ($1, $2) FOR UPDATE', [1, 2]],
      ["run", update, ["t", '["a","x"]', 1]],
      ["run", update, ["t", '["x"]', 2]],
      ["exec", "COMMIT", undefined],
    ]);
  });

  it("a version-exempt patch writes no bump", async () => {
    await table.updateMany({ status: "open" } as any, { tags: { $remove: ["a"] } } as any);
    const writes = driver.calls.filter((c) => c.method === "run");
    expect(writes.map((c) => c.sql)).toEqual([
      'UPDATE "vx_records" SET "tags" = $1 WHERE "id" = $2',
      'UPDATE "vx_records" SET "tags" = $1 WHERE "id" = $2',
    ]);
  });

  it("a bounded write picks `limit` keys locked and re-checks the filter on the locked batch read", async () => {
    await table.updateMany({ status: "open" } as any, { tags: { $insert: ["x"] } } as any, {
      limit: 1,
    });
    const reads = driver.calls.filter((c) => c.method === "all");
    expect(reads[0]!.sql).toBe(
      'SELECT "id" FROM "vx_records" WHERE "status" = $1 ORDER BY "id" ASC LIMIT $2 FOR UPDATE',
    );
    expect(reads[1]!.sql).toBe(
      'SELECT "id", "tags" FROM "vx_records" WHERE "status" = $1 AND "id" IN ($2, $3) FOR UPDATE',
    );
    // no native `LIMIT` subquery on the row writes
    for (const c of driver.calls.filter((call) => call.method === "run")) {
      expect(c.sql).toBe('UPDATE "vx_records" SET "tags" = $1 WHERE "id" = $2');
    }
  });

  it("without array operators: one UPDATE, unchanged", async () => {
    await table.updateMany({ status: "open" } as any, { title: "t", tags: ["a"] } as any);
    expect(shape()).toEqual([
      [
        "run",
        'UPDATE "vx_records" SET "title" = $1, "tags" = $2, "version" = "version" + 1 WHERE "status" = $3',
        ["t", '["a"]', "open"],
      ],
    ]);
  });
});

// The single-row read-modify-write (`updateOne` / `bulkUpdate` with array
// operators) reads its row `FOR UPDATE` since 0.1.182: a concurrent patch of
// the same row waits instead of being overwritten under READ COMMITTED.
describe("PostgresAdapter single-row array operators lock the row they read", () => {
  const read = 'SELECT * FROM "vx_records" WHERE "id" = $1 LIMIT $2 FOR UPDATE';

  const make = (row: Record<string, unknown> | null, affectedRows = 1) => {
    driver = createMockDriver({ getResult: row, runResult: { affectedRows } });
    table = new AtscriptDbTable(VxRecord, new PostgresAdapter(driver));
  };

  it("updateOne: the read locks the row inside the write's transaction", async () => {
    make({ id: 1, tags: ["a"], version: 3 });
    await table.updateOne({ id: 1, tags: { $insert: ["x"] } } as any);
    expect(shape()).toEqual([
      ["exec", "BEGIN", undefined],
      ["get", read, [1, 1]],
      ["run", 'UPDATE "vx_records" SET "tags" = $1 WHERE "id" = $2', ['["a","x"]', 1]],
      ["exec", "COMMIT", undefined],
    ]);
  });

  it("a $cas patch: locked read, then the version-checked write", async () => {
    make({ id: 1, tags: ["a"], version: 3 });
    await table.updateOne({ id: 1, tags: { $insert: ["x"] }, $cas: { version: 3 } } as any);
    expect(shape().slice(1, 3)).toEqual([
      ["get", read, [1, 1]],
      [
        "run",
        'UPDATE "vx_records" SET "tags" = $1, "version" = "version" + 1 WHERE "id" = $2 AND "version" = $3',
        ['["a","x"]', 1, 3],
      ],
    ]);
  });

  it("bulkUpdate: one locked read per row, in payload order, in one transaction", async () => {
    make({ id: 1, tags: ["a"] });
    await table.bulkUpdate([
      { id: 1, tags: { $insert: ["x"] } },
      { id: 2, tags: { $remove: ["a"] } },
    ] as any);
    expect(driver.calls.filter((c) => c.method === "get").map((c) => [c.sql, c.params])).toEqual([
      [read, [1, 1]],
      [read, [2, 1]],
    ]);
    expect(driver.calls.filter((c) => c.method === "exec").map((c) => c.sql)).toEqual([
      "BEGIN",
      "COMMIT",
    ]);
  });

  it("a row gone before the read: { 0, 0 }", async () => {
    make(null, 0);
    expect(await table.updateOne({ id: 9, tags: { $insert: ["x"] } } as any)).toEqual({
      matchedCount: 0,
      modifiedCount: 0,
    });
  });
});
