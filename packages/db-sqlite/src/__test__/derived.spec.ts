import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";
import { SchemaSync, planSchema } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

// `@db.column.derived` on a real SQLite database (since 0.1.141): VIRTUAL
// generated columns — DDL, `table_xinfo` introspection, reads / writes, the
// query surface (filter, sort, select, group, unique index, view), and every
// schema-sync transition on a populated table.

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

const ROWS = [
  {
    id: 1,
    status: "open",
    payload: { customer: { id: "c1", vip: true, tier: "Gold" }, total: 10 },
    meta: { region: "eu" },
  },
  { id: 2, status: "paid", payload: { customer: { id: "c2", vip: false }, total: 5 } },
  {
    id: 3,
    status: "open",
    payload: { customer: { id: "c1", vip: true }, total: 7 },
    meta: { region: "us" },
  },
];

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/derived.as");
});

beforeEach(() => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
});

afterEach(() => {
  driver.close();
});

const xinfo = (table: string) =>
  driver.all<{ name: string; type: string; hidden: number }>(`PRAGMA table_xinfo("${table}")`);
const managedIndexes = (table: string) =>
  driver
    .all<{ name: string }>(`PRAGMA index_list("${table}")`)
    .map((i) => i.name)
    .filter((n) => n.startsWith("atscript__"))
    .toSorted();
const sync = (types: any[], opts?: Record<string, unknown>) =>
  new SchemaSync(space).run(types, opts);
const entry = (result: { entries: any[] }, name = "dv_sync") =>
  result.entries.find((e) => e.name === name)!;

describe("SQLite: derived columns — DDL, introspection, reads and writes", () => {
  beforeEach(async () => {
    const result = await sync([fx.DvOrder, fx.DvOrderView], { force: true });
    expect(result.status).toBe("synced");
    expect(entry(result, "dv_orders").errors).toEqual([]);
  });

  it("creates VIRTUAL generated columns that table_xinfo reports as hidden=2, with their indexes", async () => {
    const cols = xinfo("dv_orders");
    expect(cols.filter((c) => c.hidden === 2).map((c) => c.name)).toEqual([
      "customerId",
      "vip",
      "amount",
      "region_code",
      "tier",
    ]);
    expect(cols.find((c) => c.name === "payload")!.hidden).toBe(0);
    expect(managedIndexes("dv_orders")).toEqual([
      "atscript__plain__customerId",
      "atscript__unique__region",
    ]);
    const existing = await space.getAdapter(fx.DvOrder).getExistingColumns!();
    expect(existing.filter((c) => c.generated).map((c) => c.name)).toEqual([
      "customerId",
      "vip",
      "amount",
      "region_code",
      "tier",
    ]);
    expect(existing.find((c) => c.name === "payload")!.generated).toBeUndefined();
    // A second sync sees nothing to do
    expect((await sync([fx.DvOrder, fx.DvOrderView])).status).toBe("up-to-date");
    expect(
      entry(await sync([fx.DvOrder, fx.DvOrderView], { force: true }), "dv_orders").status,
    ).toBe("in-sync");
  });

  it("reads the derived values back typed; supplied derived values are stripped on write", async () => {
    const table = space.getTable(fx.DvOrder);
    await table.insertMany(
      ROWS.map((r) => Object.assign({}, r, { customerId: "zzz", amount: 999 })) as never,
    );
    const rows = await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } });
    expect(rows[0]).toEqual({
      id: 1,
      status: "open",
      payload: { customer: { id: "c1", vip: true, tier: "Gold" }, total: 10 },
      meta: { region: "eu" },
      customerId: "c1",
      vip: true,
      amount: 10,
      region: "eu",
      tier: "Gold",
    });
    expect(rows[1]).toMatchObject({
      customerId: "c2",
      vip: false,
      amount: 5,
      region: null,
      tier: null,
    });

    // replace / patch never SET the generated column; patching the source moves the value
    await table.replaceOne({ ...ROWS[1]!, customerId: "zzz" } as never);
    await table.updateOne({
      id: 2,
      payload: { customer: { id: "c9", vip: true }, total: 1 },
      amount: 0,
    } as never);
    expect(await table.findOne({ filter: { id: 2 }, controls: {} })).toMatchObject({
      customerId: "c9",
      vip: true,
      amount: 1,
    });
    await table.updateMany({ status: "open" }, { customerId: "zzz", status: "closed" } as never);
    expect(await table.count({ filter: { status: "closed" }, controls: {} })).toBe(2);
    expect(driver.all(`SELECT "customerId" FROM "dv_orders" WHERE id = 1`)).toEqual([
      { customerId: "c1" },
    ]);
  });

  it("filters, sorts, selects, groups and enforces the unique index on the derived column", async () => {
    const table = space.getTable(fx.DvOrder);
    await table.insertMany(ROWS as never);

    const filtered = await table.findMany({
      filter: { customerId: "c1", vip: true },
      controls: { $sort: { amount: -1 }, $select: ["id", "customerId", "amount"] },
    });
    expect(filtered).toEqual([
      { id: 1, customerId: "c1", amount: 10 },
      { id: 3, customerId: "c1", amount: 7 },
    ]);
    expect(
      await table.findMany({ filter: { tier: "gold" }, controls: { $select: ["id"] } }),
    ).toEqual([{ id: 1 }]);

    const grouped = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["customerId"],
        $select: ["customerId", { $fn: "sum", $field: "amount", $as: "total" }],
        $sort: { customerId: 1 },
      },
    } as never);
    expect(grouped).toEqual([
      { customerId: "c1", total: 17 },
      { customerId: "c2", total: 5 },
    ]);

    let conflict: unknown;
    try {
      await table.insertOne({
        id: 4,
        status: "x",
        payload: { customer: { id: "c4", vip: false }, total: 1 },
        meta: { region: "eu" },
      } as never);
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeInstanceOf(DbError);
    expect((conflict as DbError).code).toBe("CONFLICT");

    let inc: unknown;
    try {
      await table.updateOne({ id: 1, amount: { $inc: 1 } } as never);
    } catch (e) {
      inc = e;
    }
    expect((inc as Error).message).toContain("not allowed on a @db.column.derived field");
  });

  it("a view reads the derived column like any other", async () => {
    await space.getTable(fx.DvOrder).insertMany(ROWS as never);
    const rows = await space
      .getView(fx.DvOrderView)
      .findMany({ filter: { customer: "c1" }, controls: { $sort: { id: 1 } } });
    expect(rows).toEqual([
      { id: 1, customer: "c1", vip: true },
      { id: 3, customer: "c1", vip: true },
    ]);
  });
});

describe("SQLite: derived columns — schema sync on a populated table", () => {
  const seed = async () => {
    await space.getTable(fx.DvSyncV0).insertMany([
      { id: 1, payload: { customer: { id: "a", n: 1 }, code: "A" } },
      { id: 2, payload: { customer: { id: "b", n: 2 } } },
    ] as never);
  };
  const values = (col: string) =>
    driver.all(`SELECT "${col}" AS v FROM "dv_sync" ORDER BY id`).map((r) => r.v);

  it("add later: existing rows show the value, the index exists, the next sync is in sync", async () => {
    await sync([fx.DvSyncV0], { force: true });
    await seed();

    const result = await sync([fx.DvSyncV1]);
    expect(result.status).toBe("synced");
    expect(entry(result)).toMatchObject({
      status: "alter",
      columnsAdded: ["customerId"],
      errors: [],
    });
    expect(values("customerId")).toEqual(["a", "b"]);
    expect(xinfo("dv_sync").find((c) => c.name === "customerId")!.hidden).toBe(2);
    expect(managedIndexes("dv_sync")).toEqual(["atscript__plain__customerId"]);
    expect((await sync([fx.DvSyncV1])).status).toBe("up-to-date");
    expect(entry(await sync([fx.DvSyncV1], { force: true })).status).toBe("in-sync");
  });

  it("expression, leaf type, rename and removal", async () => {
    await sync([fx.DvSyncV1], { force: true });
    await seed();

    const pathChange = await sync([fx.DvSyncV2]);
    expect(entry(pathChange)).toMatchObject({
      status: "alter",
      derivedChanges: [{ column: "customerId", reason: "expression", derived: true }],
      errors: [],
    });
    expect(values("customerId")).toEqual(["A", null]);
    expect(managedIndexes("dv_sync")).toEqual(["atscript__plain__customerId"]);
    expect((await sync([fx.DvSyncV2])).status).toBe("up-to-date");

    const typeChange = await sync([fx.DvSyncV3]);
    expect(entry(typeChange).derivedChanges).toEqual([
      { column: "customerId", reason: "expression", derived: true },
    ]);
    expect(values("customerId")).toEqual([1, 2]);
    expect(xinfo("dv_sync").find((c) => c.name === "customerId")!.type).toBe("REAL");
    expect((await sync([fx.DvSyncV3])).status).toBe("up-to-date");

    // Rename AND expression change (number leaf → string leaf) in one sync
    const rename = await sync([fx.DvSyncV4]);
    expect(entry(rename)).toMatchObject({
      status: "alter",
      columnsRenamed: ["custId"],
      derivedChanges: [{ column: "custId", reason: "expression", derived: true }],
      errors: [],
    });
    expect(values("custId")).toEqual(["a", "b"]);
    expect((await sync([fx.DvSyncV4])).status).toBe("up-to-date");
    expect(xinfo("dv_sync").find((c) => c.name === "custId")!.hidden).toBe(2);
    expect(managedIndexes("dv_sync")).toEqual(["atscript__plain__custId"]);

    const removal = await sync([fx.DvSyncV0]);
    expect(entry(removal)).toMatchObject({
      status: "alter",
      columnsDropped: ["custId"],
      errors: [],
    });
    expect(xinfo("dv_sync").map((c) => c.name)).toEqual(["id", "payload"]);
    expect(managedIndexes("dv_sync")).toEqual([]);
    expect(driver.all(`SELECT count(*) AS n FROM "dv_sync"`)).toEqual([{ n: 2 }]);
    expect((await sync([fx.DvSyncV0])).status).toBe("up-to-date");
  });

  it("kind change both ways is a drop + add (stored values of a regular column are lost)", async () => {
    await sync([fx.DvSyncK], { force: true });
    await seed();
    await space.getTable(fx.DvSyncK).updateMany({}, { customerId: "stored" } as never);

    const toDerived = await sync([fx.DvSyncV1]);
    expect(entry(toDerived)).toMatchObject({
      status: "alter",
      derivedChanges: [{ column: "customerId", reason: "kind", derived: true }],
      errors: [],
    });
    expect(values("customerId")).toEqual(["a", "b"]);
    expect(xinfo("dv_sync").find((c) => c.name === "customerId")!.hidden).toBe(2);

    const back = await sync([fx.DvSyncK]);
    expect(entry(back)).toMatchObject({
      derivedChanges: [{ column: "customerId", reason: "kind", derived: false }],
      errors: [],
    });
    expect(values("customerId")).toEqual([null, null]);
    expect(xinfo("dv_sync").find((c) => c.name === "customerId")!.hidden).toBe(0);
    await space.getTable(fx.DvSyncK).updateOne({ id: 1, customerId: "again" } as never);
    expect(values("customerId")).toEqual(["again", null]);
    expect((await sync([fx.DvSyncK])).status).toBe("up-to-date");
  });

  it("safe mode skips the rebuild and keeps the change pending", async () => {
    await sync([fx.DvSyncV1], { force: true });
    await seed();
    const plan = await planSchema(space, [fx.DvSyncV2], { safe: true });
    expect(entry(plan).skipped).toEqual(["derived"]);
    const safe = await sync([fx.DvSyncV2], { safe: true });
    expect(entry(safe)).toMatchObject({ skipped: ["derived"], pending: true, errors: [] });
    expect(values("customerId")).toEqual(["a", "b"]);
    // Still pending: the next unsafe run applies it without --force
    const applied = await sync([fx.DvSyncV2]);
    expect(applied.status).toBe("synced");
    expect(values("customerId")).toEqual(["A", null]);
    expect((await sync([fx.DvSyncV2])).status).toBe("up-to-date");
  });
});
