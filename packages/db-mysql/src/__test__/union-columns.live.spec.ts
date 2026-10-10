import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL when one is reachable, skips
// otherwise. Override the server with `ATSCRIPT_MYSQL_TEST_URL` (or
// `MYSQL_TEST_URI`; an admin connection — the spec creates and drops its own
// `r16_union_my` database).
//
// Since 0.1.155: `T | null` is a nullable column of T's type; a union of
// objects is flattened with `__` (member-only leaves nullable), no parent
// column; a union mixing an object with another type is one JSON column
// (read as text — `jsonStrings` — so a string member stays a string).

const DB = "r16_union_my";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;

const card = { kind: "card", card: "4111", amount: 10 };
const bank = { kind: "bank", iban: "DE89", amount: 20 };
const nulls = { note: null, qty: null, paid: null, status: null, code: null, tags: null };
const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

async function columns(table: string): Promise<string[]> {
  const rows = await driver.all<{ name: string; type: string; nullable: string }>(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS
     WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE() ORDER BY ORDINAL_POSITION`,
    [table],
  );
  return rows.map((r) => `${r.name} ${r.type}${r.nullable === "NO" ? " NOT NULL" : ""}`);
}

describe.skipIf(!reachable)("[mysql live] union columns", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/union-columns.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver));
    expect((await syncSchema(space, [fx.UcOrder])).status).toBe("synced");
  });

  afterAll(async () => {
    await driver?.close();
    await dropMysqlDatabase(DB);
  });

  const orders = (): any => space.getTable(fx.UcOrder);

  it("creates nullable columns of T's type and flattened union columns", async () => {
    expect(await columns("uc_orders")).toEqual([
      "id double NOT NULL",
      "note text",
      "qty int",
      "paid tinyint(1)",
      "status text",
      "code varchar(10)",
      "tags json",
      "addr__street text",
      "addr__zip text",
      "payment__kind text NOT NULL",
      "payment__card text",
      "payment__amount double NOT NULL",
      "payment__iban text",
      "payment__bic text",
      "refund__kind text",
      "refund__card text",
      "refund__amount double",
      "refund__iban text",
      "refund__bic text",
      "extra json NOT NULL",
      "shipping__street text",
      "shipping__city text",
    ]);
  });

  it("round-trips null and values (a JSON string member stays a string)", async () => {
    await orders().insertOne({
      id: 1,
      ...nulls,
      addr: null,
      payment: card,
      refund: null,
      extra: "7",
    });
    await orders().insertOne({
      id: 2,
      note: "n",
      qty: 5,
      paid: true,
      status: "open",
      code: "C1",
      tags: ["a"],
      addr: { street: "Main" },
      payment: bank,
      refund: card,
      extra: { street: "Side" },
      shipping: { street: "Dock", city: "Port" },
    });
    expect(await orders().findMany({ filter: {}, controls: { $sort: { id: 1 } } })).toEqual([
      { id: 1, ...nulls, addr: null, payment: card, refund: null, extra: "7", shipping: null },
      {
        id: 2,
        note: "n",
        qty: 5,
        paid: true,
        status: "open",
        code: "C1",
        tags: ["a"],
        addr: { street: "Main", zip: null },
        payment: bank,
        refund: card,
        extra: { street: "Side" },
        shipping: { street: "Dock", city: "Port" },
      },
    ]);
  });

  it("filters and sorts by a nested path; a patch switches the member", async () => {
    expect(ids(await orders().findMany({ filter: { "payment.card": "4111" } }))).toEqual([1]);
    expect(ids(await orders().findMany({ filter: { "refund.kind": null } }))).toEqual([1]);
    // null tests on the whole object test its columns (since 0.1.155)
    expect(ids(await orders().findMany({ filter: { addr: null } }))).toEqual([1]);
    expect(ids(await orders().findMany({ filter: { refund: { $ne: null } } }))).toEqual([2]);
    expect(
      ids(await orders().findMany({ filter: {}, controls: { $sort: { "payment.amount": -1 } } })),
    ).toEqual([2, 1]);
    await orders().updateOne({ id: 2, payment: card, refund: null, extra: "x" });
    const row = await orders().findOne({ filter: { id: 2 } });
    expect([row.payment, row.refund, row.extra]).toEqual([card, null, "x"]);
  });

  it("copies the old JSON text into the new columns in place, then drops the old ones", async () => {
    // The table as 0.1.154 created it for `UcLegacy`, holding what it wrote:
    // objects as JSON text, a string member as plain text
    await driver.exec(
      "CREATE TABLE `uc_legacy` (`id` DOUBLE PRIMARY KEY, `note` TEXT NOT NULL, `qty` TEXT NOT NULL, `addr` TEXT NOT NULL, `addr.street` TEXT NOT NULL, `addr.zip` TEXT, `refund` TEXT NOT NULL, `refund.kind` TEXT NOT NULL, `refund.card` TEXT NOT NULL, `refund.amount` DOUBLE NOT NULL, `refund.iban` TEXT NOT NULL, `refund.bic` TEXT, `extra` TEXT NOT NULL, `extra.street` TEXT NOT NULL, `extra.zip` TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
    await driver.exec(`INSERT INTO \`uc_legacy\` VALUES
      (1, 'n', '5', '{"street":"Main","zip":"Z"}', '', NULL, '{"kind":"card","card":"4111","amount":10}', '', '', 0, '', NULL, '{"street":"Side"}', '', NULL),
      (2, 'm', '7.5', 'null', '', NULL, '{"kind":"bank","iban":"DE89","amount":20,"bic":"B"}', '', '', 0, '', NULL, 'plain', '', NULL),
      (3, 'k', '1', 'null', '', NULL, 'null', '', '', 0, '', NULL, '42 Main St', '', NULL),
      (4, 'j', '2', 'null', '', NULL, 'null', '', '', 0, '', NULL, '{draft}', '', NULL)`);
    const result = await syncSchema(space, [fx.UcLegacy], { force: true });
    const entry = result.entries.find((e) => e.name === "uc_legacy")!;
    expect(entry.status).toBe("alter");
    expect(entry.recreated).toBeFalsy();
    expect(entry.jsonCopies.map((c) => c.from)).toEqual(["addr", "refund"]);
    expect(entry.jsonified).toEqual(["extra"]);
    expect(await columns("uc_legacy")).toEqual([
      "id double NOT NULL",
      "note text",
      "qty double",
      "extra json NOT NULL",
      "addr__street text",
      "addr__zip text",
      "refund__kind text",
      "refund__card text",
      "refund__amount double",
      "refund__iban text",
      "refund__bic text",
    ]);
    expect(
      await space.getTable(fx.UcLegacy).findMany({ filter: {}, controls: { $sort: { id: 1 } } }),
    ).toEqual([
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
        qty: 7.5,
        addr: null,
        refund: { kind: "bank", iban: "DE89", amount: 20, bic: "B" },
        extra: "plain",
      },
      { id: 3, note: "k", qty: 1, addr: null, refund: null, extra: "42 Main St" },
      { id: 4, note: "j", qty: 2, addr: null, refund: null, extra: "{draft}" },
    ]);
  });

  it("refuses the table when an old value is malformed JSON — nothing is dropped", async () => {
    await driver.exec(
      "CREATE TABLE `uc_legacy_bad` (`id` DOUBLE PRIMARY KEY, `addr` TEXT NOT NULL, `addr.street` TEXT NOT NULL, `addr.zip` TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
    await driver.exec(`INSERT INTO \`uc_legacy_bad\` VALUES (1, '{"street":', '', NULL)`);
    const result = await syncSchema(space, [fx.UcLegacyBad], { force: true });
    const entry = result.entries.find((e) => e.name === "uc_legacy_bad")!;
    expect(entry.status).toBe("error");
    expect(entry.errors.join(" ")).toMatch(/JSON column copy failed on uc_legacy_bad/);
    expect(await columns("uc_legacy_bad")).toContain("addr text NOT NULL");
  });

  it("`@db.json` keeps an old union column's data", async () => {
    await driver.exec(
      "CREATE TABLE `uc_legacy_json` (`id` DOUBLE PRIMARY KEY, `addr` TEXT NOT NULL, `addr.street` TEXT NOT NULL, `addr.zip` TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
    await driver.run(`INSERT INTO \`uc_legacy_json\` VALUES (1, '{"street":"Main"}', '', NULL)`);
    const result = await syncSchema(space, [fx.UcLegacyJson], { force: true });
    expect(result.entries.find((e) => e.name === "uc_legacy_json")?.status).toBe("alter");
    expect(await columns("uc_legacy_json")).toEqual(["id double NOT NULL", "addr json"]);
    expect(await space.getTable(fx.UcLegacyJson).findOne({ filter: { id: 1 } })).toEqual({
      id: 1,
      addr: { street: "Main" },
    });
  });

  it("copies into columns with a default, then applies the defaults", async () => {
    await driver.exec(
      "CREATE TABLE `uc_legacy_default` (`id` DOUBLE PRIMARY KEY, `addr` TEXT NOT NULL, `addr.street` TEXT, `addr.zip` TEXT, `addr.ref` TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
    await driver.exec(
      'INSERT INTO `uc_legacy_default` VALUES (1, \'{"street":"Main","ref":"r1"}\', NULL, NULL, NULL), (2, \'null\', NULL, NULL, NULL)',
    );
    const result = await syncSchema(space, [fx.UcLegacyDefault], { force: true });
    const entry = result.entries.find((e) => e.name === "uc_legacy_default")!;
    expect(entry.errors).toEqual([]);
    expect(entry.status).toBe("alter");
    const table = space.getTable(fx.UcLegacyDefault);
    // copied values only — the defaults fill no existing row
    expect(await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } })).toEqual([
      { id: 1, addr: { street: "Main", zip: null, ref: "r1" } },
      { id: 2, addr: null },
    ]);
    await table.insertOne({ id: 3, addr: { street: "New" } } as any);
    const row = (await table.findById(3)) as any;
    expect(row.addr.zip).toBe("D");
    expect(row.addr.ref).toMatch(/^[0-9a-f-]{36}$/);
    expect((await syncSchema(space, [fx.UcLegacyDefault])).status).toBe("up-to-date");
  });

  it("a table needing a JSON copy, a timestamp default and a key rebuild at once", async () => {
    // 0.1.154: `addr` as JSON text, the embedded `lineId` in the key, `created` without default
    await driver.exec(
      "CREATE TABLE `uc_legacy_mixed` (`id` DOUBLE NOT NULL, `line__lineId` VARCHAR(255) NOT NULL, `line__qty` DOUBLE NOT NULL, `created` DOUBLE NOT NULL, `addr` TEXT NOT NULL, `addr.street` TEXT NOT NULL, `addr.zip` TEXT, PRIMARY KEY (`id`, `line__lineId`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
    await driver.exec(`INSERT INTO \`uc_legacy_mixed\` VALUES
      (1, 'a', 1, 1700000000123, '{"street":"Main","zip":"Z"}', '', NULL),
      (2, 'b', 2, 1700000000456, 'null', '', NULL)`);
    const result = await syncSchema(space, [fx.UcLegacyMixed], { force: true });
    const entry = result.entries.find((e) => e.name === "uc_legacy_mixed")!;
    expect(entry.errors).toEqual([]);
    expect(entry.jsonCopies.map((c) => c.from)).toEqual(["addr"]);
    expect(entry.pkChange).toMatchObject({ from: ["id", "line__lineId"], to: ["id"] });
    expect(await columns("uc_legacy_mixed")).toEqual([
      "id double NOT NULL",
      "line__lineId text NOT NULL",
      "line__qty double NOT NULL",
      "created timestamp NOT NULL",
      "addr__street text",
      "addr__zip text",
    ]);
    const table = space.getTable(fx.UcLegacyMixed);
    // `created` is a TIMESTAMP now (whole seconds)
    expect(await table.findMany({ filter: {}, controls: { $sort: { id: 1 } } })).toEqual([
      {
        id: 1,
        line: { lineId: "a", qty: 1 },
        created: 1700000000000,
        addr: { street: "Main", zip: "Z" },
      },
      { id: 2, line: { lineId: "b", qty: 2 }, created: 1700000000000, addr: null },
    ]);
    await table.insertOne({ id: 3, line: { lineId: "a", qty: 1 }, addr: null } as any);
    expect(((await table.findById(3)) as any).created).toBeGreaterThan(1700000000456);
    await expect(
      table.insertOne({ id: 1, line: { lineId: "c", qty: 1 }, addr: null } as any),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await syncSchema(space, [fx.UcLegacyMixed])).status).toBe("up-to-date");
  });

  it("a `T | null` object whose `@meta.id` was in the key: copied, key rebuilt", async () => {
    await driver.exec(
      "CREATE TABLE `uc_legacy_line` (`id` DOUBLE NOT NULL, `line` TEXT NOT NULL, `line.lineId` VARCHAR(255) NOT NULL, `line.qty` DOUBLE NOT NULL, PRIMARY KEY (`id`, `line.lineId`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
    await driver.exec(
      "INSERT INTO `uc_legacy_line` VALUES (1, '{\"lineId\":\"a\",\"qty\":1}', '', 0), (2, 'null', '', 0)",
    );
    const result = await syncSchema(space, [fx.UcLegacyLine], { force: true });
    const entry = result.entries.find((e) => e.name === "uc_legacy_line")!;
    expect(entry.errors).toEqual([]);
    expect(entry.pkChange).toMatchObject({ from: ["id", "line.lineId"], to: ["id"] });
    expect(await columns("uc_legacy_line")).toEqual([
      "id double NOT NULL",
      "line__lineId text",
      "line__qty double",
    ]);
    expect(
      await space
        .getTable(fx.UcLegacyLine)
        .findMany({ filter: {}, controls: { $sort: { id: 1 } } }),
    ).toEqual([
      { id: 1, line: { lineId: "a", qty: 1 } },
      { id: 2, line: null },
    ]);
    expect((await syncSchema(space, [fx.UcLegacyLine])).status).toBe("up-to-date");
  });

  it("an object leaving `@db.json` is copied into its columns, required ones NOT NULL", async () => {
    expect((await syncSchema(space, [fx.UcUnjsonOld], { force: true })).status).toBe("synced");
    await space.getTable(fx.UcUnjsonOld).insertMany([
      { id: 1, addr: { street: "Main", zip: "Z" } },
      { id: 2, addr: { street: "Side" } },
    ] as any);
    const result = await syncSchema(space, [fx.UcUnjson], { force: true });
    const entry = result.entries.find((e) => e.name === "uc_unjson")!;
    expect(entry.errors).toEqual([]);
    expect(entry.jsonCopies).toEqual([{ from: "addr", to: ["addr__street", "addr__zip"] }]);
    // added nullable for the copy (a NOT NULL column's type default would hide
    // every row from it), NOT NULL afterwards
    expect(await columns("uc_unjson")).toEqual([
      "id double NOT NULL",
      "addr__street text NOT NULL",
      "addr__zip text",
    ]);
    expect(
      await space.getTable(fx.UcUnjson).findMany({ filter: {}, controls: { $sort: { id: 1 } } }),
    ).toEqual([
      { id: 1, addr: { street: "Main", zip: "Z" } },
      { id: 2, addr: { street: "Side", zip: null } },
    ]);
    expect((await syncSchema(space, [fx.UcUnjson])).status).toBe("up-to-date");
  });

  it("a `db.geoPoint | null` text column of the earlier layout becomes POINT", async () => {
    await driver.exec("CREATE TABLE `uc_geo` (`id` DOUBLE PRIMARY KEY, `geo` TEXT) ENGINE=InnoDB");
    await driver.exec("INSERT INTO `uc_geo` VALUES (1, '[-122.42,37.77]'), (2, NULL)");
    const result = await syncSchema(space, [fx.UcGeo], { force: true });
    const entry = result.entries.find((e) => e.name === "uc_geo")!;
    expect(entry.errors).toEqual([]);
    expect(await columns("uc_geo")).toEqual(["id double NOT NULL", "geo point"]);
    const rows = (await space
      .getTable(fx.UcGeo)
      .findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[];
    expect(rows[0].geo[0]).toBeCloseTo(-122.42, 9);
    expect(rows[0].geo[1]).toBeCloseTo(37.77, 9);
    expect(rows[1].geo ?? null).toBeNull();
  });
});
