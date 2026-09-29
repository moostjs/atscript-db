import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { AsDbController } from "../as-db.controller";
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, errorsOf, prepareFixtures, transformed } from "./test-utils";

// `@db.column.derived` through the HTTP controller (since 0.1.141): `/meta`
// flags derived fields, writes drop them, `$inc` on one is a 400; `/meta.type`
// keeps the `db.column.derived` annotation (since 0.1.142) for db-client
// preflight — covered in db-client's client-derived.spec.ts.

let DvOrder: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ DvOrder } = await import("./fixtures/derived.as"));
});

function bind() {
  let adapter!: MockAdapter;
  const db = new DbSpace(() => (adapter = new MockAdapter()));
  const table = db.getTable(DvOrder);
  return { controller: new AsDbController(makeApp(), table as any), adapter, table };
}

describe("derived columns over HTTP", () => {
  it("/meta marks derived fields and nothing else", async () => {
    const meta = await bind().controller.meta();
    expect(meta.fields.customerId).toMatchObject({
      derived: true,
      filterable: true,
      sortable: true,
    });
    expect(meta.fields.region).toMatchObject({ derived: true });
    expect(meta.fields.payload).not.toHaveProperty("derived");
    expect(meta.fields.status).not.toHaveProperty("derived");
    expect(Object.values(meta.fields).filter((f: any) => f.derived).length).toBe(5);
  });

  it("insert and update drop supplied derived values", async () => {
    const { controller, adapter } = bind();
    await controller.insert({
      id: 1,
      status: "open",
      payload: { customer: { id: "c1", vip: true }, total: 3 },
      customerId: "zzz",
      amount: 99,
    });
    const inserted = adapter.calls.find((c) => c.method === "insertMany")!.args[0][0];
    expect(Object.keys(inserted).toSorted()).toEqual(["id", "payload", "status"]);

    await controller.update({ id: 1, status: "paid", vip: false });
    const [, patch] = adapter.calls.find((c) => c.method === "updateOne")!.args;
    expect(patch).toEqual({ status: "paid" });
  });

  it("$inc on a derived field is a 400 naming the field", async () => {
    const { controller, adapter } = bind();
    const reply = await transformed(controller.update({ id: 1, amount: { $inc: 1 } }));
    expect(reply.body.statusCode).toBe(400);
    expect(errorsOf(reply)[0]).toMatchObject({
      path: "amount",
      message: expect.stringContaining("not allowed on a @db.column.derived field"),
    });
    expect(adapter.calls.some((c) => c.method === "updateOne")).toBe(false);
  });

  it("/meta.type keeps db.column.derived on every derived prop and still strips other db.* keys", async () => {
    const { props } = ((await bind().controller.meta()) as any).type.type;
    for (const name of ["customerId", "vip", "amount", "region", "tier"]) {
      expect(props[name].metadata["db.column.derived"]).toBe(true);
    }
    expect(props.status.metadata["db.column.derived"]).toBeUndefined();
    expect(props.payload.metadata["db.column.derived"]).toBeUndefined();
    // Physical/storage annotations on the same props are still stripped.
    expect(props.region.metadata["db.column"]).toBeUndefined();
    expect(props.region.metadata["db.index.unique"]).toBeUndefined();
    expect(props.customerId.metadata["db.index.plain"]).toBeUndefined();
    expect(props.tier.metadata["db.column.collate"]).toBeUndefined();
  });
});
