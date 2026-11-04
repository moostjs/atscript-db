import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable, DbSpace } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.169 an insert into a composite-primary-key table reports the
// primary-key object (logical field names). A composite key's AUTO_INCREMENT
// part is known from `insertId` for a one-row INSERT only; a multi-row INSERT
// cannot attribute it per row, so such rows report no id (fail closed).
// Before, every row reported `insertId` (+ its index). Over a recording driver.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/composite-insert-id.as");
});

function tableOf(type: unknown, insertId: number) {
  const driver = createMockDriver({ runResult: { insertId } });
  return new AtscriptDbTable(type as never, new MysqlAdapter(driver)) as any;
}

describe("[mysql] composite primary key — insertedId", () => {
  it("insertOne reports the primary-key object by logical field names", async () => {
    const table = tableOf(fx.CidPair, 0);
    expect(await table.insertOne({ left: 1, right: "a", label: "A" })).toEqual({
      insertedId: { left: 1, right: "a" },
    });
  });

  it("insertMany reports one primary-key object per row", async () => {
    const table = tableOf(fx.CidPair, 0);
    expect(
      await table.insertMany([
        { left: 1, right: "a", label: "A" },
        { left: 1, right: "b", label: "B" },
      ]),
    ).toEqual({
      insertedCount: 2,
      insertedIds: [
        { left: 1, right: "a" },
        { left: 1, right: "b" },
      ],
    });
  });

  it("onConflict: ignore reports the inserted rows' primary-key objects", async () => {
    const table = tableOf(fx.CidPair, 0);
    expect(
      await table.insertMany([{ left: 2, right: "c", label: "C" }], { onConflict: "ignore" }),
    ).toEqual({
      insertedCount: 1,
      insertedIds: [{ left: 2, right: "c" }],
      inserted: [0],
      conflicts: [],
    });
  });

  it("a one-row INSERT reports the AUTO_INCREMENT key part from insertId", async () => {
    const table = tableOf(fx.CidSeq, 7);
    expect(await table.insertOne({ tenant: "t1", label: "x" })).toEqual({
      insertedId: { tenant: "t1", seq: 7 },
    });
    expect(await table.insertMany([{ tenant: "t1", label: "y" }])).toEqual({
      insertedCount: 1,
      insertedIds: [{ tenant: "t1", seq: 7 }],
    });
  });

  it("a multi-row INSERT cannot attribute the generated part: no ids (fail closed)", async () => {
    const table = tableOf(fx.CidSeq, 7);
    expect(
      await table.insertMany([
        { tenant: "t1", label: "x" },
        { tenant: "t1", seq: 3, label: "explicit" },
      ]),
    ).toEqual({ insertedCount: 2, insertedIds: [undefined, { tenant: "t1", seq: 3 }] });
  });

  it("a single primary key keeps its scalar id", async () => {
    const table = tableOf(fx.CidSingle, 5);
    expect(await table.insertOne({ label: "a" })).toEqual({ insertedId: 5 });
  });
});

describe("[mysql] composite primary key — read form, explicit 0, nested children", () => {
  it("a DATETIME key part is reported as epoch ms, the form reads answer", async () => {
    const at = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
    const table = tableOf(fx.CidStamp, 0);
    expect(await table.insertOne({ tenant: "t1", at, label: "x" })).toEqual({
      insertedId: { tenant: "t1", at },
    });
  });

  it("a single DATETIME primary key is reported as epoch ms too", async () => {
    const at = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
    expect(await tableOf(fx.CidStampSingle, 0).insertOne({ at, label: "x" })).toEqual({
      insertedId: at,
    });
  });

  it("an explicit 0 in the AUTO_INCREMENT part counts as absent", async () => {
    // One-row INSERT: the part MySQL generated (insertId).
    expect(await tableOf(fx.CidSeq, 7).insertOne({ tenant: "t1", seq: 0, label: "x" })).toEqual({
      insertedId: { tenant: "t1", seq: 7 },
    });
    // Multi-row INSERT: not attributable → no id, never `seq: 0`.
    expect(
      (
        await tableOf(fx.CidSeq, 7).insertMany([
          { tenant: "t1", seq: 0, label: "x" },
          { tenant: "t1", seq: 3, label: "y" },
        ])
      ).insertedIds,
    ).toEqual([undefined, { tenant: "t1", seq: 3 }]);
  });

  it("children of multi-row parents whose generated key part is unknown: refused, not orphaned", async () => {
    const driver = createMockDriver({ runResult: { insertId: 7 } });
    const space = new DbSpace(() => new MysqlAdapter(driver));
    const parents = space.getTable(fx.CidSeq) as any;
    const error = await parents
      .insertMany([
        { tenant: "t1", label: "x", kids: [{ note: "a" }] },
        { tenant: "t1", label: "y", kids: [{ note: "b" }] },
      ])
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((error as { code?: string } | undefined)?.code).toBe("FK_VIOLATION");
    const kidInserts = driver.calls.filter((c) => c.sql.startsWith("INSERT INTO `cid_seq_kids`"));
    expect(kidInserts).toEqual([]);
  });
});
