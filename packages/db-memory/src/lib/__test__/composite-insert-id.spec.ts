import type { DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, createTestSpace, prepareFixtures } from "./test-utils";

// Since 0.1.169 an insert into a composite-primary-key table reports the
// primary-key object keyed by LOGICAL field names (before: physical column
// names, so a `@db.column` rename leaked into the id). The memory adapter
// generates increments itself, so a generated key part is part of the id.

let fx: Record<string, any>;
let space: DbSpace;
let pairs: any;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/composite-insert-id.as");
});

beforeEach(async () => {
  space = createTestSpace();
  await bootstrapStoredTables(space, [
    fx.CidPair,
    fx.CidSingle,
    fx.CidSeq,
    fx.CidCoded,
    fx.CidLink,
    fx.CidTag,
    fx.CidCodedTag,
  ]);
  pairs = space.getTable(fx.CidPair);
});

describe("[memory] composite primary key — insertedId", () => {
  it("insertOne reports the primary-key object by logical field names", async () => {
    const result = await pairs.insertOne({ left: 1, right: "a", label: "A" });
    expect(result).toEqual({ insertedId: { left: 1, right: "a" } });
    expect(await pairs.findById(result.insertedId)).toMatchObject({ left: 1, right: "a" });
  });

  it("insertMany and onConflict: ignore report one primary-key object per inserted row", async () => {
    expect(
      await pairs.insertMany([
        { left: 1, right: "a", label: "A" },
        { left: 1, right: "b", label: "B" },
      ]),
    ).toEqual({
      insertedCount: 2,
      insertedIds: [
        { left: 1, right: "a" },
        { left: 1, right: "b" },
      ],
    });
    expect(
      await pairs.insertMany(
        [
          { left: 1, right: "a", label: "dup" },
          { left: 2, right: "c", label: "C" },
        ],
        { onConflict: "ignore" },
      ),
    ).toEqual({
      insertedCount: 1,
      insertedIds: [{ left: 2, right: "c" }],
      inserted: [1],
      conflicts: [0],
    });
  });

  it("insertOne({ returning: true }) reads back the inserted row, not one sharing a unique value", async () => {
    await pairs.insertOne({ left: 10, right: "a", code: 2, label: "first" });
    const result = await pairs.insertOne(
      { left: 20, right: "b", code: 1, label: "second" },
      { returning: true },
    );
    expect(result.insertedId).toEqual({ left: 20, right: "b" });
    expect(result.row).toMatchObject({ label: "second" });
  });

  it("a generated key part is part of the id", async () => {
    const seq = space.getTable(fx.CidSeq) as any;
    expect(await seq.insertOne({ tenant: "t1", label: "x" })).toEqual({
      insertedId: { tenant: "t1", seq: 1 },
    });
    expect((await seq.insertMany([{ tenant: "t1", label: "y" }])).insertedIds).toEqual([
      { tenant: "t1", seq: 2 },
    ]);
  });

  it("a write check gets the generated key part from the id", async () => {
    const seq = space.getTable(fx.CidSeq) as any;
    const filters: unknown[] = [];
    await seq.insertMany([{ tenant: "t1", label: "x" }], {
      check: (ctx: { filters: unknown[] }) => void filters.push(...ctx.filters),
    });
    expect(filters).toEqual([{ tenant: "t1", seq: 1 }]);
  });

  it("a single primary key keeps its scalar id", async () => {
    const single = space.getTable(fx.CidSingle) as any;
    expect(await single.insertOne({ label: "a" })).toEqual({ insertedId: 1 });
    expect((await single.insertMany([{ label: "b" }])).insertedIds).toEqual([2]);
  });

  it("nested FROM children of a composite-key parent get its full key", async () => {
    await pairs.insertOne({ left: 6, right: "f", label: "F", links: [{ note: "child" }] });
    const [link] = await (space.getTable(fx.CidLink) as any).findMany({ filter: {}, controls: {} });
    expect(link).toMatchObject({ note: "child", pairLeft: 6, pairRight: "f" });
  });
});
