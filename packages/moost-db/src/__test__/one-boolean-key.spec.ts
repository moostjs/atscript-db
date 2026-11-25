/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { createAdapter as createMemory } from "@atscript/db-memory";
import { createAdapter as createSqlite } from "@atscript/db-sqlite";
import { SchemaSync } from "@atscript/db/sync";
import { MoostHttp } from "@moostjs/event-http";
import { Inherit, Moost, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { prepareFixtures } from "./test-utils";

/**
 * `GET /one?id=…&active=true` on a composite primary key with a boolean part
 * (since 0.1.192): the URL's `true` / `false` address the row — what
 * `@atscript/db-client` sends for `client.one({ id, active: true })`. Before,
 * the text never matched a boolean key part: 404 without a read.
 */

let BkDraft: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ BkDraft } = await import("./fixtures/boolean-key.as"));
});

let SEQ = 0;

async function boot(kind: "sqlite" | "memory") {
  getMoostInfact()._cleanup();
  const space = kind === "sqlite" ? createSqlite(":memory:") : createMemory();
  expect((await new SchemaSync(space).run([BkDraft], { force: true })).status).toBe("synced");
  await space.getTable(BkDraft).insertMany([
    { id: "a", active: true, title: "live" },
    { id: "a", active: false, title: "draft" },
  ]);
  const prefix = `bk${++SEQ}`;

  @TableController(space.getTable(BkDraft), prefix)
  @Inherit()
  class Drafts extends AsDbController {}

  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(Drafts);
  await app.init();
  return async (query: string) => {
    const res = (await http.request(`/${prefix}/one?${query}`, { method: "GET" }))!;
    return { status: res.status, body: (await res.json()) as any };
  };
}

describe.each(["sqlite", "memory"] as const)("[%s] GET /one with a boolean key part", (kind) => {
  it.each([
    ["true", "live"],
    ["false", "draft"],
  ])("active=%s answers the %s row", async (active, title) => {
    const get = await boot(kind);
    const res = await get(`id=a&active=${active}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "a", active: active === "true", title });
  });

  it("any other text is no key value: 404", async () => {
    const get = await boot(kind);
    expect((await get("id=a&active=maybe")).status).toBe(404);
    expect((await get("id=a&active=1")).status).toBe(404);
  });
});
