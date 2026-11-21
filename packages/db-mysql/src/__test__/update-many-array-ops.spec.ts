import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";

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
describe("MysqlAdapter updateMany with array operators", () => {
  const make = (changedRows: (sql: string, params?: unknown[]) => number = () => 1) => {
    driver = createMockDriver({
      // the pick reads the keys; the batch read the keys and `tags`
      all: [
        [
          "`tags`",
          [
            { id: 1, tags: ["a"] },
            { id: 2, tags: [] },
          ],
        ],
      ],
      allResult: [{ id: 1 }, { id: 2 }],
      runResponder: (sql, params) => ({ affectedRows: 1, changedRows: changedRows(sql, params) }),
    });
    table = new AtscriptDbTable(VxRecord, new MysqlAdapter(driver));
  };
  beforeEach(() => make());

  it("reads the keys and then each row's array, both FOR UPDATE, and writes each row by its key", async () => {
    const result = await table.updateMany(
      { status: "open" } as any,
      { title: "t", tags: { $insert: ["x"] } } as any,
    );
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    const update =
      "UPDATE `vx_records` SET `title` = ?, `tags` = ?, `version` = `version` + 1 WHERE `id` = ?";
    expect(shape()).toEqual([
      ["exec", "START TRANSACTION", undefined],
      [
        "all",
        "SELECT `id` FROM `vx_records` WHERE `status` = ? ORDER BY `id` ASC FOR UPDATE",
        ["open"],
      ],
      ["all", "SELECT `id`, `tags` FROM `vx_records` WHERE `id` IN (?, ?) FOR UPDATE", [1, 2]],
      ["run", update, ["t", '["a","x"]', 1]],
      ["run", update, ["t", '["x"]', 2]],
      ["exec", "COMMIT", undefined],
    ]);
  });

  it("the counts sum the row writes: matched = found rows, modified = changed rows", async () => {
    // a version-exempt patch that leaves row 2 as it was: MySQL reports it unchanged
    make((_sql, params) => (params?.at(-1) === 2 ? 0 : 1));
    const result = await table.updateMany(
      { status: "open" } as any,
      {
        tags: { $remove: ["a"] },
      } as any,
    );
    expect(result).toEqual({ matchedCount: 2, modifiedCount: 1 });
    expect(driver.calls.filter((c) => c.method === "run").map((c) => c.sql)).toEqual([
      "UPDATE `vx_records` SET `tags` = ? WHERE `id` = ?",
      "UPDATE `vx_records` SET `tags` = ? WHERE `id` = ?",
    ]);
  });

  it("a bounded write picks `limit` keys locked — no `ORDER BY … LIMIT` UPDATE", async () => {
    await table.updateMany({ status: "open" } as any, { tags: { $insert: ["x"] } } as any, {
      limit: 1,
    });
    const reads = driver.calls.filter((c) => c.method === "all");
    expect(reads[0]!.sql).toBe(
      "SELECT `id` FROM `vx_records` WHERE `status` = ? ORDER BY `id` ASC LIMIT ? FOR UPDATE",
    );
    expect(reads[1]!.sql).toBe(
      "SELECT `id`, `tags` FROM `vx_records` WHERE `status` = ? AND `id` IN (?, ?) FOR UPDATE",
    );
    for (const c of driver.calls.filter((call) => call.method === "run")) {
      expect(c.sql).toBe("UPDATE `vx_records` SET `tags` = ? WHERE `id` = ?");
    }
  });

  it("without array operators: one UPDATE, unchanged", async () => {
    await table.updateMany({ status: "open" } as any, { title: "t", tags: ["a"] } as any);
    expect(shape()).toEqual([
      [
        "run",
        "UPDATE `vx_records` SET `title` = ?, `tags` = ?, `version` = `version` + 1 WHERE `status` = ?",
        ["t", '["a"]', "open"],
      ],
    ]);
  });
});

// The single-row read-modify-write (`updateOne` / `bulkUpdate` with array
// operators) reads its row `FOR UPDATE` since 0.1.182: a concurrent patch of
// the same row waits instead of being overwritten.
describe("MysqlAdapter single-row array operators lock the row they read", () => {
  const read = "SELECT * FROM `vx_records` WHERE `id` = ? LIMIT ? FOR UPDATE";

  beforeEach(() => {
    driver = createMockDriver({ getResult: { id: 1, tags: ["a"], version: 3 } });
    table = new AtscriptDbTable(VxRecord, new MysqlAdapter(driver));
  });

  it("updateOne: the read locks the row inside the write's transaction", async () => {
    await table.updateOne({ id: 1, tags: { $insert: ["x"] } } as any);
    expect(shape()).toEqual([
      ["exec", "START TRANSACTION", undefined],
      ["get", read, [1, 1]],
      ["run", "UPDATE `vx_records` SET `tags` = ? WHERE `id` = ? LIMIT 1", ['["a","x"]', 1]],
      ["exec", "COMMIT", undefined],
    ]);
  });

  it("a $cas patch: locked read, then the version-checked write", async () => {
    await table.updateOne({ id: 1, tags: { $insert: ["x"] }, $cas: { version: 3 } } as any);
    expect(shape().slice(1, 3)).toEqual([
      ["get", read, [1, 1]],
      [
        "run",
        "UPDATE `vx_records` SET `tags` = ?, `version` = `version` + 1 WHERE `id` = ? AND `version` = ? LIMIT 1",
        ['["a","x"]', 1, 3],
      ],
    ]);
  });

  it("bulkUpdate: one locked read per row, in one transaction", async () => {
    await table.bulkUpdate([
      { id: 1, tags: { $insert: ["x"] } },
      { id: 2, tags: { $remove: ["a"] } },
    ] as any);
    expect(driver.calls.filter((c) => c.method === "get").map((c) => [c.sql, c.params])).toEqual([
      [read, [1, 1]],
      [read, [2, 1]],
    ]);
    expect(driver.calls.filter((c) => c.method === "exec").map((c) => c.sql)).toEqual([
      "START TRANSACTION",
      "COMMIT",
    ]);
  });
});
