import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

// Live DDL against a real server is slow under the parallel workspace run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise (CI has no server). Override with `ATSCRIPT_MYSQL_TEST_URL` (or
// `MYSQL_TEST_URI`; an admin connection — the spec creates and drops its own
// `r15_nulls_mysql` database).
//
// Since 0.1.153: `$nulls` (and the `@db.sort.nulls` default) places NULL
// before or after every value of a `$sort` key, a grouped `$sort` key and a
// `first()` / `last()` row-order key. MySQL has no `NULLS FIRST|LAST`: where
// its native order (NULL smallest) differs, a leading `(expr IS NULL)` key.

const DB = "r15_nulls_mysql";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;

const t = (type: unknown): any => space.getTable(type as never);

describe.skipIf(!reachable)("[mysql live] NULL placement in sort", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/sort-nulls.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    await onlyFullGroupBy(driver);
    space = new DbSpace(() => new MysqlAdapter(driver));
    const result = await syncSchema(space, [fx.SnOwner, fx.SnItem]);
    expect(result.status).toBe("synced");
    await seed();
  });

  afterAll(async () => {
    await driver?.close();
    await dropMysqlDatabase(DB);
  });

  defineCases({ nullsLargest: false });

  it("sessions run with ONLY_FULL_GROUP_BY", async () => {
    const [row] = await driver.all<{ m: string }>("SELECT @@SESSION.sql_mode AS m");
    expect(row!.m).toContain("ONLY_FULL_GROUP_BY");
  });

  it("a leading IS NULL key only where the native placement differs", async () => {
    const sql = await captureSql(async () => {
      await readIds({ $sort: { amount: 1 }, $nulls: { amount: "first" } });
      await readIds({ $sort: { amount: 1 }, $nulls: { amount: "last" } });
      await readIds({ $sort: { amount: -1 }, $nulls: { amount: "first" } });
      await readIds({ $sort: { amount: -1 }, $nulls: { amount: "last" } });
      await readIds({ $sort: { name: -1 }, $nulls: { name: "first" } });
    });
    expect(sql[0]).toContain("ORDER BY `amt` ASC, `id` ASC");
    expect(sql[1]).toContain("ORDER BY (`amt` IS NULL) ASC, `amt` ASC, `id` ASC");
    expect(sql[2]).toContain("ORDER BY (`amt` IS NULL) DESC, `amt` DESC, `id` DESC");
    expect(sql[3]).toContain("ORDER BY `amt` DESC, `id` DESC");
    expect(sql[4]).toContain("ORDER BY `name` DESC, `id` DESC");
  });

  it("grouped ORDER BY: an IS NULL key over a group column and over an aggregate alias", async () => {
    const sql = await captureSql(async () => {
      await grouped({
        $select: ["category", { $fn: "sum", $field: "amount", $as: "total" }],
        $sort: { total: -1, category: 1 },
        $nulls: { total: "first", category: "last" },
      });
    });
    expect(sql[0]).toMatch(
      /ORDER BY \(SUM\(`amt`\) IS NULL\) DESC, `total` DESC, \(`category` IS NULL\) ASC, `category` ASC$/,
    );
  });
});

/**
 * Adds `ONLY_FULL_GROUP_BY` (MySQL's default, absent from some managed
 * servers' parameter groups) to every session, so grouped ORDER BY keys are
 * checked as strictly as on a stock server.
 */
async function onlyFullGroupBy(d: Mysql2Driver): Promise<void> {
  type TRawConn = { query(sql: string, cb: () => void): unknown };
  const pool = (await (d as any).getPool()) as {
    on(event: "connection", listener: (conn: TRawConn) => void): void;
  };
  pool.on("connection", (conn) => {
    conn.query(
      "SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',ONLY_FULL_GROUP_BY')",
      () => {},
    );
  });
}

async function captureSql(fn: () => Promise<void>): Promise<string[]> {
  const all = vi.spyOn(driver, "all");
  try {
    await fn();
    return all.mock.calls.map(([sql]) => sql as string);
  } finally {
    all.mockRestore();
  }
}

// ── shared cases (kept identical across the adapter specs) ─────────────────

type TItem = {
  id: number;
  name: string;
  category: string | null;
  amount: number | null;
  closedAt: number | null;
  ownerId: number | null;
};

const T0 = Date.UTC(2024, 0, 1);

const SN_ITEMS: TItem[] = [
  [1, "alpha item", "x", 30, 100, 1],
  [2, "beta item", null, 10, null, 1],
  [3, "gamma item", "y", null, 300, 1],
  [4, "delta item", "x", 20, null, 2],
  [5, "eps item", null, null, 200, 2],
  [6, "zeta item", "y", 50, null, 2],
  [7, "eta item", "x", null, 150, null],
  [8, "theta item", "z", null, null, 1],
  [9, "iota item", "w", 40, 250, 2],
].map(([id, name, category, amount, hours, ownerId]) => ({
  id,
  name,
  category,
  amount,
  // a distinct calendar day per closed item (hours after 2024-01-01 UTC)
  closedAt: hours === null ? null : T0 + (hours as number) * 3_600_000,
  ownerId,
})) as TItem[];

async function seed(): Promise<void> {
  await t(fx.SnOwner).insertMany([
    { id: 1, label: "one" },
    { id: 2, label: "two" },
  ]);
  // Inserted out of key order; NULLs omitted (a missing optional field).
  for (const item of SN_ITEMS.toReversed()) {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) if (v !== null) row[k] = v;
    await t(fx.SnItem).insertOne(row);
  }
}

type TPlacement = "first" | "last";
type TKey = [keyof TItem, 1 | -1, TPlacement?];

let nativeLargest = false;

/** `rows` in the order `keys` define; a key without placement uses the engine's native one. */
function ordered(rows: TItem[], keys: TKey[]): TItem[] {
  return rows.toSorted((x, y) => {
    for (const [k, dir, placement] of keys) {
      const a = x[k];
      const b = y[k];
      const nullsFirst = placement ? placement === "first" : (dir === 1) !== nativeLargest;
      if (a === null && b === null) continue;
      if (a === null) return nullsFirst ? -1 : 1;
      if (b === null) return nullsFirst ? 1 : -1;
      if (a !== b) return (a < b ? -1 : 1) * dir;
    }
    return 0;
  });
}

const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id);

async function readIds(controls: Record<string, unknown>) {
  return ids(await t(fx.SnItem).findMany({ filter: {}, controls }));
}

/** The expected ids of a `$sort` (with the primary key in the last key's direction). */
function expectedIds(keys: TKey[]): unknown[] {
  return ids(ordered(SN_ITEMS, [...keys, ["id", keys.at(-1)![1]]]));
}

async function grouped(controls: Record<string, unknown>) {
  return t(fx.SnItem).aggregate({
    filter: {},
    controls: { $groupBy: ["category"], ...controls },
  }) as Promise<Array<Record<string, unknown>>>;
}

const firstLast = [
  "category",
  { $fn: "first", $field: "id", $as: "firstId" },
  { $fn: "last", $field: "id", $as: "lastId" },
];

/** `category → [firstId, lastId]`, in result order. */
const picks = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => [r.category ?? null, r.firstId, r.lastId]);

function defineCases(opts: { nullsLargest: boolean }): void {
  beforeAll(() => {
    nativeLargest = opts.nullsLargest;
  });

  it("asc / desc × first / last on a nullable column", async () => {
    for (const dir of [1, -1] as const) {
      for (const placement of ["first", "last"] as const) {
        const got = await readIds({ $sort: { amount: dir }, $nulls: { amount: placement } });
        expect(got, `${dir} ${placement}`).toEqual(expectedIds([["amount", dir, placement]]));
      }
    }
  });

  it("a multi-key sort: keys with and without entries", async () => {
    expect(
      await readIds({ $sort: { category: 1, amount: -1 }, $nulls: { category: "last" } }),
    ).toEqual(
      expectedIds([
        ["category", 1, "last"],
        ["amount", -1],
      ]),
    );
    expect(
      await readIds({ $sort: { category: -1, amount: 1 }, $nulls: { amount: "last" } }),
    ).toEqual(
      expectedIds([
        ["category", -1],
        ["amount", 1, "last"],
      ]),
    );
    expect(
      await readIds({
        $sort: { category: -1, amount: -1 },
        $nulls: { category: "first", amount: "first" },
      }),
    ).toEqual(
      expectedIds([
        ["category", -1, "first"],
        ["amount", -1, "first"],
      ]),
    );
  });

  it("@db.sort.nulls applies when the request names none; $nulls overrides it", async () => {
    expect(await readIds({ $sort: { closedAt: 1 } })).toEqual(
      expectedIds([["closedAt", 1, "last"]]),
    );
    expect(await readIds({ $sort: { closedAt: -1 } })).toEqual(
      expectedIds([["closedAt", -1, "last"]]),
    );
    expect(await readIds({ $sort: { closedAt: -1 }, $nulls: { closedAt: "first" } })).toEqual(
      expectedIds([["closedAt", -1, "first"]]),
    );
  });

  it("an entry on a required field changes nothing", async () => {
    expect(await readIds({ $sort: { name: -1 }, $nulls: { name: "first" } })).toEqual(
      expectedIds([["name", -1]]),
    );
  });

  it("offset pages across the NULL boundary cover every row once", async () => {
    for (const [dir, placement] of [
      [1, "last"],
      [-1, "first"],
      [1, "first"],
      [-1, "last"],
    ] as const) {
      const expected = expectedIds([["amount", dir, placement]]);
      for (const size of [1, 2, 4]) {
        const got: unknown[] = [];
        for (let skip = 0; ; skip += size) {
          const r = await t(fx.SnItem).findManyWithCount({
            filter: {},
            controls: {
              $sort: { amount: dir },
              $nulls: { amount: placement },
              $skip: skip,
              $limit: size,
            },
          });
          expect(r.count).toBe(SN_ITEMS.length);
          got.push(...ids(r.data));
          if (r.data.length < size) break;
        }
        expect(got, `${dir} ${placement} / ${size}`).toEqual(expected);
      }
    }
  });

  it("grouped $sort on a nullable group key", async () => {
    const cats = async (dir: 1 | -1, placement?: TPlacement) =>
      (
        await grouped({
          $select: ["category", { $fn: "count", $field: "*", $as: "n" }],
          $sort: { category: dir },
          ...(placement ? { $nulls: { category: placement } } : {}),
        })
      ).map((r) => r.category ?? null);
    expect(await cats(1, "last")).toEqual(["w", "x", "y", "z", null]);
    expect(await cats(-1, "first")).toEqual([null, "z", "y", "x", "w"]);
    expect(await cats(1, "first")).toEqual([null, "w", "x", "y", "z"]);
    expect(await cats(-1, "last")).toEqual(["z", "y", "x", "w", null]);
    // without an entry NULL is the smallest value on every engine
    expect(await cats(1)).toEqual([null, "w", "x", "y", "z"]);
    expect(await cats(-1)).toEqual(["z", "y", "x", "w", null]);
  });

  it("grouped $sort on a computed alias", async () => {
    const order = async (placement: TPlacement) =>
      (
        await grouped({
          $select: ["category", { $fn: "sum", $field: "amount", $as: "total" }],
          $sort: { total: -1, category: 1 },
          $nulls: { total: placement },
        })
      ).map((r) => r.category ?? null);
    // totals: x 50, y 50, w 40, (null) 10, z NULL
    expect(await order("last")).toEqual(["x", "y", "w", null, "z"]);
    expect(await order("first")).toEqual(["z", "x", "y", "w", null]);
  });

  it("grouped $sort on an aggregate alias named like a physical column, and on a bucket", async () => {
    // `amt` is the physical column of `amount`
    const totals = async (placement: TPlacement) =>
      (
        await grouped({
          $select: ["category", { $fn: "sum", $field: "amount", $as: "amt" }],
          $sort: { amt: -1, category: 1 },
          $nulls: { amt: placement },
        })
      ).map((r) => r.category ?? null);
    expect(await totals("last")).toEqual(["x", "y", "w", null, "z"]);
    expect(await totals("first")).toEqual(["z", "x", "y", "w", null]);

    const days = async (dir: 1 | -1, placement: TPlacement) =>
      (
        await t(fx.SnItem).aggregate({
          filter: {},
          controls: {
            $groupBy: ["closedDay"],
            $select: [
              { $bucket: "day", $field: "closedAt", $as: "closedDay" },
              { $fn: "count", $field: "*", $as: "n" },
            ],
            $sort: { closedDay: dir },
            $nulls: { closedDay: placement },
          },
        })
      ).map((r: Record<string, unknown>) => r.closedDay ?? null);
    const labels = ["2024-01-05", "2024-01-07", "2024-01-09", "2024-01-11", "2024-01-13"];
    expect(await days(1, "last")).toEqual([...labels, null]);
    expect(await days(1, "first")).toEqual([null, ...labels]);
    expect(await days(-1, "first")).toEqual([null, ...labels.toReversed()]);
    expect(await days(-1, "last")).toEqual([...labels.toReversed(), null]);
  });

  it("first / last over a $rowOrder with a NULL placement", async () => {
    const run = async (rowOrder: Record<string, 1 | -1>, nulls?: Record<string, TPlacement>) =>
      picks(
        await grouped({
          $select: firstLast,
          $rowOrder: rowOrder,
          $sort: { category: 1 },
          ...(nulls ? { $nulls: nulls } : {}),
        }),
      );
    expect(await run({ amount: 1 }, { amount: "last" })).toEqual([
      [null, 2, 5],
      ["w", 9, 9],
      ["x", 4, 7],
      ["y", 6, 3],
      ["z", 8, 8],
    ]);
    expect(await run({ amount: 1 }, { amount: "first" })).toEqual([
      [null, 5, 2],
      ["w", 9, 9],
      ["x", 7, 1],
      ["y", 3, 6],
      ["z", 8, 8],
    ]);
    expect(await run({ amount: -1 }, { amount: "first" })).toEqual([
      [null, 5, 2],
      ["w", 9, 9],
      ["x", 7, 4],
      ["y", 3, 6],
      ["z", 8, 8],
    ]);
    // without an entry NULL is the smallest value
    expect(await run({ amount: -1 })).toEqual([
      [null, 2, 5],
      ["w", 9, 9],
      ["x", 1, 7],
      ["y", 6, 3],
      ["z", 8, 8],
    ]);
    // the @db.sort.nulls 'last' default, and an override
    expect(await run({ closedAt: 1 })).toEqual([
      [null, 5, 2],
      ["w", 9, 9],
      ["x", 1, 4],
      ["y", 3, 6],
      ["z", 8, 8],
    ]);
    expect(await run({ closedAt: 1 }, { closedAt: "first" })).toEqual([
      [null, 2, 5],
      ["w", 9, 9],
      ["x", 4, 7],
      ["y", 6, 3],
      ["z", 8, 8],
    ]);
  });

  it("full-text search orders with the placement", async () => {
    const rows = await t(fx.SnItem).search("item", {
      filter: {},
      controls: { $sort: { amount: 1 }, $nulls: { amount: "last" } },
    });
    expect(ids(rows)).toEqual(
      ids(
        ordered(SN_ITEMS, [
          ["amount", 1, "last"],
          ["id", 1],
        ]),
      ),
    );
  });

  it("a $with relation sorts its rows with the placement (plain and paged)", async () => {
    const owners = async (controls: Record<string, unknown>) => {
      const rows: Array<Record<string, any>> = await t(fx.SnOwner).findMany({
        filter: {},
        controls: { $sort: { id: 1 }, $with: [{ name: "items", controls }] },
      });
      return rows.map((r) => ids(r.items));
    };
    const per = (keys: TKey[], limit?: number) =>
      [1, 2].map((owner) =>
        ids(
          ordered(
            SN_ITEMS.filter((i) => i.ownerId === owner),
            [...keys, ["id", keys.at(-1)![1]]],
          ),
        ).slice(0, limit),
      );
    expect(await owners({ $sort: { amount: 1 }, $nulls: { amount: "last" } })).toEqual(
      per([["amount", 1, "last"]]),
    );
    expect(await owners({ $sort: { amount: -1 }, $nulls: { amount: "first" }, $limit: 3 })).toEqual(
      per([["amount", -1, "first"]], 3),
    );
    expect(await owners({ $sort: { closedAt: -1 }, $limit: 2 })).toEqual(
      per([["closedAt", -1, "last"]], 2),
    );
  });
}
