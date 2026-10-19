import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createAdapter as createMemory } from "@atscript/db-memory";
import type { DbSpace } from "@atscript/db";

import { AsDbController } from "../as-db.controller";
import { createMockApp, prepareFixtures } from "./test-utils";

// `@db.onUpdate.inc` over HTTP (since 0.1.162): PATCH and PUT increment it
// whatever the body carries — a client cannot forge it. `/meta.type` keeps the
// annotation so forms and db-client treat it as server-managed.

let CcDoc: any;
const spaces: DbSpace[] = [];

beforeAll(async () => {
  await prepareFixtures();
  ({ CcDoc } = await import("./fixtures/change-counter.as"));
});

afterAll(async () => {
  for (const space of spaces) await space.close();
});

function bind() {
  const space = createMemory();
  spaces.push(space);
  const table = space.getTable(CcDoc);
  return { controller: new AsDbController(createMockApp(), table as any), table };
}

const rev = async (table: any, id: number) => ((await table.findById(id)) as any).rev;

describe("@db.onUpdate.inc over HTTP", () => {
  it("POST may omit it (0)", async () => {
    const { controller, table } = bind();
    await controller.insert({ id: 1 });
    expect(await rev(table, 1)).toBe(0);
  });

  it("PATCH and PUT increment it, ignoring the body's value — single and bulk", async () => {
    const { controller, table } = bind();
    await table.insertMany([{ id: 1 }, { id: 2 }]);
    await controller.update({ id: 1, title: "a", rev: 100 });
    await controller.update([{ id: 2, title: "b", rev: 100 }]);
    await controller.replace({ id: 1, title: "c", rev: 100 });
    await controller.replace([{ id: 2 }]);
    expect(await rev(table, 1)).toBe(2);
    expect(await rev(table, 2)).toBe(2);
  });

  it("/meta.type keeps db.onUpdate.inc", async () => {
    const { props } = ((await bind().controller.meta()) as any).type.type;
    expect(props.rev.metadata).toMatchObject({ "db.onUpdate.inc": true });
  });
});
