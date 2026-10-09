import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";
import { sanitizeParams } from "../mysql2-driver";
import { createMockDriver, prepareFixtures, type TMockDriverOptions } from "./test-utils";

/**
 * Round trips per write (since 0.1.151): a write that is ONE statement runs
 * without START TRANSACTION / COMMIT (atomic on its own); generated ids of a
 * multi-row INSERT read `@@auto_increment_increment` on the INSERT's own
 * connection; per-table metadata is derived once. Statement sequences over a
 * recording driver.
 */

let ig: Record<string, any>;
let ts: Record<string, any>;
beforeAll(async () => {
  await prepareFixtures();
  ig = await import("./fixtures/insert-ignore.as");
  ts = await import("./fixtures/timestamps.as");
});

function setup(Type: unknown, opts?: TMockDriverOptions) {
  const driver = createMockDriver({
    runResult: { insertId: 100 },
    get: [["auto_increment_increment", { step: 2 }]],
    ...opts,
  });
  const adapter = new MysqlAdapter(driver);
  new AtscriptDbTable(Type as any, adapter).getMetadata();
  const seq = () => driver.calls.map((c) => `${c.via}:${c.sql.split(" ").slice(0, 2).join(" ")}`);
  return { driver, adapter, seq };
}

const item = (id: number) => ({ id, sku: `s${id}`, qty: 1 });
const auto = (sku: string, id?: number) => ({
  ...(id === undefined ? {} : { id }),
  sku,
  label: "x",
});

describe("[mysql] insertMany round trips", () => {
  it("explicit ids, one chunk: a single INSERT on the pool", async () => {
    const { adapter, seq } = setup(ig.IgItem);
    expect(await adapter.insertMany([item(1), item(2)])).toEqual({
      insertedCount: 2,
      insertedIds: [1, 2],
    });
    expect(seq()).toEqual(["pool:INSERT INTO"]);
  });

  it("one generated id: a single INSERT (no stride to read)", async () => {
    const { adapter, seq } = setup(ig.IgAuto);
    expect(await adapter.insertMany([auto("a")])).toEqual({ insertedCount: 1, insertedIds: [100] });
    expect(seq()).toEqual(["pool:INSERT INTO"]);
  });

  it("several generated ids: stride read + INSERT on ONE dedicated connection, no transaction", async () => {
    const { adapter, seq, driver } = setup(ig.IgAuto);
    expect(await adapter.insertMany([auto("a"), auto("b"), auto("c")])).toEqual({
      insertedCount: 3,
      insertedIds: [100, 102, 104],
    });
    expect(seq()).toEqual(["conn:SELECT @@auto_increment_increment", "conn:INSERT INTO"]);
    expect(driver.releaseCount()).toBe(1);
  });

  it("a failed stride read inserts nothing (the INSERT never runs)", async () => {
    const { adapter, driver } = setup(ig.IgAuto);
    const getConnection = driver.getConnection.bind(driver);
    driver.getConnection = async () => {
      const conn = await getConnection();
      conn.get = async () => {
        throw new Error("connection lost");
      };
      return conn;
    };
    await expect(adapter.insertMany([auto("a"), auto("b")])).rejects.toThrow("connection lost");
    expect(driver.calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
    expect(driver.releaseCount()).toBe(1);
  });

  it("the dedicated connection is released when the INSERT fails", async () => {
    const { adapter, driver } = setup(ig.IgAuto, {
      runResponder: () => {
        throw Object.assign(new Error("Duplicate entry 'a' for key 'ig_auto.auto_sku_idx'"), {
          errno: 1062,
        });
      },
    });
    await expect(adapter.insertMany([auto("a"), auto("b")])).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(driver.releaseCount()).toBe(1);
  });

  it.each([
    ["mixed explicit / generated ids", [auto("a", 5), auto("b")]],
    ["a 0 id (NO_AUTO_VALUE_ON_ZERO decides it)", [auto("a", 0), auto("b", 0)]],
  ])("%s keep the transaction", async (_label, rows) => {
    const { adapter, seq } = setup(ig.IgAuto);
    await adapter.insertMany(rows as any);
    expect(seq()[0]).toBe("conn:START TRANSACTION");
    expect(seq().at(-1)).toBe("conn:COMMIT");
  });

  it("inside an outer transaction everything runs on its connection", async () => {
    const { adapter, seq, driver } = setup(ig.IgAuto);
    await adapter.withTransaction(() => adapter.insertMany([auto("a"), auto("b")]));
    expect(seq()).toEqual([
      "conn:START TRANSACTION",
      "conn:INSERT INTO",
      "conn:SELECT @@auto_increment_increment",
      "conn:COMMIT",
    ]);
    expect(driver.releaseCount()).toBe(1);
  });
});

describe("[mysql] insertManyIgnore round trips", () => {
  it("one row: a single INSERT, a duplicate leaves a null slot", async () => {
    const { adapter, seq } = setup(ig.IgItem);
    expect(await adapter.insertManyIgnore([item(1)])).toEqual([{ insertedId: 1 }]);
    expect(seq().filter((s) => !s.includes("sql_mode"))).toEqual(["pool:INSERT INTO"]);

    const dup = setup(ig.IgItem, {
      runResponder: () => {
        throw Object.assign(new Error("Duplicate entry '1' for key 'ig_items.PRIMARY'"), {
          errno: 1062,
        });
      },
    });
    expect(await dup.adapter.insertManyIgnore([item(1)])).toEqual([null]);
    expect(dup.seq().filter((s) => !s.includes("sql_mode"))).toEqual(["pool:INSERT INTO"]);
  });

  it("several rows keep the transaction", async () => {
    const { adapter, seq } = setup(ig.IgItem);
    await adapter.insertManyIgnore([item(1), item(2)]);
    expect(seq().filter((s) => !s.includes("sql_mode"))).toEqual([
      "conn:START TRANSACTION",
      "conn:INSERT INTO",
      "conn:COMMIT",
    ]);
  });
});

describe("[mysql] per-table memos", () => {
  it("getSearchIndexes builds once; each caller gets its own array", () => {
    const { adapter } = setup(ts.TsSearch);
    const spy = vi.spyOn(adapter as any, "_buildSearchIndexes");
    const a = adapter.getSearchIndexes();
    const b = adapter.getSearchIndexes();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(b.map((i) => i.type)).toEqual(["text", "vector"]);
  });

  it("replaceOne assigns every column, with the column list derived once", async () => {
    const { adapter, driver } = setup(ts.TsItem);
    await adapter.replaceOne({ id: 1 }, { id: 1 });
    await adapter.replaceOne({ id: 2 }, { id: 2 });
    const [first, second] = driver.calls.filter((c) => c.sql.startsWith("UPDATE"));
    expect(second!.sql).toBe(first!.sql);
    expect(first!.sql).toBe(
      "UPDATE `ts_items` SET `id` = ?, `createdAt` = DEFAULT, `updatedAt` = DEFAULT, `seenAt` = ?, `shortAt` = ?, `epochAt` = DEFAULT WHERE `id` = ? LIMIT 1",
    );
  });

  it("vectorSearchWithCount resolves the search context once for both statements", async () => {
    const { adapter, driver } = setup(ts.TsSearch, { get: [["VERSION()", { v: "9.1.0" }]] });
    const spy = vi.spyOn(adapter as any, "_prepareVectorSearch");
    await adapter.vectorSearchWithCount([1, 2, 3], { filter: { title: "a" }, controls: {} } as any);
    expect(spy).toHaveBeenCalledTimes(1);
    const stmts = driver.calls.filter((c) => c.params?.includes("[1,2,3]"));
    expect(stmts).toHaveLength(2);
  });
});

describe("[mysql] sanitizeParams", () => {
  it("binds the caller's array as is when it holds no undefined, else copies with null", () => {
    const params = [1, "a", null];
    expect(sanitizeParams(params)).toBe(params);
    const holed = [1, undefined];
    expect(sanitizeParams(holed)).toEqual([1, null]);
    expect(holed).toEqual([1, undefined]);
    expect(sanitizeParams()).toEqual([]);
  });
});
