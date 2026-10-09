import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";
import { createMockDriver, prepareFixtures } from "./test-utils";

/**
 * Round trips per write (since 0.1.151): a write that is ONE statement runs
 * without BEGIN / COMMIT around it (atomic on its own), and the per-table
 * metadata the adapter derives is built once. Statement sequences over a
 * recording driver.
 */

let ig: Record<string, any>;
let cap: Record<string, any>;
let users: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  ig = await import("./fixtures/insert-ignore.as");
  cap = await import("./fixtures/search-capability.as");
  users = await import("./fixtures/test-table.as");
});

/** An adapter over a recording driver whose INSERT … RETURNING echoes the sent ids. */
function setup(Type: unknown) {
  const driver = createMockDriver({
    runResponder: (sql, params) =>
      sql.startsWith("INSERT")
        ? { rows: (params ?? []).filter((_, i) => i % 3 === 0).map((id) => ({ id })) }
        : {},
  });
  const adapter = new PostgresAdapter(driver);
  const table = new AtscriptDbTable(Type as any, adapter);
  table.getMetadata();
  /** First word(s) of every statement, in order. */
  const verbs = () =>
    driver.calls.map((c) =>
      c.sql
        .split(" ")
        .slice(0, c.sql.startsWith("INSERT") ? 1 : 2)
        .join(" "),
    );
  return { driver, adapter, table, verbs };
}

const item = (id: number) => ({ id, sku: `s${id}`, qty: 1 });

describe("[postgres] insertMany round trips", () => {
  it("one chunk: a single INSERT, no transaction", async () => {
    const { adapter, verbs, driver } = setup(ig.IgItem);
    const result = await adapter.insertMany([item(1), item(2)]);
    expect(verbs()).toEqual(["INSERT"]);
    expect(driver.calls[0]!.sql).toMatch(/ RETURNING "id"$/);
    expect(result).toEqual({ insertedCount: 2, insertedIds: [1, 2] });
  });

  it("several chunks commit together in one transaction", async () => {
    const { adapter, verbs } = setup(ig.IgItem);
    const rows = Array.from({ length: 25_000 }, (_, i) => item(i + 1));
    const result = await adapter.insertMany(rows);
    expect(result.insertedCount).toBe(25_000);
    const v = verbs();
    expect(v[0]).toBe("BEGIN");
    expect(v.at(-1)).toBe("COMMIT");
    expect(v.filter((s) => s === "INSERT").length).toBeGreaterThan(1);
  });

  it("a constraint error of the single INSERT surfaces mapped (nothing to roll back)", async () => {
    const driver = createMockDriver();
    driver.run = async () => {
      throw Object.assign(new Error("dup"), {
        code: "23505",
        constraint: "ig_items_sku_key",
        detail: "dup",
      });
    };
    const table = new AtscriptDbTable(ig.IgItem, new PostgresAdapter(driver));
    await expect((table as any).adapter.insertMany([item(1)])).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(driver.calls.some((c) => /BEGIN|ROLLBACK/.test(c.sql))).toBe(false);
  });
});

describe("[postgres] insertManyIgnore round trips", () => {
  it("one row: a single INSERT — no transaction, no savepoint (a one-row mapping is exact)", async () => {
    const { adapter, verbs } = setup(ig.IgItem);
    expect(await adapter.insertManyIgnore([item(1)])).toEqual([{ insertedId: 1 }]);
    expect(verbs()).toEqual(["INSERT"]);
  });

  it("one row that conflicts: still one INSERT, the slot is null", async () => {
    const driver = createMockDriver({ runResponder: () => ({ rows: [] }) });
    const adapter = new PostgresAdapter(driver);
    new AtscriptDbTable(ig.IgItem, adapter).getMetadata();
    expect(await adapter.insertManyIgnore([item(1)])).toEqual([null]);
    expect(driver.calls.map((c) => c.sql.split(" ")[0])).toEqual(["INSERT"]);
  });

  it("a multi-row chunk of a keyed table keeps its savepoint (ambiguity fallback) and transaction", async () => {
    const { adapter, verbs } = setup(ig.IgItem);
    await adapter.insertManyIgnore([item(1), item(2)]);
    expect(verbs()).toEqual([
      "BEGIN",
      "SAVEPOINT atscript_ignore_chunk",
      "INSERT",
      "RELEASE SAVEPOINT",
      "COMMIT",
    ]);
  });

  it("a keyless table maps by position: no savepoint, and one chunk needs no transaction", async () => {
    const { adapter, verbs, driver } = setup(ig.IgLog);
    const slots = await adapter.insertManyIgnore([
      { text: "a", qty: 1 },
      { text: "b", qty: 2 },
    ]);
    expect(slots).toHaveLength(2);
    expect(verbs()).toEqual(["INSERT"]);
    expect(driver.calls[0]!.sql).toMatch(/ON CONFLICT DO NOTHING$/);
  });

  it("inside an outer transaction one row runs on its connection, without a savepoint", async () => {
    const { adapter, verbs } = setup(ig.IgItem);
    await adapter.withTransaction(() => adapter.insertManyIgnore([item(1)]));
    expect(verbs()).toEqual(["BEGIN", "INSERT", "COMMIT"]);
  });
});

describe("[postgres] per-table memos", () => {
  it("getSearchIndexes builds once; each caller gets its own array", async () => {
    const { adapter } = setup(cap.CapBoth);
    const spy = vi.spyOn(adapter as any, "_buildSearchIndexes");
    const a = adapter.getSearchIndexes();
    const b = adapter.getSearchIndexes();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    a.length = 0;
    expect(adapter.getSearchIndexes()).toEqual(b);
    expect(b.map((i) => [i.name, i.type, i.isDefault])).toEqual([
      ["atscript__fulltext__cap_both_ft", "text", true],
      ["embedding", "vector", true],
    ]);
    expect(adapter.isSearchable()).toBe(true);
  });

  it("replaceOne derives its column list once and assigns every column on each call", async () => {
    const { adapter, driver } = setup(users.UsersTable);
    const tools = await import("@atscript/db-sql-tools");
    await adapter.replaceOne({ id: 1 }, { id: 1, name: "a" });
    await adapter.replaceOne({ id: 2 }, { id: 2, name: "b" });
    const [first, second] = driver.calls.filter((c) => c.sql.startsWith("UPDATE"));
    expect(second!.sql).toBe(first!.sql);
    expect(first!.sql).toContain('"email_address" = $');
    expect(first!.sql).toContain('"createdAt" = DEFAULT');
    expect((adapter as any)._replaceColumnsMemo.cols).toEqual(
      tools.replaceColumnsFor((adapter as any)._table.fieldDescriptors, adapter.nativeDefaultFns()),
    );
  });

  it("vectorSearchWithCount resolves the search context once for both statements", async () => {
    const { adapter, driver } = setup(cap.CapVector);
    const spy = vi.spyOn(adapter as any, "_prepareVectorSearch");
    await adapter.vectorSearchWithCount([1, 2, 3], {
      filter: { title: "a" },
      controls: { $limit: 5 },
    } as any);
    expect(spy).toHaveBeenCalledTimes(1);
    const [rows, count] = driver.calls.filter((c) => /^SELECT|^WITH/.test(c.sql));
    expect(rows!.params).toContain("[1,2,3]");
    expect(count!.sql).toMatch(/COUNT\(\*\)/);
    expect(count!.params).toContain("[1,2,3]");
  });
});
