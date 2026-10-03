import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { planSchema, syncSchema } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";

// Server-gated (see relation-filter.live.spec.ts): a foreign key into a table
// of another schema, and introspection of a schema-less table when the
// connection's current schema is not `public`.

const SERVER_URL =
  process.env.ATSCRIPT_PG_TEST_URL ?? "postgresql://postgres:test@127.0.0.1:54371/postgres";
const DB = "relfix_xs";

async function adminQuery(sql: string, database?: string): Promise<boolean> {
  try {
    const { Client } = (await import("pg")).default;
    const url = new URL(SERVER_URL);
    if (database) url.pathname = `/${database}`;
    const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 1500 });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
    return true;
  } catch {
    return false;
  }
}

const reachable = await adminQuery("SELECT 1");

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;
const types = () => [fx.XsOwner, fx.XsItem, fx.XsPlain];

describe.skipIf(!reachable)("[postgres live] cross-schema FKs + non-public current schema", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/cross-schema-live.as");
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}"`);
    await adminQuery(`CREATE DATABASE "${DB}"`);
    await adminQuery(`CREATE SCHEMA "relfix_sp"`, DB);
    const url = new URL(SERVER_URL);
    url.pathname = `/${DB}`;
    // schema-less tables live in `relfix_sp`, not `public`
    url.searchParams.set("options", "-c search_path=relfix_sp");
    driver = new PgDriver({ connectionString: url.toString() });
    space = new DbSpace(() => new PostgresAdapter(driver));
  });

  afterAll(async () => {
    await driver?.close();
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}"`);
  });

  it("creates a table whose FK targets another schema", async () => {
    const result = await syncSchema(space, types());
    expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
    expect(result.status).toBe("synced");
    const fks = await driver.all<{ ref: string }>(
      `SELECT confrelid::regclass::text AS ref FROM pg_constraint
        WHERE contype = 'f' AND conrelid = 'relfix_sp.xs_items'::regclass`,
    );
    expect(fks.map((r) => r.ref)).toEqual(["relfix_xs.xs_owners"]);
  });

  it("introspects schema-less tables in the connection's current schema: a second sync is a no-op", async () => {
    expect((await syncSchema(space, types())).status).toBe("up-to-date");
    const plan = await planSchema(space, types(), { force: true });
    expect(
      plan.entries.filter((e) => e.status !== "in-sync").map((e) => [e.name, e.status]),
    ).toEqual([]);
    for (const type of types()) {
      await (space.getTable(type).getAdapter() as PostgresAdapter).syncForeignKeys();
    }
    expect(await space.getReferencingForeignKeys("xs_owners")).toBeDefined();
  });

  it("predicates and the native cascade work across the schemas", async () => {
    await space.getTable(fx.XsOwner).insertMany([
      { id: "o1", name: "A" },
      { id: "o2", name: "B" },
    ]);
    await space.getTable(fx.XsItem).insertMany([
      { id: 1, title: "x", ownerId: "o1" },
      { id: 2, title: "y", ownerId: "o2" },
    ]);
    const items = space.getTable(fx.XsItem);
    expect(
      (await items.findMany({ filter: { owner: { $some: { name: "A" } } } } as any)).map(
        (r: any) => r.id,
      ),
    ).toEqual([1]);
    await space.getTable(fx.XsOwner).deleteMany({ items: { $some: { title: "y" } } } as any);
    expect((await items.findMany({ filter: {} } as any)).map((r: any) => r.id)).toEqual([1]);
  });
});
