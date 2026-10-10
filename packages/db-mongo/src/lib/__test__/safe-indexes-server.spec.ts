import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Collection, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Safe mode and the indexes that depend on a column change
// (mongodb-memory-server): an index over a column whose type change safe mode
// skipped keeps its live definition until the change runs; a nullability
// change has no column constraint on MongoDB — only the snapshot and the
// present-only filter of a unique index change, in safe mode too, and the
// collection is not recreated.

let server: any;
let client: MongoClient;
let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/safe-indexes.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

/** A fresh database's space, synced with `model` and holding `rows` in `table`. */
async function seeded(name: string, model: any, table: string, rows: object[]) {
  const db = client.db(name);
  const space = new DbSpace(() => new MongoAdapter(db, client));
  expect((await new SchemaSync(space).run([model], { force: true })).status).toBe("synced");
  const raw: Collection = db.collection(table);
  await raw.insertMany(rows.map((r) => ({ ...r })));
  return { space, raw };
}

async function filterOf(raw: Collection, name: string): Promise<unknown> {
  return (await raw.indexes()).find((i) => i.name === name)?.partialFilterExpression;
}

describe("[mongo] safe mode and dependent indexes", () => {
  it("keeps the index over a column whose type change is skipped, until the change runs", async () => {
    const { space, raw } = await seeded("safe_type", fx.CodeText, "safe_codes", [
      { id: 1, code: "a" },
      { id: 2, code: "b" },
    ]);
    const index = "atscript__unique__code_uq";
    expect(await filterOf(raw, index)).toEqual({ code: { $type: "string" } });

    const plan = await new SchemaSync(space).plan([fx.CodeNumber], { safe: true });
    const safe = await new SchemaSync(space).run([fx.CodeNumber], { force: true, safe: true });
    for (const e of [plan.entries[0]!, safe.entries[0]!]) {
      expect(e.skipped).toEqual(["recreate"]);
      expect(e.typeChanges).toEqual([{ column: "code", fromType: "string", toType: "number" }]);
    }
    // The stored strings stay unique
    expect(await filterOf(raw, index)).toEqual({ code: { $type: "string" } });
    await expect(raw.insertOne({ id: 3, code: "a" })).rejects.toThrow(/E11000/);

    // The next run without safe drops and recreates the collection (`'drop'`)
    const run = await new SchemaSync(space).run([fx.CodeNumber]);
    expect(run.entries[0]!.recreated).toBe(true);
    expect(await filterOf(raw, index)).toEqual({ code: { $type: "number" } });
  });

  it("applies a nullability change as an index change, without a recreate — in safe mode too", async () => {
    const { space, raw } = await seeded("safe_nullable", fx.TitleRequired, "safe_titles", [
      { id: 1, title: "a" },
      { id: 2, title: "b" },
    ]);
    const index = "atscript__unique__title_uq";
    expect(await filterOf(raw, index)).toBeUndefined();
    const recreate = vi.spyOn(MongoAdapter.prototype, "recreateTable");

    const plan = await new SchemaSync(space).plan([fx.TitleOptional], { safe: true });
    const safe = await new SchemaSync(space).run([fx.TitleOptional], { force: true, safe: true });
    for (const e of [plan.entries[0]!, safe.entries[0]!]) {
      expect(e.skipped).toEqual([]);
      expect(e.pending).toBe(false);
    }
    expect(await filterOf(raw, index)).toEqual({ title: { $type: "string" } });
    expect((await new SchemaSync(space).run([fx.TitleOptional])).status).toBe("up-to-date");

    // Back to required, without safe: still no recreate
    const run = await new SchemaSync(space).run([fx.TitleRequired]);
    expect(run.entries[0]!.recreated).toBe(false);
    expect(await filterOf(raw, index)).toBeUndefined();
    expect(recreate).not.toHaveBeenCalled();
    recreate.mockRestore();
    expect(await raw.countDocuments()).toBe(2);
  });
});
