import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures } from "./test-utils";

// Since 0.1.147: a `$with` relation's `$sort` / `$skip` / `$limit` apply to the
// related rows of EACH parent row (VIA `$sort` included). A paged TO / FROM
// relation is read with one `ROW_NUMBER()` window statement.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

const t = (type: unknown): any => space.getTable(type as never);

describe("[sqlite] $with controls per parent row", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/with-controls.as");
    driver = new BetterSqlite3Driver(":memory:");
    space = new DbSpace(() => new SqliteAdapter(driver));
    for (const type of [
      fx.WsTicket,
      fx.WsIssue,
      fx.WsLabel,
      fx.WsTicketLabel,
      fx.WsBoard,
      fx.WsCard,
    ]) {
      await t(type).ensureTable();
    }
    await seed();
  });

  afterAll(() => {
    driver.close();
  });

  defineCases();

  it("a paged FROM relation reads one window statement over the physical columns", async () => {
    const all = vi.spyOn(driver, "all");
    try {
      await ticketsWith({ name: "issues", controls: { $sort: { severity: -1 }, $limit: 1 } }, "id");
      const sql = all.mock.calls.map(([statement]) => statement).join("\n");
      expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY "ticket_ref" ORDER BY "sev" DESC)');
      expect(all.mock.calls).toHaveLength(2); // tickets + issues
      expect(all.mock.results[1]?.value).toHaveLength(3); // only the kept issue rows
    } finally {
      all.mockRestore();
    }
  });
});

// ── shared cases (kept identical across the adapter specs) ─────────────────

async function seed(): Promise<void> {
  await t(fx.WsTicket).insertMany([
    { key: "K1", title: "one" },
    { key: "K2", title: "two" },
    { key: "K3", title: "three" },
    { key: "K4", title: "four" },
  ]);
  await t(fx.WsIssue).insertMany([
    { id: 1, title: "a", severity: 2, ticketKey: "K1" },
    { id: 2, title: "b", severity: 5, ticketKey: "K1" },
    { id: 3, title: "c", severity: 1, ticketKey: "K1" },
    { id: 4, title: "d", severity: 3, ticketKey: "K2" },
    { id: 5, title: "e", severity: 4, ticketKey: "K2" },
    { id: 6, title: "f", severity: 9, ticketKey: "K3" },
  ]);
  await t(fx.WsLabel).insertMany([
    { id: 1, name: "bug" },
    { id: 2, name: "feature" },
    { id: 3, name: "urgent" },
    { id: 4, name: "hidden" },
  ]);
  // Junction order differs from both name orders.
  await t(fx.WsTicketLabel).insertMany([
    { id: 1, ticketKey: "K1", labelId: 1 },
    { id: 2, ticketKey: "K1", labelId: 3 },
    { id: 3, ticketKey: "K2", labelId: 2 },
    { id: 4, ticketKey: "K2", labelId: 3 },
    { id: 5, ticketKey: "K2", labelId: 1 },
    { id: 6, ticketKey: "K3", labelId: 4 },
  ]);
  await t(fx.WsBoard).insertMany([
    { org: "o1", code: "b1", title: "Alpha" },
    { org: "o1", code: "b2", title: "Beta" },
    { org: "o2", code: "b1", title: "Gamma" },
  ]);
  await t(fx.WsCard).insertMany([
    { id: 1, rank: 1, boardOrg: "o1", boardCode: "b1" },
    { id: 2, rank: 3, boardOrg: "o1", boardCode: "b1" },
    { id: 3, rank: 2, boardOrg: "o1", boardCode: "b1" },
    { id: 4, rank: 5, boardOrg: "o1", boardCode: "b2" },
    { id: 5, rank: 4, boardOrg: "o2", boardCode: "b1" },
    { id: 6, rank: 7, boardOrg: "o2", boardCode: "b1" },
  ]);
}

type Row = Record<string, any>;

/** `rel` of every ticket (by key), mapped through `field`. */
async function ticketsWith(rel: Row, field: string): Promise<Record<string, unknown[]>> {
  const rows: Row[] = await t(fx.WsTicket).findMany({
    filter: {},
    controls: { $sort: { key: 1 }, $with: [rel] },
  });
  return Object.fromEntries(rows.map((r) => [r.key, r[rel.name].map((x: Row) => x[field])]));
}

/** `rel` of every board (by `org/code`), mapped through `field`. */
async function boardsWith(rel: Row, field: string): Promise<Record<string, unknown[]>> {
  const rows: Row[] = await t(fx.WsBoard).findMany({
    filter: {},
    controls: { $sort: { org: 1, code: 1 }, $with: [rel] },
  });
  return Object.fromEntries(
    rows.map((r) => [`${r.org}/${r.code}`, r[rel.name].map((x: Row) => x[field])]),
  );
}

function defineCases(): void {
  it("VIA: $sort orders each row's targets", async () => {
    expect(
      await ticketsWith({ name: "labels", controls: { $sort: { name: -1 } } }, "name"),
    ).toEqual({
      K1: ["urgent", "bug"],
      K2: ["urgent", "feature", "bug"],
      K3: ["hidden"],
      K4: [],
    });
  });

  it("VIA: without $sort the targets keep junction order", async () => {
    expect(await ticketsWith({ name: "labels" }, "name")).toEqual({
      K1: ["bug", "urgent"],
      K2: ["feature", "urgent", "bug"],
      K3: ["hidden"],
      K4: [],
    });
    expect(await ticketsWith({ name: "labels", controls: { $limit: 2 } }, "name")).toEqual({
      K1: ["bug", "urgent"],
      K2: ["feature", "urgent"],
      K3: ["hidden"],
      K4: [],
    });
  });

  it("VIA: $skip / $limit page each row's targets", async () => {
    expect(
      await ticketsWith({ name: "labels", controls: { $sort: { name: -1 }, $limit: 1 } }, "name"),
    ).toEqual({ K1: ["urgent"], K2: ["urgent"], K3: ["hidden"], K4: [] });
    expect(
      await ticketsWith(
        { name: "labels", controls: { $sort: { name: 1 }, $skip: 1, $limit: 1 } },
        "name",
      ),
    ).toEqual({ K1: ["urgent"], K2: ["feature"], K3: [], K4: [] });
    // the URL parser's flat shape
    expect(await ticketsWith({ name: "labels", $sort: { name: -1 }, $limit: 1 }, "name")).toEqual({
      K1: ["urgent"],
      K2: ["urgent"],
      K3: ["hidden"],
      K4: [],
    });
  });

  it("FROM: $skip / $limit page each row's related rows", async () => {
    expect(
      await ticketsWith({ name: "issues", controls: { $sort: { severity: -1 }, $limit: 1 } }, "id"),
    ).toEqual({ K1: [2], K2: [5], K3: [6], K4: [] });
    expect(
      await ticketsWith(
        { name: "issues", controls: { $sort: { severity: -1 }, $skip: 1, $limit: 1 } },
        "id",
      ),
    ).toEqual({ K1: [1], K2: [4], K3: [], K4: [] });
    expect(
      await ticketsWith({ name: "issues", controls: { $sort: { severity: 1 }, $skip: 1 } }, "id"),
    ).toEqual({ K1: [1, 2], K2: [5], K3: [], K4: [] });
  });

  it("FROM: paged with a $select that leaves out the join key", async () => {
    expect(
      await ticketsWith(
        {
          name: "issues",
          controls: { $select: ["title"], $sort: { severity: -1 }, $limit: 2 },
        },
        "title",
      ),
    ).toEqual({ K1: ["b", "a"], K2: ["e", "d"], K3: ["f"], K4: [] });
  });

  it("nested $with loads on the paged rows", async () => {
    const rows: Row[] = await t(fx.WsTicket).findMany({
      filter: {},
      controls: {
        $sort: { key: 1 },
        $with: [
          {
            name: "issues",
            controls: {
              $sort: { severity: -1 },
              $limit: 1,
              $with: [
                {
                  name: "ticket",
                  controls: {
                    $with: [{ name: "labels", controls: { $sort: { name: 1 }, $limit: 1 } }],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(
      rows.map((r) =>
        r.issues.map((i: Row) => [i.id, i.ticket.key, i.ticket.labels.map((l: Row) => l.name)]),
      ),
    ).toEqual([[[2, "K1", ["bug"]]], [[5, "K2", ["bug"]]], [[6, "K3", ["hidden"]]], []]);
  });

  it("TO: $skip / $limit apply to each row's one target", async () => {
    const issues = async (controls: Row) =>
      (
        await t(fx.WsIssue).findMany({
          filter: {},
          controls: { $sort: { id: 1 }, $with: [{ name: "ticket", controls }] },
        })
      ).map((r: Row) => r.ticket?.key ?? null);
    expect(await issues({ $limit: 1 })).toEqual(["K1", "K1", "K1", "K2", "K2", "K3"]);
    expect(await issues({ $skip: 1 })).toEqual([null, null, null, null, null, null]);
  });

  it("composite FROM: paged per parent row", async () => {
    expect(
      await boardsWith({ name: "cards", controls: { $sort: { rank: -1 }, $limit: 2 } }, "id"),
    ).toEqual({ "o1/b1": [2, 3], "o1/b2": [4], "o2/b1": [6, 5] });
    expect(
      await boardsWith({ name: "cards", controls: { $sort: { rank: 1 }, $skip: 1 } }, "id"),
    ).toEqual({ "o1/b1": [3, 2], "o1/b2": [], "o2/b1": [6] });
  });

  it("composite TO: paged per row", async () => {
    const cards = async (controls: Row) =>
      (
        await t(fx.WsCard).findMany({
          filter: {},
          controls: { $sort: { id: 1 }, $with: [{ name: "board", controls }] },
        })
      ).map((r: Row) => r.board?.title ?? null);
    expect(await cards({ $limit: 1 })).toEqual([
      "Alpha",
      "Alpha",
      "Alpha",
      "Beta",
      "Gamma",
      "Gamma",
    ]);
    expect(await cards({ $skip: 1 })).toEqual([null, null, null, null, null, null]);
  });
}
