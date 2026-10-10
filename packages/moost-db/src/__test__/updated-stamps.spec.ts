import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createAdapter as createMemory } from "@atscript/db-memory";
import type { DbSpace } from "@atscript/db";

import { AsDbController } from "../as-db.controller";
import { createMockApp, prepareFixtures } from "./test-utils";

// `number.timestamp.updated` over HTTP (atscript 0.1.106 / db 0.1.156): PATCH
// and PUT set it to the server's time whatever the body carries — a client
// cannot forge it on an update. POST keeps a supplied value, like
// `number.timestamp.created`. `/meta.type` keeps both annotations so forms
// and db-client treat it as server-managed.

let UpdDoc: any;
const OLD = 1_700_000_000_000;
const spaces: DbSpace[] = [];

beforeAll(async () => {
  await prepareFixtures();
  ({ UpdDoc } = await import("./fixtures/updated-stamps.as"));
});

afterAll(async () => {
  for (const space of spaces) await space.close();
});

function bind() {
  const space = createMemory();
  spaces.push(space);
  const table = space.getTable(UpdDoc);
  return { controller: new AsDbController(createMockApp(), table as any), table };
}

describe("number.timestamp.updated over HTTP", () => {
  it("POST fills an omitted value and keeps a supplied one", async () => {
    const { controller, table } = bind();
    const before = Date.now();
    await controller.insert({ id: 1, audit: {} });
    await controller.insert({ id: 2, updatedAt: OLD, audit: { at: OLD } });
    const row = (await table.findById(1)) as any;
    expect(row.updatedAt).toBeGreaterThanOrEqual(before);
    expect(row.audit.at).toBeGreaterThanOrEqual(before);
    expect(await table.findById(2)).toMatchObject({ updatedAt: OLD, audit: { at: OLD } });
  });

  it("PATCH sets it, overriding the body's value — single and bulk", async () => {
    const { controller, table } = bind();
    await table.insertMany([1, 2, 3].map((id) => ({ id, updatedAt: OLD, audit: { at: OLD } })));
    const before = Date.now();
    await controller.update({ id: 1, title: "a", updatedAt: OLD });
    await controller.update([
      { id: 2, title: "b", updatedAt: OLD },
      { id: 3, audit: { note: "n", at: OLD } },
    ]);
    for (const id of [1, 2, 3]) {
      expect(((await table.findById(id)) as any).updatedAt, `${id}`).toBeGreaterThanOrEqual(before);
    }
    expect(((await table.findById(1)) as any).audit.at).toBe(OLD);
    expect(((await table.findById(3)) as any).audit.at).toBeGreaterThanOrEqual(before);
  });

  it("PUT sets it, overriding the body's value — single and bulk", async () => {
    const { controller, table } = bind();
    await table.insertMany([1, 2].map((id) => ({ id, updatedAt: OLD, audit: { at: OLD } })));
    const before = Date.now();
    await controller.replace({ id: 1, updatedAt: OLD, audit: { at: OLD } });
    await controller.replace([{ id: 2, title: "b", audit: {} }]);
    for (const id of [1, 2]) {
      const row = (await table.findById(id)) as any;
      expect(row.updatedAt, `${id}`).toBeGreaterThanOrEqual(before);
      expect(row.audit.at, `${id}`).toBeGreaterThanOrEqual(before);
    }
  });

  it("/meta.type keeps db.default.now and db.onUpdate.now", async () => {
    const { props } = ((await bind().controller.meta()) as any).type.type;
    expect(props.updatedAt.metadata).toMatchObject({
      "db.default.now": true,
      "db.onUpdate.now": true,
    });
  });
});
