import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { prepareFixtures, RecordingDriver } from "./test-utils";

let NbParent: any;
let NbChild: any;
let NbNode: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ NbParent, NbChild, NbNode } = await import("./fixtures/nested-batch.as"));
});

describe("nested FROM replace across parents", () => {
  let driver: RecordingDriver;
  let parents: any;
  let children: any;
  let nodes: any;

  beforeEach(async () => {
    driver = new RecordingDriver(new BetterSqlite3Driver(":memory:"));
    const space = new DbSpace(() => new SqliteAdapter(driver));
    parents = space.getTable(NbParent);
    children = space.getTable(NbChild);
    nodes = space.getTable(NbNode);
    for (const t of [parents, children, nodes]) await t.ensureTable();
    await parents.insertMany([{ id: 1 }, { id: 2 }, { id: 3 }]);
    await children.insertMany([
      { id: 10, label: "a", parentId: 1 },
      { id: 11, label: "b", parentId: 1 },
      { id: 20, label: "c", parentId: 2 },
      { id: 30, label: "d", parentId: 3 },
    ]);
    driver.statements.length = 0;
  });

  const childRows = async () =>
    (await children.findMany({ filter: {}, controls: { $sort: { id: 1 } } })).map((r: any) => [
      r.id,
      r.label,
      r.parentId,
    ]);
  /** Reads of the current children: [shared (`IN`), per parent (`=`)]. */
  const childReads = () => {
    const reads = driver.statements.filter(
      (sql) => sql.startsWith('SELECT "id"') && sql.includes('FROM "nb_children" WHERE "parentId"'),
    );
    return [reads.filter((sql) => sql.includes(" IN (")).length, reads.length];
  };

  it("bulkReplace: orphans removed, keyed kept, new inserted — per parent; one shared read", async () => {
    await parents.bulkReplace([
      { id: 1, name: "p1", children: [{ id: 10, label: "a2" }, { label: "new1" }] },
      { id: 2, name: "p2", children: [] },
      { id: 3, name: "p3", children: [{ id: 30, label: "d2" }] },
    ]);
    expect(await childRows()).toEqual([
      [10, "a2", 1],
      [30, "d2", 3],
      [31, "new1", 1],
    ]);
    expect(childReads()).toEqual([1, 1]);
  });

  it("patch $replace on several parents behaves the same, with one shared read", async () => {
    await parents.bulkUpdate([
      { id: 1, children: { $replace: [{ id: 11, label: "b2" }] } },
      { id: 2, children: { $replace: [{ id: 20 }, { label: "new2" }], $insert: [{ label: "x" }] } },
    ]);
    expect(await childRows()).toEqual([
      [11, "b2", 1],
      [20, null, 2],
      [30, "d", 3],
      [31, "new2", 2],
      [32, "x", 2],
    ]);
    expect(childReads()).toEqual([1, 1]);
  });

  it("a keyed child of another parent is still rejected (ownership unchanged)", async () => {
    await expect(
      parents.bulkReplace([
        { id: 1, children: [{ id: 10 }] },
        { id: 2, children: [{ id: 11 }] },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await childRows()).toEqual([
      [10, "a", 1],
      [11, "b", 1],
      [20, "c", 2],
      [30, "d", 3],
    ]);
  });

  it("the same parent twice in a batch is replaced in order (reads per parent)", async () => {
    await parents.bulkReplace([
      { id: 1, children: [{ id: 10 }, { label: "n" }] },
      { id: 1, children: [{ id: 10, label: "z" }] },
    ]);
    expect(await childRows()).toEqual([
      [10, "z", 1],
      [20, "c", 2],
      [30, "d", 3],
    ]);
    expect(childReads()).toEqual([0, 2]);
  });

  it("a single parent reads its children as before", async () => {
    await parents.replaceOne({ id: 2, children: [{ label: "only" }] });
    expect(childReads()).toEqual([0, 1]);
    expect(await childRows()).toEqual([
      [10, "a", 1],
      [11, "b", 1],
      [30, "d", 3],
      [31, "only", 2],
    ]);
  });

  it("self-referencing tree: a child's nested writes reaching a later parent fall back to per-parent reads", async () => {
    await nodes.insertMany([
      { id: 1, label: "A" },
      { id: 2, label: "B", parentId: 1 },
      { id: 3, label: "old", parentId: 2 },
    ]);
    await nodes.bulkReplace([
      // A replaces its child B — and B's children → [x]
      { id: 1, label: "A", children: [{ id: 2, label: "B", children: [{ label: "x" }] }] },
      // then B itself: its children → [y] (x, written above, is an orphan now)
      { id: 2, label: "B", parentId: 1, children: [{ label: "y" }] },
    ]);
    const rows = await nodes.findMany({ filter: {}, controls: { $sort: { id: 1 } } });
    expect(rows.map((r: any) => [r.label, r.parentId ?? null])).toEqual([
      ["A", null],
      ["B", 1],
      ["y", 2],
    ]);
  });
});
