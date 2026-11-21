import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

let UmaItem: any;

// Concurrent array-operator patches in one process (since 0.1.182): a
// read-modify-write takes the adapter's exclusive lock with its read and
// holds it until its transaction scope ends, so parallel callers run one
// after the other instead of overwriting each other's array. Before, two
// patches that interleaved both read the same array and one change was lost.

const tags = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** `values` in code-unit order — a new array. */
const sorted = (values: string[]): string[] => values.toSorted();

describe("MemoryAdapter — concurrent array-operator patches", () => {
  let space: DbSpace;
  let items: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ UmaItem } = await import("./fixtures/update-many-array-ops.as"));
  });

  beforeEach(async () => {
    space = createTestSpace();
    items = space.getTable(UmaItem);
    await bootstrapStoredTables(space, [UmaItem]);
    await items.insertMany([
      { id: 1, status: "open", tags: [] },
      { id: 2, status: "open", tags: ["x"] },
    ] as any);
  });

  const stored = async () =>
    ((await items.findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as any[]).map((row) =>
      sorted(row.tags),
    );

  it("parallel updateOne calls on one row: none is lost", async () => {
    const added = tags("p", 10);
    await Promise.all(
      added.map((tag) => items.updateOne({ id: 1, tags: { $insert: [tag] } } as any)),
    );
    expect((await stored())[0]).toEqual(sorted(added));
  });

  it("parallel bulkUpdate calls over the same rows: none is lost", async () => {
    const added = tags("b", 6);
    await Promise.all(
      added.map((tag) =>
        items.bulkUpdate([
          { id: 1, tags: { $insert: [tag] } },
          { id: 2, tags: { $insert: [tag] } },
        ] as any),
      ),
    );
    expect(await stored()).toEqual([sorted(added), sorted([...added, "x"])]);
  });

  it("parallel updateMany calls over the same rows: none is lost", async () => {
    const added = tags("m", 6);
    const results = await Promise.all(
      added.map((tag) =>
        items.updateMany({ status: "open" } as any, { tags: { $insert: [tag] } } as any),
      ),
    );
    for (const result of results) expect(result.matchedCount).toBe(2);
    expect(await stored()).toEqual([sorted(added), sorted([...added, "x"])]);
  });

  it("a write without array operators does not wait for a held lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holder = items.getAdapter().withTransaction(async () => {
      await items.findOne({ filter: { id: 1 }, controls: {} }, { lock: "update" });
      await gate;
    });
    // a plain patch and a plain read complete while the lock is held
    await items.updateOne({ id: 2, status: "closed" } as any);
    expect(((await items.findOne({ filter: { id: 2 }, controls: {} })) as any).status).toBe(
      "closed",
    );
    // an array-operator patch waits for it
    let patched = false;
    const waiting = items
      .updateOne({ id: 1, tags: { $insert: ["w"] } } as any)
      .then(() => (patched = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(patched).toBe(false);
    release();
    await holder;
    await waiting;
    expect((await stored())[0]).toEqual(["w"]);
  });
});
