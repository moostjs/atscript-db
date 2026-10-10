/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import { TableController } from "../decorators";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { bootHttp, createMockApp as makeApp, prepareFixtures, type THttpSend } from "./test-utils";

/**
 * A null test on a whole object over HTTP (since 0.1.155): `refund=null`,
 * `refund!=null` pass the gate (none / some of the object's leaves hold a
 * value); any other comparison on the object stays a 400.
 */

let http: THttpSend;
let UcOrder: any;
let UcAccount: any;
const PREFIX = "uc-orders";
const card = { kind: "card", card: "4111", amount: 10 };
const bank = { kind: "bank", iban: "DE89", amount: 20 };

beforeAll(async () => {
  await prepareFixtures();
  ({ UcOrder, UcAccount } = await import("./fixtures/union-columns.as"));
  getMoostInfact()._cleanup();
  const orders = createAdapter().getTable(UcOrder);
  await orders.insertMany([
    { id: 1, qty: null, payment: card, refund: null, extra: "x" },
    { id: 2, qty: 5, payment: bank, refund: bank, extra: "y" },
  ] as never);

  @TableController(orders, PREFIX)
  class Orders extends AsDbReadableController {}

  const accounts = createAdapter().getTable(UcAccount);
  await accounts.insertMany([{ id: 1, creds: { hash: "h" } }, { id: 2 }] as never);

  @TableController(accounts, "uc-accounts")
  class Accounts extends AsDbReadableController {}

  http = await bootHttp(Orders, Accounts);
});

async function ids(qs: string): Promise<number[]> {
  const res = await http("GET", `/${PREFIX}/query?${qs}`);
  expect(res.status, qs).toBe(200);
  return (res.body as Array<{ id: number }>).map((r) => r.id).toSorted((a, b) => a - b);
}

describe("URL null tests on an object field", () => {
  it("refund=null / refund!=null", async () => {
    expect(await ids("refund=null")).toEqual([1]);
    expect(await ids("refund!=null")).toEqual([2]);
  });

  it("any other comparison on the object is a 400", async () => {
    const res = await http("GET", `/${PREFIX}/query?payment=card`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/nested object/);
  });

  it("an object with a writeOnly leaf takes no null test — it would probe the sealed value", async () => {
    const res = await http("GET", "/uc-accounts/query?creds!=null");
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/nested object/);
  });

  it("reaches a flattening adapter as tests on the leaf columns", async () => {
    const adapters: MockAdapter[] = [];
    const db = new DbSpace(() => {
      const a = new MockAdapter();
      adapters.push(a);
      return a;
    });
    await new AsDbController(makeApp(), db.getTable(UcOrder) as any).query("?refund=null");
    const call = adapters[0]!.calls.find((c) => c.method === "findMany")!;
    expect(call.args[0].filter).toEqual({
      $and: [
        { refund__kind: { $exists: false } },
        { refund__card: { $exists: false } },
        { refund__amount: { $exists: false } },
        { refund__iban: { $exists: false } },
        { refund__bic: { $exists: false } },
      ],
    });
  });
});
