import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.165 a dotted `$with` name (`issues.ticket`) is read as nesting
// (`issues($with=ticket)`). Before, the relation loader skipped it silently.

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
  await t(fx.WsTicket).insertMany([
    { key: "K1", title: "one" },
    { key: "K2", title: "two" },
  ]);
  await t(fx.WsIssue).insertMany([
    { id: 1, title: "a", severity: 2, ticketKey: "K1" },
    { id: 2, title: "b", severity: 5, ticketKey: "K1" },
    { id: 3, title: "c", severity: 1, ticketKey: "K2" },
  ]);
});

afterAll(() => {
  driver.close();
});

describe("[sqlite] dotted $with", () => {
  it("a dotted name loads the nested relation", async () => {
    const rows = await t(fx.WsTicket).findMany({
      filter: { key: "K1" },
      controls: { $with: [{ name: "issues.ticket" }] },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].issues.map((i: any) => [i.id, i.ticket?.key])).toEqual([
      [1, "K1"],
      [2, "K1"],
    ]);
  });

  it("a plain string entry loads (the shorthand the $with type admits)", async () => {
    const rows = await t(fx.WsTicket).findMany({
      filter: { key: "K2" },
      controls: { $with: ["issues"] },
    });
    expect(rows[0].issues.map((i: any) => i.id)).toEqual([3]);
  });

  it("the string shorthand works dotted too", async () => {
    const rows = await t(fx.WsTicket).findMany({
      filter: { key: "K2" },
      controls: { $with: ["issues.ticket"] },
    });
    expect(rows[0].issues[0].ticket.title).toBe("two");
  });

  it("a plain entry and a dotted one for the same relation merge (filter kept)", async () => {
    const rows = await t(fx.WsTicket).findMany({
      filter: { key: "K1" },
      controls: {
        $with: [{ name: "issues", filter: { severity: { $gt: 3 } } }, { name: "issues.ticket" }],
      },
    });
    expect(rows[0].issues.map((i: any) => [i.id, i.ticket?.key])).toEqual([[2, "K1"]]);
  });

  it("the dotted entry's own controls apply at its level", async () => {
    const rows = await t(fx.WsIssue).findMany({
      filter: { id: 1 },
      controls: { $with: [{ name: "ticket.issues", controls: { $sort: { id: -1 } } }] },
    });
    expect(rows[0].ticket.issues.map((i: any) => i.id)).toEqual([2, 1]);
  });
});
