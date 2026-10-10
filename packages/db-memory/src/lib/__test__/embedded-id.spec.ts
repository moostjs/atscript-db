import { describe, it, expect, beforeAll } from "vite-plus/test";

import { createTestSpace, prepareFixtures } from "./test-utils";

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/embedded-id.as");
});

const order = (id: number, lineId: string) => ({ id, line: { lineId, qty: 1 }, audit: {} });

describe("[memory] embedded @meta.id and number.timestamp.created", () => {
  it("the host key alone identifies a row: same id, other embedded id conflicts", async () => {
    const table = createTestSpace().getTable(fx.EmbOrder);
    await table.ensureTable();
    expect(table.primaryKeys).toEqual(["id"]);
    await table.insertOne(order(1, "a") as any);
    await expect(table.insertOne(order(1, "b") as any)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await table.insertOne(order(2, "a") as any);
    await table.replaceOne({ ...order(1, "c"), createdAt: 1, audit: { at: 1 } } as any);
    expect(await table.findById(1)).toMatchObject({ line: { lineId: "c" } });
    expect(await table.count()).toBe(2);
  });

  it("fills number.timestamp.created, also inside an embedded object", async () => {
    const table = createTestSpace().getTable(fx.EmbOrder);
    await table.ensureTable();
    const before = Date.now();
    await table.insertOne(order(1, "a") as any);
    const row = (await table.findById(1)) as any;
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
    expect(row.audit.at).toBeGreaterThanOrEqual(before);
  });
});
