import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createAdapter as createMemory } from "@atscript/db-memory";
import type { DbSpace } from "@atscript/db";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { createMockApp, prepareFixtures } from "./test-utils";

// `@normalize.*` over HTTP (since 0.1.170): POST / PUT / PATCH store the
// normalized values (the table normalizes every write), a CAS miss on a row
// addressed by a normalized unique key is told apart from a missing row, and
// `/meta.type` serves the annotations so db-client and forms normalize alike.
// Equality filters and ids in the URL normalize their operand (the table does).

let NwhAccount: any;
const spaces: DbSpace[] = [];

beforeAll(async () => {
  await prepareFixtures();
  ({ NwhAccount } = await import("./fixtures/normalize-writes.as"));
});

afterAll(async () => {
  for (const space of spaces) await space.close();
});

async function bind() {
  const space = createMemory();
  spaces.push(space);
  const table = space.getTable(NwhAccount);
  await table.ensureTable();
  await table.syncIndexes();
  return { controller: new AsDbController(createMockApp(), table as any), table };
}

describe("@normalize.* over HTTP", () => {
  it("POST / PUT / PATCH store normalized values", async () => {
    const { controller, table } = await bind();
    await controller.insert({ id: 1, email: " Ann@X.io ", name: " Ann " });
    expect(await table.findById(1)).toMatchObject({ email: "ann@x.io", name: "Ann" });
    await controller.replace({ id: 1, email: "ANN@x.io", name: " Ann R" });
    expect(await table.findById(1)).toMatchObject({ email: "ann@x.io", name: "Ann R" });
    await controller.update([{ id: 1, name: "  Ann P  " }]);
    expect(await table.findById(1)).toMatchObject({ name: "Ann P" });
  });

  it("a stale version on a row addressed by its unique key is 409, not 404", async () => {
    const { controller, table } = await bind();
    await table.insertOne({ id: 1, email: "ann@x.io", name: "Ann" });
    const res = await controller
      .update({ email: " ANN@X.IO ", name: "x", version: 7 })
      .catch((e: unknown) => e);
    expect(res).toBeInstanceOf(HttpError);
    expect((res as HttpError).body.statusCode).toBe(409);
  });

  it("GET /query equality filters and GET /one/:id find the normalized value", async () => {
    const { controller, table } = await bind();
    await table.insertOne({ id: 1, email: "ann@x.io", name: "Ann" });
    const byEmail = (await controller.query("?email='ANN@X.IO'")) as Array<{ id: number }>;
    expect(byEmail.map((r) => r.id)).toEqual([1]);
    const byIn = (await controller.query("?email{'ANN@X.IO',b}")) as Array<{ id: number }>;
    expect(byIn.map((r) => r.id)).toEqual([1]);
    expect(await controller.getOne("ANN@X.IO", "")).toMatchObject({ id: 1 });
  });

  it("/meta.type keeps the normalize annotations", async () => {
    const { controller } = await bind();
    const { props } = ((await controller.meta()) as any).type.type;
    expect(props.email.metadata).toMatchObject({
      "normalize.trim": true,
      "normalize.lowercase": true,
    });
  });
});
