import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { Collection, MongoClient } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// A `@meta.id` move that also removes the old key field, on a populated
// collection (mongodb-memory-server): the old field is `$unset` only once the
// managed `__pk` unique index on it is gone — with it, every document after the
// first collided on `{ id: null }` (E11000) and the sync was half-applied.

let server: any;
let client: MongoClient;
let fx: Record<string, any>;

const PK_INDEX = "atscript__unique___pk";
const ROWS = [
  { id: 1, studentId: 1, courseId: 1, grade: "A" },
  { id: 2, studentId: 1, courseId: 2, grade: "B" },
  { id: 3, studentId: 2, courseId: 1 },
];

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/pk-change.as");
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

/** A database whose `pk_enrollments` is synced with the old key and holds `rows`. */
async function seeded(name: string, rows: Array<Record<string, unknown>>) {
  const db = client.db(name);
  const space = new DbSpace(() => new MongoAdapter(db, client));
  expect((await new SchemaSync(space).run([fx.EnrollmentBefore], { force: true })).status).toBe(
    "synced",
  );
  const raw: Collection = db.collection("pk_enrollments");
  await raw.insertMany(rows.map((r) => ({ ...r })));
  return { space, raw };
}

async function pkIndexKey(raw: Collection): Promise<unknown> {
  return (await raw.indexes()).find((i) => i.name === PK_INDEX)?.key;
}

/** Documents without `_id`, ordered by the new key. */
async function docs(raw: Collection) {
  const all = await raw.find({}, { sort: { studentId: 1, courseId: 1 } }).toArray();
  return all.map(({ _id, ...rest }) => rest);
}

const entryOf = (r: { entries: Array<{ name: string }> }) =>
  r.entries.find((e) => e.name === "pk_enrollments") as any;

const REBUILT = [
  { studentId: 1, courseId: 1, grade: "A" },
  { studentId: 1, courseId: 2, grade: "B" },
  { studentId: 2, courseId: 1 },
];

async function expectRebuilt(space: DbSpace, raw: Collection): Promise<void> {
  expect(await docs(raw)).toEqual(REBUILT);
  expect(await pkIndexKey(raw)).toEqual({ studentId: 1, courseId: 1 });
  // The new key is enforced
  const table = space.getTable(fx.EnrollmentAfter);
  await expect(table.insertOne({ studentId: 1, courseId: 1 } as never)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  await table.insertOne({ studentId: 2, courseId: 2 } as never);
  expect(await raw.countDocuments()).toBe(4);
  expect((await new SchemaSync(space).run([fx.EnrollmentAfter])).status).toBe("up-to-date");
}

describe("[mongo] primary-key change that removes the old key field", () => {
  it("rebuilds the key on a populated collection and drops the old field", async () => {
    const { space, raw } = await seeded("pk_change_ok", ROWS);
    expect(await pkIndexKey(raw)).toEqual({ id: 1 });
    const pkChange = {
      from: ["id"],
      to: ["studentId", "courseId"],
      rebuild: true,
      populated: true,
    };

    // Safe mode skips the rebuild — the old `__pk` index and field stay —
    // reported identically by plan and run
    const plan = await new SchemaSync(space).plan([fx.EnrollmentAfter], { safe: true });
    const safe = await new SchemaSync(space).run([fx.EnrollmentAfter], { force: true, safe: true });
    for (const e of [entryOf(plan), entryOf(safe)]) {
      expect(e.pkChange).toEqual({ ...pkChange, rebuild: false });
      expect(e.skipped).toEqual(["pk-rebuild"]);
    }
    expect(entryOf(safe).pending).toBe(true);
    expect(await pkIndexKey(raw)).toEqual({ id: 1 });
    expect(await raw.countDocuments({ id: { $exists: true } })).toBe(3);

    // The next run without safe rebuilds it (pending: no force needed)
    const result = await new SchemaSync(space).run([fx.EnrollmentAfter]);
    expect(result.status).toBe("synced");
    const entry = entryOf(result);
    expect(entry.errors).toEqual([]);
    expect(entry.pkChange).toEqual(pkChange);
    expect(entry.columnsDropped).toEqual(["id"]);
    await expectRebuilt(space, raw);
  });

  it("refuses documents the new key cannot hold before any change", async () => {
    const { space, raw } = await seeded("pk_change_dups", [
      ...ROWS,
      { id: 4, studentId: 1, courseId: 1 },
    ]);
    const result = await new SchemaSync(space).run([fx.EnrollmentAfter], {
      force: true,
      onError: "silent",
    });
    expect(result.status).toBe("refused");
    const entry = result.entries.find((e) => e.name === "pk_enrollments")!;
    expect(entry.refused).toBe(true);
    expect(entry.errors).toEqual([
      'Primary key of "pk_enrollments" changed (id → studentId, courseId) but 2 rows have a NULL or duplicate (studentId, courseId) — fix or remove them (or migrate manually) and re-run.',
    ]);
    expect(await raw.countDocuments({ id: { $exists: true } })).toBe(4);
    expect(await pkIndexKey(raw)).toEqual({ id: 1 });
  });

  it("completes a collection an earlier run left half-applied (some documents lost the old field)", async () => {
    const { space, raw } = await seeded("pk_change_resume", ROWS);
    // What <= 0.1.155 left behind: the first document's `id` unset, the old
    // `__pk` index still in place, the stored snapshot still the old one.
    await raw.updateOne({ id: 1 }, { $unset: { id: "" } });

    const result = await new SchemaSync(space).run([fx.EnrollmentAfter], { force: true });
    expect(result.status).toBe("synced");
    expect(result.entries.find((e) => e.name === "pk_enrollments")!.errors).toEqual([]);
    await expectRebuilt(space, raw);
  });
});
