import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise. Override the server with `ATSCRIPT_PG_TEST_URL` (or
// `POSTGRES_TEST_URI`; an admin connection — the spec creates and drops its
// own `r16_union_pg` database).
//
// Since 0.1.155: `T | null` is a nullable column of T's type; a union of
// objects is flattened with `__` (member-only leaves nullable), no parent
// column; a union mixing an object with another type is one JSONB column.

const DB = "r16_union_pg";

const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

const card = { kind: "card", card: "4111", amount: 10 };
const bank = { kind: "bank", iban: "DE89", amount: 20 };
const nulls = { note: null, qty: null, paid: null, status: null, code: null, tags: null };
const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

async function columns(table: string): Promise<string[]> {
  const rows = await driver.all<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_name = $1 AND table_schema = current_schema() ORDER BY ordinal_position`,
    [table],
  );
  return rows.map(
    (r) => `${r.column_name} ${r.data_type}${r.is_nullable === "NO" ? " NOT NULL" : ""}`,
  );
}

describe.skipIf(!reachable)("[postgres live] union columns", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/union-columns.as");
    driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
    space = new DbSpace(() => new PostgresAdapter(driver));
    expect((await syncSchema(space, [fx.UcOrder])).status).toBe("synced");
  });

  afterAll(async () => {
    await driver?.close();
    await dropPgDatabase(DB);
  });

  const orders = (): any => space.getTable(fx.UcOrder);

  it("creates nullable columns of T's type and flattened union columns", async () => {
    expect(await columns("uc_orders")).toEqual([
      "id double precision NOT NULL",
      "note text",
      "qty integer",
      "paid boolean",
      "status text",
      "code character varying",
      "tags jsonb",
      "addr__street text",
      "addr__zip text",
      "payment__kind text NOT NULL",
      "payment__card text",
      "payment__amount double precision NOT NULL",
      "payment__iban text",
      "payment__bic text",
      "refund__kind text",
      "refund__card text",
      "refund__amount double precision",
      "refund__iban text",
      "refund__bic text",
      "extra jsonb NOT NULL",
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
      'CREATE TABLE "uc_legacy" ("id" DOUBLE PRECISION PRIMARY KEY, "note" TEXT NOT NULL, "qty" TEXT NOT NULL, "addr" TEXT NOT NULL, "addr.street" TEXT NOT NULL, "addr.zip" TEXT, "refund" TEXT NOT NULL, "refund.kind" TEXT NOT NULL, "refund.card" TEXT NOT NULL, "refund.amount" DOUBLE PRECISION NOT NULL, "refund.iban" TEXT NOT NULL, "refund.bic" TEXT, "extra" TEXT NOT NULL, "extra.street" TEXT NOT NULL, "extra.zip" TEXT)',
    );
    await driver.exec(`INSERT INTO "uc_legacy" VALUES
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
      "id double precision NOT NULL",
      "note text",
      "qty double precision",
      "extra jsonb NOT NULL",
      "addr__street text",
      "addr__zip text",
      "refund__kind text",
      "refund__card text",
      "refund__amount double precision",
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
      'CREATE TABLE "uc_legacy_bad" ("id" DOUBLE PRECISION PRIMARY KEY, "addr" TEXT NOT NULL, "addr.street" TEXT NOT NULL, "addr.zip" TEXT)',
    );
    await driver.exec(`INSERT INTO "uc_legacy_bad" VALUES (1, '{"street":', '', NULL)`);
    const result = await syncSchema(space, [fx.UcLegacyBad], { force: true });
    const entry = result.entries.find((e) => e.name === "uc_legacy_bad")!;
    expect(entry.status).toBe("error");
    expect(entry.errors.join(" ")).toMatch(/JSON column copy failed on uc_legacy_bad/);
    expect(await columns("uc_legacy_bad")).toContain("addr text NOT NULL");
  });

  it("`@db.json` keeps an old union column's data", async () => {
    await driver.exec(
      'CREATE TABLE "uc_legacy_json" ("id" DOUBLE PRECISION PRIMARY KEY, "addr" TEXT NOT NULL, "addr.street" TEXT NOT NULL, "addr.zip" TEXT)',
    );
    await driver.run(`INSERT INTO "uc_legacy_json" VALUES (1, '{"street":"Main"}', '', NULL)`);
    const result = await syncSchema(space, [fx.UcLegacyJson], { force: true });
    expect(result.entries.find((e) => e.name === "uc_legacy_json")?.status).toBe("alter");
    expect(await columns("uc_legacy_json")).toEqual(["id double precision NOT NULL", "addr jsonb"]);
    expect(await space.getTable(fx.UcLegacyJson).findOne({ filter: { id: 1 } })).toEqual({
      id: 1,
      addr: { street: "Main" },
    });
  });
});
