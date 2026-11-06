import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.165: `getValidator(purpose)` binds its write mode, so the
// documented `getValidator("insert").validate(row, true)` accepts what an
// insert accepts (omitted primary key / defaults / FKs / nav fields), and
// `validateRows(rows, mode, { fk })` validates rows exactly as a write would —
// defaults applied, one `{ index, path, message }` per problem — with an
// opt-in foreign-key lookup that also runs on native-FK adapters.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

const t = (type: unknown): any => space.getTable(type as never);

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/with-controls.as");
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  for (const type of [fx.WsTicket, fx.WsIssue, fx.WsLabel, fx.WsTicketLabel]) {
    await t(type).ensureTable();
  }
  await t(fx.WsTicket).insertMany([{ key: "K1", title: "one" }]);
});

afterAll(() => {
  driver.close();
});

describe("[sqlite] getValidator binds its write mode", () => {
  it('getValidator("insert") accepts a row without its FK and nav fields', () => {
    const validator = t(fx.WsIssue).getValidator("insert");
    const ok = validator.validate({ id: 1, title: "a", severity: 1 }, true);
    expect(validator.errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('getValidator("insert") still reports real problems', () => {
    const validator = t(fx.WsIssue).getValidator("insert");
    expect(validator.validate({ id: 1, severity: 1 }, true)).toBe(false);
    expect(validator.errors.map((e: any) => e.path)).toEqual(["title"]);
  });
});

describe("[sqlite] validateRows", () => {
  it("returns one entry per problem with the row index; valid rows pass", async () => {
    const errors = await t(fx.WsIssue).validateRows([
      { id: 1, title: "a", severity: 1 },
      { id: 2, severity: "high" },
    ]);
    expect(errors).toEqual([
      expect.objectContaining({ index: 1, path: "title", code: "TYPE" }),
      expect.objectContaining({ index: 1, path: "severity", code: expect.any(String) }),
    ]);
  });

  it("each entry is the entry a write's error carries: code, params (since 0.1.173)", async () => {
    // A translator renders a validator entry by its code + params; without
    // them a dry run's problems could only be shown in English.
    const row = { id: 2, severity: "high" };
    const write = await t(fx.WsIssue)
      .insertOne(row)
      .catch((e: unknown) => e);
    expect(write.errors.length).toBeGreaterThan(0);
    const dryRun = await t(fx.WsIssue).validateRows([row]);
    expect(dryRun).toEqual(write.errors.map((e: object) => Object.assign({ index: 0 }, e)));
    for (const e of dryRun) expect(e.code).toEqual(expect.any(String));
  });

  it("does not touch the caller's rows (defaults are applied to a clone)", async () => {
    const row = { id: 3, title: "a", severity: 1 };
    await t(fx.WsIssue).validateRows([row]);
    expect(row).toEqual({ id: 3, title: "a", severity: 1 });
  });

  it("{ fk: true } looks foreign keys up even on a native-FK adapter", async () => {
    const rows = [
      { id: 1, title: "a", severity: 1, ticketKey: "K1" },
      { id: 2, title: "b", severity: 1, ticketKey: "NOPE" },
      { id: 3, title: "c", severity: 1 },
    ];
    expect(await t(fx.WsIssue).validateRows(rows)).toEqual([]);
    expect(await t(fx.WsIssue).validateRows(rows, "insert", { fk: true })).toEqual([
      {
        index: 1,
        path: "ticketKey",
        message: expect.stringContaining("NOPE"),
        // the code a write's FK error carries (since 0.1.173)
        code: "FK_MISSING",
        params: { fields: ["ticketKey"], target: "ws_tickets", values: "NOPE" },
      },
    ]);
  });

  it("replace mode requires what a replace requires", async () => {
    const errors = await t(fx.WsIssue).validateRows([{ title: "a", severity: 1 }], "replace");
    expect(errors.map((e: any) => [e.index, e.path])).toEqual([[0, "id"]]);
  });

  it("patch mode accepts a partial row", async () => {
    expect(await t(fx.WsIssue).validateRows([{ id: 1, severity: 2 }], "patch")).toEqual([]);
  });
});

// Review fix: the FK lookup is chunked (no bind-limit overflow on large
// batches) and reads the existing target keys, so a missing key costs no
// per-tuple queries.
describe("[sqlite] validateRows fk lookup at scale", () => {
  it("40k distinct keys stay under the bind limit; a miss is found per chunk", async () => {
    const local = new BetterSqlite3Driver(":memory:");
    const sp = new DbSpace(() => new SqliteAdapter(local));
    for (const type of [fx.WsTicket, fx.WsIssue]) await (sp.getTable(type) as any).ensureTable();
    const N = 40_000;
    await (sp.getTable(fx.WsTicket) as any).insertMany(
      Array.from({ length: N }, (_, i) => ({ key: `K${i}`, title: "t" })),
    );
    const issues: any = sp.getTable(fx.WsIssue);
    const rows = Array.from({ length: N }, (_, i) => ({
      id: i + 1,
      title: "a",
      severity: 1,
      ticketKey: `K${i}`,
    }));
    expect(await issues.validateRows(rows, "insert", { fk: true })).toEqual([]);

    rows[123]!.ticketKey = "NOPE-1";
    rows[30_000]!.ticketKey = "NOPE-2";
    let queries = 0;
    const all = local.all.bind(local);
    const get = local.get.bind(local);
    local.all = ((sql: string, params?: unknown[]) => (queries++, all(sql, params))) as never;
    local.get = ((sql: string, params?: unknown[]) => (queries++, get(sql, params))) as never;
    const errors = await issues.validateRows(rows, "insert", { fk: true });
    expect(errors.map((e: any) => [e.index, e.path])).toEqual([
      [123, "ticketKey"],
      [30_000, "ticketKey"],
    ]);
    // one read per chunk of ~500 keys, never one per key
    expect(queries).toBeLessThanOrEqual(Math.ceil(N / 500) + 2);
    local.close();
  }, 60_000);
});
