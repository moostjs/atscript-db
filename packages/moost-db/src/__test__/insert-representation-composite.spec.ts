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
 * `POST /` on a composite-primary-key table (since 0.1.169): `insertedId` is
 * the primary-key object, and `Prefer: return=representation` answers the row
 * `GET /one?left=…&right=…` answers. Before, the id was SQLite's rowid and the
 * read-back looked it up as a scalar: no row, or the row whose unique `code`
 * equals the rowid.
 */

let IrepPair: any;
let IrepNote: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ IrepPair, IrepNote } = await import("./fixtures/insert-representation.as"));
});

/** An id reported as a class instance (like a driver's `ObjectId`): a scalar, not a key object. */
class BoxedId {
  constructor(readonly value: unknown) {}
  toString() {
    return String(this.value);
  }
}

let SEQ = 0;

async function boot(type: "pairs" | "boxed" = "pairs") {
  getMoostInfact()._cleanup();
  const space = type === "pairs" ? createSqlite(":memory:") : createMemory();
  const model = type === "pairs" ? IrepPair : IrepNote;
  expect((await new SchemaSync(space).run([model], { force: true })).status).toBe("synced");
  if (type === "boxed") {
    // The adapter reports every id boxed in a class instance.
    const adapter = space.getAdapter(model) as any;
    const insertMany = adapter.insertMany.bind(adapter);
    adapter.insertMany = async (rows: unknown[]) => {
      const result = await insertMany(rows);
      return { ...result, insertedIds: result.insertedIds.map((id: unknown) => new BoxedId(id)) };
    };
  }
  const prefix = `irepc${++SEQ}`;

  @TableController(space.getTable(model), prefix)
  @Inherit()
  class Pairs extends AsDbController {
    protected override returnRepresentation(): boolean {
      return true;
    }
  }

  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(Pairs);
  await app.init();
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = (await http.request(`/${prefix}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }))!;
    return { status: res.status, body: (await res.json()) as any };
  };
  const get = async (path: string) => {
    const res = (await http.request(`/${prefix}${path}`, { method: "GET" }))!;
    return { status: res.status, body: (await res.json()) as any };
  };
  return { post, get };
}

describe("POST / on a composite primary key", () => {
  it("answers the primary-key object as insertedId", async () => {
    const { post } = await boot();
    expect((await post({ left: 1, right: "a", label: "A" })).body).toEqual({
      insertedId: { left: 1, right: "a" },
    });
    expect((await post([{ left: 1, right: "b", label: "B" }])).body).toEqual({
      insertedCount: 1,
      insertedIds: [{ left: 1, right: "b" }],
    });
  });

  it("return=representation answers the row GET /one?left=…&right=… answers", async () => {
    const { post, get } = await boot();
    const res = await post(
      { left: 1, right: "a", label: "A" },
      { prefer: "return=representation" },
    );
    expect(res.status).toBe(201);
    const one = await get("/one?left=1&right=a");
    expect(one.status).toBe(200);
    expect(res.body).toEqual({ insertedId: { left: 1, right: "a" }, row: one.body });
  });

  it("regression: the read-back never answers another row through a scalar unique key", async () => {
    const { post } = await boot();
    await post({ left: 10, right: "a", code: 2, label: "first" });
    // The second row's rowid is 2 — the first row's `code`.
    const res = await post(
      { left: 20, right: "b", code: 1, label: "second" },
      { prefer: "return=representation" },
    );
    expect(res.body.row).toMatchObject({ left: 20, right: "b", label: "second" });
    expect(res.body.insertedId).toEqual({ left: 20, right: "b" });
  });

  it("an id that is a class instance (e.g. an ObjectId) is read back as a scalar id", async () => {
    const { post } = await boot("boxed");
    const res = await post(
      { id: 1, title: "a", tenant: "t1" },
      { prefer: "return=representation" },
    );
    expect(res.body.row).toMatchObject({ id: 1, title: "a" });
  });
});
