import { expect } from "vite-plus/test";

/**
 * Shared end-to-end checks (since 0.1.162) for a table set built from
 * `fixtures/bulk-writes.as`: bounded `updateMany` / `deleteMany`,
 * `@db.onUpdate.inc` on every write path, `touchMany` stamping
 * `@db.onUpdate.now`, and the validated `updateMany` / `replaceMany` payloads.
 * The tables must exist and be empty.
 */
export interface TBulkWriteTables {
  tasks: any;
  owners: any;
  items: any;
}

const OLD = 1_700_000_000_000;
/** Whole seconds — a MySQL `TIMESTAMP` keeps no fraction. */
const sec = () => Math.floor(Date.now() / 1000) * 1000;

const task = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  status: "old",
  priority: id % 3,
  title: `t${id}`,
  ...over,
});

async function ids(table: any, filter: Record<string, unknown> = {}): Promise<number[]> {
  const rows = (await table.findMany({ filter, controls: { $sort: { id: 1 } } })) as any[];
  return rows.map((r) => r.id as number);
}

async function row(table: any, id: number): Promise<any> {
  return table.findById(id);
}

async function rejects(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
}

/** `@db.onUpdate.inc` on every SDK write path, and `touchMany` stamps. */
export async function checkOnUpdateInc({ tasks }: TBulkWriteTables): Promise<void> {
  await tasks.insertMany([1, 2, 3, 4, 5, 6].map((id) => task(id)));
  await tasks.insertOne(task(7, { rev: 7, updatedAt: OLD }));
  expect((await row(tasks, 1)).rev).toBe(0);
  expect((await row(tasks, 7)).rev).toBe(7);

  // patch: +1, the caller's value ignored
  await tasks.updateOne({ id: 1, title: "p", rev: 100 });
  expect(await row(tasks, 1)).toMatchObject({ rev: 1, version: 1 });
  // version-exempt patch: the version stays, the counter moves
  await tasks.updateOne({ id: 1, score: 5 });
  expect(await row(tasks, 1)).toMatchObject({ rev: 2, version: 1, score: 5 });
  // an empty patch writes nothing
  await tasks.updateOne({ id: 1, rev: 9 });
  expect((await row(tasks, 1)).rev).toBe(2);
  // a versioned touch through updateOne
  await tasks.updateOne({ id: 1, $cas: { version: 1 } });
  expect(await row(tasks, 1)).toMatchObject({ rev: 3, version: 2 });

  // bulkUpdate and updateMany (incl. exempt-only)
  await tasks.bulkUpdate([
    { id: 2, note: "b" },
    { id: 3, note: "b" },
  ]);
  await tasks.updateMany({ id: { $in: [3, 4] } }, { note: "m" });
  await tasks.updateMany({ id: 4 }, { score: 1 });
  expect((await row(tasks, 2)).rev).toBe(1);
  expect((await row(tasks, 3)).rev).toBe(2);
  expect(await row(tasks, 4)).toMatchObject({ rev: 2, version: 1 });

  // replaceOne, bulkReplace, replaceMany — a supplied counter is ignored
  await tasks.replaceOne(task(5, { title: "r", rev: 50 }));
  await tasks.bulkReplace([task(5, { title: "r2" }), task(6, { title: "r" })]);
  await tasks.replaceMany({ id: { $in: [5, 6] } }, { status: "x", priority: 1, title: "rm" });
  expect(await row(tasks, 5)).toMatchObject({ rev: 3, version: 3, title: "rm" });
  expect(await row(tasks, 6)).toMatchObject({ rev: 2, version: 2, title: "rm" });

  // touchMany: version, counter and the update time move
  const before = sec();
  const r7 = await row(tasks, 7);
  expect(r7.updatedAt).toBe(OLD);
  await tasks.touchMany([{ id: 7, version: r7.version }]);
  const t7 = await row(tasks, 7);
  expect(t7).toMatchObject({ rev: 8, version: r7.version + 1 });
  expect(t7.updatedAt).toBeGreaterThanOrEqual(before);
}

/** `updateMany` / `replaceMany` validate their payloads like the keyed writes. */
export async function checkBulkValidation({ tasks }: TBulkWriteTables): Promise<void> {
  await tasks.insertMany([1, 2].map((id) => task(id)));
  for (const data of [{ title: null }, { priority: -1 }, { title: "" }]) {
    const err = (await rejects(tasks.updateMany({}, data))) as Error;
    expect(err.name, JSON.stringify(data)).toBe("Validation Error");
  }
  for (const data of [
    { status: "s", priority: 1 },
    { status: "s", priority: 1, title: null },
  ]) {
    const err = (await rejects(tasks.replaceMany({ id: 1 }, data))) as Error;
    expect(err.name, JSON.stringify(data)).toBe("Validation Error");
  }
  expect(await row(tasks, 1)).toMatchObject({ title: "t1", rev: 0, version: 0 });
  // a valid keyless replace
  await tasks.replaceMany({ id: 1 }, { status: "s", priority: 2, title: "ok" });
  expect(await row(tasks, 1)).toMatchObject({ title: "ok", priority: 2, rev: 1 });
}

/** Bounded `updateMany` / `deleteMany`. */
export async function checkBoundedWrites({ tasks }: TBulkWriteTables): Promise<void> {
  // priorities: 1→1 2→2 3→0 4→1 5→2 6→0 7→1 8→2 9→0 10→1
  await tasks.insertMany(Array.from({ length: 10 }, (_, i) => task(i + 1)));

  // default order: primary key ascending
  expect(await tasks.updateMany({ status: "old" }, { note: "a" }, { limit: 3 })).toMatchObject({
    matchedCount: 3,
  });
  expect(await ids(tasks, { note: "a" })).toEqual([1, 2, 3]);
  const r1 = await row(tasks, 1);
  expect(r1).toMatchObject({ rev: 1, version: 1 });

  // explicit order with the PK tie-breaker in the last key's direction
  await tasks.updateMany({ status: "old" }, { note: "b" }, { limit: 2, sort: { priority: -1 } });
  expect(await ids(tasks, { note: "b" })).toEqual([5, 8]);
  await tasks.updateMany({}, { note: "c" }, { limit: 2, sort: { priority: 1 } });
  expect(await ids(tasks, { note: "c" })).toEqual([3, 6]);

  // a filter still applies on top of the bound
  await tasks.updateMany({ priority: 1 }, { status: "new" }, { limit: 2, sort: { id: -1 } });
  expect(await ids(tasks, { status: "new" })).toEqual([7, 10]);

  // bounded delete, then the loop-until-zero contract
  expect(await tasks.deleteMany({ status: "old" }, { limit: 3, sort: { id: -1 } })).toEqual({
    deletedCount: 3,
  });
  expect(await ids(tasks)).toEqual([1, 2, 3, 4, 5, 7, 10]);
  let rounds = 0;
  while ((await tasks.deleteMany({ status: "old" }, { limit: 2 })).deletedCount > 0) rounds++;
  expect(rounds).toBe(3);
  expect(await ids(tasks)).toEqual([7, 10]);

  const err = (await rejects(tasks.deleteMany({}, { limit: 0 }))) as { code?: string };
  expect(err.code).toBe("INVALID_QUERY");
  expect(await ids(tasks)).toEqual([7, 10]);
}

/** A bounded delete of parents with an `onDelete: cascade` child relation. */
export async function checkBoundedCascade({ owners, items }: TBulkWriteTables): Promise<void> {
  await owners.insertMany([1, 2, 3].map((id) => ({ id, name: `o${id}` })));
  await items.insertMany([
    { id: 1, label: "a", ownerId: 1 },
    { id: 2, label: "b", ownerId: 2 },
    { id: 3, label: "c", ownerId: 3 },
    { id: 4, label: "d", ownerId: 3 },
  ]);
  expect(await owners.deleteMany({}, { limit: 2, sort: { id: -1 } })).toEqual({ deletedCount: 2 });
  expect(await ids(owners)).toEqual([1]);
  expect(await ids(items)).toEqual([1]);
}

/** A populated table gains `@db.onUpdate.inc`: sync backfills 0, updates count from there. */
export async function checkCounterUpgrade(space: any, SchemaSync: any, fx: any): Promise<void> {
  expect((await new SchemaSync(space).run([fx.BwBefore], { force: true })).status).toBe("synced");
  await space.getTable(fx.BwBefore).insertMany([
    { id: 1, title: "a" },
    { id: 2, title: "b" },
  ]);
  const result = await new SchemaSync(space).run([fx.BwAfter], { force: true });
  expect(result.status).toBe("synced");
  expect(result.entries[0]!.errors ?? []).toEqual([]);
  const table = space.getTable(fx.BwAfter);
  expect(await table.findById(1)).toMatchObject({ rev: 0 });
  await table.updateOne({ id: 1, title: "c" });
  await table.updateMany({}, { title: "d" });
  expect(await table.findById(1)).toMatchObject({ rev: 2 });
  expect(await table.findById(2)).toMatchObject({ rev: 1 });
  await table.insertOne({ id: 3, title: "e" });
  expect(await table.findById(3)).toMatchObject({ rev: 0 });
  expect((await new SchemaSync(space).run([fx.BwAfter])).status).toBe("up-to-date");
}

/**
 * Bounded writes on a composite, `@db.column`-renamed key with NULL sort keys
 * (engine default and `@db.sort.nulls 'last'`) and a self-referencing
 * relational filter: each bounded write touches exactly the rows the equal
 * read returns.
 */
export async function checkBoundedComposite(boards: any): Promise<void> {
  const board = (org: string, code: string, rank: number | null, parent?: [string, string]) => ({
    org,
    code,
    title: "-",
    ...(rank === null ? {} : { rank, rankLast: rank }),
    ...(parent ? { parentOrg: parent[0], parentCode: parent[1] } : {}),
  });
  const keyOf = (r: any) => `${r.org}/${r.code}`;
  const keys = async (filter: Record<string, unknown>) =>
    ((await boards.findMany({ filter, controls: {} })) as any[]).map(keyOf).toSorted();
  // one by one: a row may reference an earlier one
  for (const b of [
    board("o1", "a", 3),
    board("o1", "b", null),
    board("o2", "a", 1),
    board("o2", "b", null, ["o1", "a"]),
    board("o1", "c", 1, ["o1", "a"]),
    board("o3", "a", 2, ["o2", "a"]),
  ]) {
    await boards.insertOne(b);
  }
  for (const [sort, limit] of [
    [{ rank: 1 }, 3],
    [{ rank: -1 }, 3],
    [{ rankLast: 1 }, 3],
    [{ rankLast: -1 }, 4],
    [{ rank: 1, code: -1 }, 4],
    [undefined, 2],
  ] as const) {
    const read = (await boards.findMany({
      filter: {},
      controls: { $sort: sort ?? { org: 1, code: 1 }, $limit: limit },
    })) as any[];
    await boards.updateMany({}, { title: "x" }, { limit, ...(sort ? { sort } : {}) });
    expect(await keys({ title: "x" }), JSON.stringify(sort)).toEqual(read.map(keyOf).toSorted());
    await boards.updateMany({}, { title: "-" });
  }
  const res = await boards.updateMany(
    { parentBoard: { $some: { org: "o1" } } },
    { title: "child" },
    { limit: 1, sort: { code: -1 } },
  );
  expect(res.matchedCount).toBe(1);
  expect(await keys({ title: "child" })).toEqual(["o1/c"]);
  // children of o1/a or o2/a, highest `rankLast` first, NULLs last
  const del = await boards.deleteMany(
    { parentBoard: { $some: { org: { $in: ["o1", "o2"] } } } },
    { limit: 2, sort: { rankLast: -1 } },
  );
  expect(del.deletedCount).toBe(2);
  expect(await keys({})).toEqual(["o1/a", "o1/b", "o2/a", "o2/b"]);
}
