import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";

import { MockAdapter, prepareFixtures } from "./test-utils";

// Since 0.1.155 a full-row write (insert, replace) on relational storage
// writes NULL for the columns below an absent optional / `| null` object and
// for the leaves of union members the written member does not declare — a
// column left out of the row would take its `DEFAULT` (a `now` default made an
// absent object reappear on read).

let PdEvent: any;
let UcOrder: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ PdEvent } = await import("./fixtures/primitive-defaults.as"));
  ({ UcOrder } = await import("./fixtures/union-columns.as"));
});

/** An adapter whose engine applies `now` itself (a DDL DEFAULT). */
class NativeNowAdapter extends MockAdapter {
  override nativeDefaultFns() {
    return new Set(["now" as const]);
  }
}

const event = {
  id: 1,
  updatedAt: 1,
  mixed: "a",
  pair: [1, "a"],
  stamps: [],
  sourceCreatedAt: 1,
  sourceClosedAt: null,
  name: "n",
  history: [],
  payload: {},
  steps: [{ at: 1 }, { note: "n" }],
  events: [],
  audit: {},
};

const order = {
  id: 1,
  note: null,
  qty: null,
  paid: null,
  status: null,
  code: null,
  tags: null,
  addr: null,
  refund: null,
  extra: "x",
};

/** The row of the last `insertOne` (an `insertMany` of one row) / `replaceOne` (its data). */
function written(adapter: MockAdapter, method: "insertOne" | "replaceOne") {
  const names = method === "insertOne" ? ["insertOne", "insertMany"] : [method];
  const call = adapter.calls.filter((c) => names.includes(c.method)).at(-1)!;
  return (call.method === "insertMany" ? call.args[0].at(-1) : call.args.at(-1)) as Record<
    string,
    unknown
  >;
}

describe("full-row writes on relational storage", () => {
  it("an absent optional object's columns are NULL, a present one's default applies", async () => {
    const adapter = new NativeNowAdapter();
    const table = new AtscriptDbTable(PdEvent, adapter);
    await table.insertOne({ ...event } as any);
    const row = written(adapter, "insertOne");
    expect(row).toHaveProperty("maybeAudit__at", null);
    // present object: the omitted leaf is left to the engine default
    expect(row).not.toHaveProperty("audit__at");

    await table.insertOne({ ...event, id: 2, maybeAudit: {} } as any);
    expect(written(adapter, "insertOne")).not.toHaveProperty("maybeAudit__at");

    await table.replaceOne({ ...event } as any);
    expect(written(adapter, "replaceOne")).toHaveProperty("maybeAudit__at", null);
  });

  it("the leaves of the members not written are NULL", async () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(UcOrder, adapter);
    await table.insertOne({ ...order, payment: { kind: "bank", iban: "DE", amount: 1 } } as any);
    expect(written(adapter, "insertOne")).toMatchObject({
      payment__kind: "bank",
      payment__iban: "DE",
      payment__card: null,
      payment__bic: null,
      // absent `shipping?`
      shipping__street: null,
      shipping__city: null,
    });

    await table.replaceOne({ ...order, payment: { kind: "card", card: "4", amount: 1 } } as any);
    expect(written(adapter, "replaceOne")).toMatchObject({
      payment__card: "4",
      payment__iban: null,
      payment__bic: null,
    });
  });

  it("patches leave absent objects alone", async () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(UcOrder, adapter);
    await table.updateOne({ id: 1, note: "n" } as any);
    const patch = adapter.calls.find((c) => c.method === "updateOne")!.args[1];
    expect(Object.keys(patch)).toEqual(["note"]);
  });
});
