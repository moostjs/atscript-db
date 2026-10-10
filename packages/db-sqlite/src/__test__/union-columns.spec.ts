import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { AtscriptDbTable, DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

// Since 0.1.155: `T | null` is a nullable column of T's type (a flattened
// object's leaves become nullable); a union of objects is flattened with `__`
// like a nested object, without a parent column; a union mixing an object
// with another type is one JSON column.

type Row = Record<string, any>;
let fx: Record<string, any>;

const card = { kind: "card", card: "4111", amount: 10 };
const bank = { kind: "bank", iban: "DE89", amount: 20 };

function columns(driver: BetterSqlite3Driver, table: string) {
  return driver
    .all<{ name: string; type: string; notnull: number }>(`PRAGMA table_info("${table}")`)
    .map((c) => `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}`);
}

describe("SQLite — union columns", () => {
  let driver: BetterSqlite3Driver;
  let table: AtscriptDbTable<any, Row, any, any, any, any, any>;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/union-columns.as");
  });

  beforeEach(async () => {
    driver = new BetterSqlite3Driver(":memory:");
    table = new AtscriptDbTable(fx.UcOrder, new SqliteAdapter(driver));
    await table.ensureTable();
  });

  afterEach(() => {
    driver.close();
  });

  it("lays out nullable unions and unions of objects", () => {
    expect(columns(driver, "uc_orders")).toEqual([
      "id INTEGER",
      "note TEXT",
      "qty REAL",
      "paid INTEGER",
      "status TEXT",
      "code TEXT",
      "tags TEXT",
      "addr__street TEXT",
      "addr__zip TEXT",
      "payment__kind TEXT NOT NULL",
      "payment__card TEXT",
      "payment__amount REAL NOT NULL",
      "payment__iban TEXT",
      "payment__bic TEXT",
      "refund__kind TEXT",
      "refund__card TEXT",
      "refund__amount REAL",
      "refund__iban TEXT",
      "refund__bic TEXT",
      "extra TEXT NOT NULL",
      "shipping__street TEXT",
      "shipping__city TEXT",
    ]);
  });

  it("stores null in every nullable union and reads it back as null", async () => {
    const nulls = { note: null, qty: null, paid: null, status: null, code: null, tags: null };
    await table.insertOne({ id: 1, ...nulls, addr: null, payment: card, refund: null, extra: "x" });
    expect(await table.findOne({ filter: { id: 1 } })).toEqual({
      id: 1,
      ...nulls,
      addr: null,
      payment: card,
      refund: null,
      extra: "x",
      shipping: null,
    });
  });

  it("round-trips values with the type of T", async () => {
    await table.insertOne({
      id: 1,
      note: "n",
      qty: 5,
      paid: true,
      status: "open",
      code: "C1",
      tags: ["a", "b"],
      addr: { street: "Main" },
      payment: bank,
      refund: { ...card, amount: 3 },
      extra: { street: "Side", zip: "Z" },
      shipping: { street: "Dock", city: "Port" },
    });
    expect(await table.findOne({ filter: { id: 1 } })).toEqual({
      id: 1,
      note: "n",
      qty: 5,
      paid: true,
      status: "open",
      code: "C1",
      tags: ["a", "b"],
      addr: { street: "Main", zip: null },
      // only the stored member's fields — `card` (Card only) is left out,
      // and so is `bic` (Bank only) while NULL
      payment: bank,
      refund: { ...card, amount: 3 },
      extra: { street: "Side", zip: "Z" },
      shipping: { street: "Dock", city: "Port" },
    });
  });

  it("filters and sorts by a nested path of a union of objects", async () => {
    const base = { note: null, qty: null, paid: null, status: null, code: null, tags: null };
    await table.insertOne({ id: 1, ...base, addr: null, payment: card, refund: null, extra: "a" });
    await table.insertOne({ id: 2, ...base, addr: null, payment: bank, refund: bank, extra: "b" });
    const ids = (rows: Row[]) => rows.map((r) => r.id);
    expect(ids(await table.findMany({ filter: { "payment.card": "4111" } }))).toEqual([1]);
    expect(ids(await table.findMany({ filter: { "refund.iban": "DE89" } }))).toEqual([2]);
    expect(ids(await table.findMany({ filter: { "refund.kind": null } }))).toEqual([1]);
    expect(
      ids(await table.findMany({ filter: {}, controls: { $sort: { "payment.amount": -1 } } })),
    ).toEqual([2, 1]);
    expect(
      await table.findMany({ filter: { id: 2 }, controls: { $select: ["id", "payment"] } }),
    ).toEqual([{ id: 2, payment: bank }]);
  });

  it("switching the member by patch or replace clears the other member's fields", async () => {
    const base = { note: null, qty: null, paid: null, status: null, code: null, tags: null };
    await table.insertOne({ id: 1, ...base, addr: null, payment: card, refund: card, extra: "a" });
    await table.updateOne({ id: 1, payment: { ...bank, bic: "B1" } });
    expect((await table.findOne({ filter: { id: 1 } }))?.payment).toEqual({ ...bank, bic: "B1" });
    await table.updateOne({ id: 1, payment: card, refund: null });
    const row = await table.findOne({ filter: { id: 1 } });
    expect(row?.payment).toEqual(card);
    expect(row?.refund).toBeNull();
    await table.replaceOne({ id: 1, ...base, addr: null, payment: bank, refund: null, extra: "7" });
    expect(driver.get(`SELECT "payment__card", "extra" FROM "uc_orders"`)).toEqual({
      payment__card: null,
      extra: '"7"',
    });
    expect((await table.findOne({ filter: { id: 1 } }))?.extra).toBe("7");
  });

  it("null tests on an object test its columns", async () => {
    const base = { note: null, qty: null, paid: null, status: null, code: null, tags: null };
    await table.insertOne({ id: 1, ...base, addr: null, payment: card, refund: null, extra: "a" });
    await table.insertOne({
      id: 2,
      ...base,
      addr: { street: "Main" },
      payment: bank,
      refund: bank,
      extra: "b",
      shipping: { street: "Dock", city: "Port" },
    });
    const ids = async (filter: Record<string, unknown>) =>
      (await table.findMany({ filter, controls: { $sort: { id: 1 } } })).map((r) => r.id);
    expect(await ids({ addr: null })).toEqual([1]);
    expect(await ids({ addr: { $ne: null } })).toEqual([2]);
    expect(await ids({ refund: { $exists: false } })).toEqual([1]);
    expect(await ids({ refund: { $exists: true } })).toEqual([2]);
    expect(await ids({ shipping: null })).toEqual([1]);
    expect(await ids({ $or: [{ shipping: { $ne: null } }, { id: 1 }] })).toEqual([1, 2]);
    // any other comparison on the whole object is still refused
    await expect(table.findMany({ filter: { addr: { street: "Main" } } })).rejects.toThrow(
      /nested object/,
    );
    await expect(table.findMany({ filter: {}, controls: { $sort: { addr: 1 } } })).rejects.toThrow(
      /nested object/,
    );
  });

  it("an object stored with no field set counts as null", async () => {
    const notes: AtscriptDbTable<any, Row, any, any, any, any, any> = new AtscriptDbTable(
      fx.UcNote,
      new SqliteAdapter(driver),
    );
    await notes.ensureTable();
    await notes.insertMany([{ id: 1, meta: {} }, { id: 2, meta: { tag: "x" } }, { id: 3 }]);
    const ids = async (filter: Record<string, unknown>) =>
      (await notes.findMany({ filter, controls: { $sort: { id: 1 } } })).map((r) => r.id);
    expect(await ids({ meta: null })).toEqual([1, 3]);
    expect(await ids({ meta: { $ne: null } })).toEqual([2]);
  });

  it("an optional object with required fields can be left out", async () => {
    const base = { note: null, qty: null, paid: null, status: null, code: null, tags: null };
    await table.insertOne({ id: 1, ...base, addr: null, payment: card, refund: null, extra: "" });
    expect((await table.findOne({ filter: { id: 1 } }))?.shipping).toBeNull();
  });
});

describe("SQLite — schema sync from the pre-0.1.155 union layout", () => {
  let driver: BetterSqlite3Driver;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/union-columns.as");
  });

  beforeEach(() => {
    driver = new BetterSqlite3Driver(":memory:");
  });

  afterEach(() => {
    driver.close();
  });

  it("copies the old JSON text into the new columns, then drops the old ones", async () => {
    // The table as 0.1.154 created it for `UcLegacy`, holding what it wrote:
    // objects as JSON text, a string member as plain text
    driver.exec(
      'CREATE TABLE "uc_legacy" ("id" INTEGER PRIMARY KEY, "note" TEXT NOT NULL, "qty" TEXT NOT NULL, "addr" TEXT NOT NULL, "addr.street" TEXT NOT NULL, "addr.zip" TEXT, "refund" TEXT NOT NULL, "refund.kind" TEXT NOT NULL, "refund.card" TEXT NOT NULL, "refund.amount" REAL NOT NULL, "refund.iban" TEXT NOT NULL, "refund.bic" TEXT, "extra" TEXT NOT NULL, "extra.street" TEXT NOT NULL, "extra.zip" TEXT)',
    );
    driver.exec(`INSERT INTO "uc_legacy" VALUES
      (1, 'n', '5.0', '{"street":"Main","zip":"Z"}', '', NULL, '{"kind":"card","card":"4111","amount":10}', '', '', 0, '', NULL, '{"street":"Side"}', '', NULL),
      (2, 'm', '7', 'null', '', NULL, '{"kind":"bank","iban":"DE89","amount":20,"bic":"B"}', '', '', 0, '', NULL, 'plain', '', NULL),
      (3, 'k', '1', 'null', '', NULL, 'null', '', '', 0, '', NULL, '42 Main St', '', NULL),
      (4, 'j', '2', 'null', '', NULL, 'null', '', '', 0, '', NULL, '{draft}', '', NULL)`);
    const space = new DbSpace(() => new SqliteAdapter(driver));
    const plan = await new SchemaSync(space).plan([fx.UcLegacy]);
    const entry = plan.entries.find((e) => e.name === "uc_legacy")!;
    expect(entry.jsonCopies).toEqual([
      { from: "addr", to: ["addr__street", "addr__zip"] },
      {
        from: "refund",
        to: ["refund__kind", "refund__card", "refund__amount", "refund__iban", "refund__bic"],
      },
    ]);
    expect(entry.jsonified).toEqual(["extra"]);
    expect(entry.columnsToDrop).toEqual([
      "addr",
      "addr.street",
      "addr.zip",
      "refund",
      "refund.kind",
      "refund.card",
      "refund.amount",
      "refund.iban",
      "refund.bic",
      "extra.street",
      "extra.zip",
    ]);
    expect(entry.typeChanges.map((t) => t.column)).toEqual(["qty"]);

    const result = await new SchemaSync(space).run([fx.UcLegacy], { force: true });
    expect(result.entries.find((e) => e.name === "uc_legacy")?.status).toBe("alter");
    expect(columns(driver, "uc_legacy")).toEqual([
      "id INTEGER",
      "note TEXT",
      "qty REAL",
      "addr__street TEXT",
      "addr__zip TEXT",
      "refund__kind TEXT",
      "refund__card TEXT",
      "refund__amount REAL",
      "refund__iban TEXT",
      "refund__bic TEXT",
      "extra TEXT NOT NULL",
    ]);
    const rows = await space
      .getTable(fx.UcLegacy)
      .findMany({ filter: {}, controls: { $sort: { id: 1 } } });
    expect(rows).toEqual([
      {
        id: 1,
        note: "n",
        qty: 5,
        addr: { street: "Main", zip: "Z" },
        refund: { kind: "card", card: "4111", amount: 10 },
        extra: { street: "Side" },
      },
      {
        id: 2,
        note: "m",
        qty: 7,
        addr: null,
        refund: { kind: "bank", iban: "DE89", amount: 20, bic: "B" },
        extra: "plain",
      },
      { id: 3, note: "k", qty: 1, addr: null, refund: null, extra: "42 Main St" },
      { id: 4, note: "j", qty: 2, addr: null, refund: null, extra: "{draft}" },
    ]);
  });

  it("copies into a column with a `@db.default`, then applies the default", async () => {
    driver.exec(
      'CREATE TABLE "uc_legacy_default" ("id" INTEGER PRIMARY KEY, "addr" TEXT NOT NULL, "addr.street" TEXT, "addr.zip" TEXT)',
    );
    driver.exec(
      `INSERT INTO "uc_legacy_default" VALUES (1, '{"street":"Main"}', NULL, NULL), (2, '{"street":"Side","zip":"Z"}', NULL, NULL), (3, 'null', NULL, NULL)`,
    );
    const space = new DbSpace(() => new SqliteAdapter(driver));
    const result = await new SchemaSync(space).run([fx.UcLegacyDefault], { force: true });
    const entry = result.entries.find((e) => e.name === "uc_legacy_default")!;
    expect(entry.errors).toEqual([]);
    expect(entry.status).toBe("alter");
    expect(entry.jsonCopies).toEqual([{ from: "addr", to: ["addr__street", "addr__zip"] }]);
    // the copy is not overwritten by the default: a row without the value keeps NULL
    const table = space.getTable(fx.UcLegacyDefault);
    expect(await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } })).toEqual([
      { id: 1, addr: { street: "Main", zip: null } },
      { id: 2, addr: { street: "Side", zip: "Z" } },
      { id: 3, addr: null },
    ]);
    const { sql } = driver.get(
      "SELECT sql FROM sqlite_master WHERE name = 'uc_legacy_default'",
    ) as { sql: string };
    expect(sql).toContain(`"addr__zip" TEXT DEFAULT 'D'`);
    expect((await new SchemaSync(space).run([fx.UcLegacyDefault])).status).toBe("up-to-date");
  });

  it("a column the snapshot knows as a scalar is dropped, not copied", async () => {
    const space = new DbSpace(() => new SqliteAdapter(driver));
    await new SchemaSync(space).run([fx.UcRetypedOld], { force: true });
    await space.getTable(fx.UcRetypedOld).insertOne({ id: 1, addr: "Main St 1" });
    const plan = await new SchemaSync(space).plan([fx.UcRetyped]);
    const entry = plan.entries.find((e) => e.name === "uc_retyped")!;
    expect(entry.status).toBe("alter");
    expect(entry.jsonCopies).toEqual([]);
    expect(entry.columnsToDrop).toEqual(["addr"]);
  });

  it("refuses the table when an old value is malformed JSON — nothing is dropped", async () => {
    driver.exec(
      'CREATE TABLE "uc_legacy_bad" ("id" INTEGER PRIMARY KEY, "addr" TEXT NOT NULL, "addr.street" TEXT NOT NULL, "addr.zip" TEXT)',
    );
    driver.exec(`INSERT INTO "uc_legacy_bad" VALUES (1, '{"street":', '', NULL)`);
    const space = new DbSpace(() => new SqliteAdapter(driver));
    const result = await new SchemaSync(space).run([fx.UcLegacyBad], { force: true });
    const entry = result.entries.find((e) => e.name === "uc_legacy_bad")!;
    expect(entry.status).toBe("error");
    expect(entry.errors.join(" ")).toMatch(
      /JSON column copy failed on uc_legacy_bad: .*malformed JSON/,
    );
    expect(columns(driver, "uc_legacy_bad")).toContain("addr TEXT NOT NULL");
    expect(driver.get(`SELECT "addr" FROM "uc_legacy_bad"`)).toEqual({ addr: '{"street":' });
  });

  it("`@db.json` keeps an old union column's data", async () => {
    driver.exec(
      'CREATE TABLE "uc_legacy_json" ("id" INTEGER PRIMARY KEY, "addr" TEXT NOT NULL, "addr.street" TEXT NOT NULL, "addr.zip" TEXT)',
    );
    driver.run(`INSERT INTO "uc_legacy_json" VALUES (1, '{"street":"Main"}', '', NULL)`);
    const space = new DbSpace(() => new SqliteAdapter(driver));
    const result = await new SchemaSync(space).run([fx.UcLegacyJson], { force: true });
    expect(result.entries.find((e) => e.name === "uc_legacy_json")?.status).toBe("alter");
    expect(columns(driver, "uc_legacy_json")).toEqual(["id INTEGER", "addr TEXT"]);
    expect(await space.getTable(fx.UcLegacyJson).findOne({ filter: { id: 1 } })).toEqual({
      id: 1,
      addr: { street: "Main" },
    });
  });
});
