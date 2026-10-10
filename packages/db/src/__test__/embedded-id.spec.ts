import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";

import { MockAdapter, prepareFixtures } from "./test-utils";

let EmbOrder: any;
let EmbComposite: any;
let EmbNoId: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ EmbOrder, EmbComposite, EmbNoId } = await import("./fixtures/embedded-id.as"));
});

const order = {
  id: 1,
  line: { lineId: "l1", qty: 1 },
  lineNull: null,
  lineJson: { lineId: "l2", qty: 2 },
  lines: [{ lineId: "l3", qty: 3 }],
  wrap: { wid: 1, line: { lineId: "l4", qty: 4 } },
  inline: { v: 1 },
  target: { id: 9, name: "t" },
  targetId: 9,
};

describe("@meta.id inside an embedded object", () => {
  it("does not join the host's primary key", () => {
    const orders = new AtscriptDbTable(EmbOrder, new MockAdapter());
    expect(orders.primaryKeys).toEqual(["id"]);
    expect(orders.fieldDescriptors.filter((d) => d.isPrimaryKey).map((d) => d.path)).toEqual([
      "id",
    ]);
    expect(new AtscriptDbTable(EmbComposite, new MockAdapter()).primaryKeys).toEqual(["a", "b"]);
  });

  it("gives a host without its own @meta.id no primary key", () => {
    expect(new AtscriptDbTable(EmbNoId, new MockAdapter()).primaryKeys).toEqual([]);
  });

  it("is no unique key", () => {
    const orders = new AtscriptDbTable(EmbOrder, new MockAdapter());
    expect([...orders.uniqueProps]).toEqual([]);
  });

  it("identifies a row by the host key alone", async () => {
    const adapter = new MockAdapter();
    const orders = new AtscriptDbTable(EmbOrder, adapter);
    await orders.insertOne(order as any);
    expect(await orders.findById(1)).toMatchObject({ id: 1, line: { lineId: "l1" } });
    await expect(orders.replaceOne(order as any)).resolves.toBeDefined();
    await expect(
      orders.updateOne({ id: 1, line: { lineId: "x", qty: 5 } } as any),
    ).resolves.toMatchObject({ matchedCount: 1 });
  });

  it("an embedded @meta.id with a default is optional on replace", async () => {
    const orders = new AtscriptDbTable(EmbOrder, new MockAdapter());
    await orders.insertOne(order as any);
    await expect(orders.replaceOne({ ...order, inline: { v: 2 } } as any)).resolves.toBeDefined();
  });
});
