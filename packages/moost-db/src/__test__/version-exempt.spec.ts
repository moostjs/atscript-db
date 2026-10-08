import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createAdapter as createMemory } from "@atscript/db-memory";
import { createAdapter as createSqlite } from "@atscript/db-sqlite";
import type { DbSpace } from "@atscript/db";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { createMockApp, prepareFixtures } from "./test-utils";

/**
 * `@db.column.version.exempt` through HTTP PATCH / PUT (since 0.1.150): the
 * schema rule applies unchanged — a body without `version` that patches only
 * exempt fields does not bump; with `version` it is `$cas` (check + bump).
 */

let VxRecord: any;

beforeAll(async () => {
  await prepareFixtures();
  VxRecord = (await import("./fixtures/version-exempt.as")).VxRecord;
});

describe.each([
  { name: "memory", create: () => createMemory(), sql: false },
  { name: "sqlite", create: () => createSqlite(":memory:"), sql: true },
])("version-exempt over HTTP CRUD — $name", ({ create, sql }) => {
  const spaces: DbSpace[] = [];
  afterAll(async () => {
    for (const space of spaces) await space.close();
  });

  async function setup() {
    const space = create();
    spaces.push(space);
    const table = space.getTable(VxRecord);
    if (sql) await space.getAdapter(VxRecord).ensureTable();
    await table.insertMany([
      { id: 1, title: "a", status: "open", score: 0 },
      { id: 2, title: "b", status: "open", score: 0 },
    ] as never);
    const controller = new AsDbController(createMockApp(), table as any);
    const version = async (id: number) =>
      ((await table.findOne({ filter: { id }, controls: {} })) as any).version as number;
    return { controller, table, version };
  }

  it("PATCH {id, score} without version keeps the version", async () => {
    const { controller, version } = await setup();
    const result = (await controller.update({ id: 1, score: 7 })) as any;
    expect(result.matchedCount).toBe(1);
    expect(await version(1)).toBe(0);
  });

  it("PATCH {id, score, version} is a CAS write: bumps, stale → 409", async () => {
    const { controller, version } = await setup();
    await controller.update({ id: 1, score: 7, version: 0 });
    expect(await version(1)).toBe(1);
    const err = await controller.update({ id: 1, score: 8, version: 0 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).body.statusCode).toBe(409);
  });

  it("PATCH {id, title} bumps", async () => {
    const { controller, version } = await setup();
    await controller.update({ id: 1, title: "x" });
    expect(await version(1)).toBe(1);
  });

  it("bulk PATCH bumps only the non-exempt row", async () => {
    const { controller, version } = await setup();
    await controller.update([
      { id: 1, score: 1 },
      { id: 2, title: "x" },
    ]);
    expect(await version(1)).toBe(0);
    expect(await version(2)).toBe(1);
  });

  it("PUT (replace) bumps", async () => {
    const { controller, version } = await setup();
    await controller.replace({ id: 1, title: "a", status: "open", score: 3 });
    expect(await version(1)).toBe(1);
  });
});
