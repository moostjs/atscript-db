import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

// Since 0.1.169 an insert into a composite-primary-key table reports the
// primary-key object (logical field names) — every part from the row or the
// `RETURNING` row, so a server-generated part (identity, native uuid) is
// known. Before, the FIRST returned column alone. Over a recording driver.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/composite-insert-id.as");
});

/** A table whose INSERT … RETURNING answers `returned(params)`. */
function tableOf(type: unknown, returned: (params: unknown[]) => Array<Record<string, unknown>>) {
  const driver = createMockDriver({
    runResponder: (sql, params) =>
      sql.startsWith("INSERT") ? { rows: returned(params ?? []) } : {},
  });
  return { table: new AtscriptDbTable(type as never, new PostgresAdapter(driver)) as any, driver };
}

describe("[postgres] composite primary key — insertedId", () => {
  it("insertOne reports the primary-key object by logical field names", async () => {
    const { table, driver } = tableOf(fx.CidPair, () => [{ left: 1, right_key: "a" }]);
    expect(await table.insertOne({ left: 1, right: "a", label: "A" })).toEqual({
      insertedId: { left: 1, right: "a" },
    });
    const insert = driver.calls.find((c) => c.sql.startsWith("INSERT"))!;
    expect(insert.sql).toMatch(/RETURNING "left", "right_key"$/);
  });

  it("insertMany reports one primary-key object per row", async () => {
    const { table } = tableOf(fx.CidPair, () => [
      { left: 1, right_key: "a" },
      { left: 1, right_key: "b" },
    ]);
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
    const { table } = tableOf(fx.CidPair, () => [{ left: 2, right_key: "c", code: null }]);
    expect(
      await table.insertMany(
        [
          { left: 1, right: "a", label: "dup" },
          { left: 2, right: "c", label: "C" },
        ],
        { onConflict: "ignore" },
      ),
    ).toEqual({
      insertedCount: 1,
      insertedIds: [{ left: 2, right: "c" }],
      inserted: [1],
      conflicts: [0],
    });
  });

  it("a server-generated key part comes from RETURNING", async () => {
    const { table } = tableOf(fx.CidSeq, () => [{ tenant: "t1", seq: 7 }]);
    expect(await table.insertOne({ tenant: "t1", label: "x" })).toEqual({
      insertedId: { tenant: "t1", seq: 7 },
    });
  });

  it("a part RETURNING does not report: no id (fail closed)", async () => {
    const { table } = tableOf(fx.CidSeq, () => []);
    expect(await table.insertOne({ tenant: "t1", label: "x" })).toEqual({ insertedId: undefined });
  });

  it("a single primary key keeps its scalar id", async () => {
    const { table } = tableOf(fx.CidSingle, () => [{ id: 5 }]);
    expect(await table.insertOne({ label: "a" })).toEqual({ insertedId: 5 });
  });
});
