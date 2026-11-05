import type { DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, caught, createTestSpace, prepareFixtures } from "./test-utils";

// (1) The checks of the levels below a write's root do not refuse a foreign
// key to a row the same write creates — the root, a sibling, an earlier item
// of the batch: that row is checked when its level is written.
// (2) A keyed FROM child of a replace / `$replace` / `$upsert` that is not one
// of the parent's stored children is inserted with its key, never dropped.

let fx: Record<string, any>;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/nested-written-rows.as");
});

beforeEach(async () => {
  space = createTestSpace();
  await bootstrapStoredTables(
    space,
    Object.values(fx).filter((v) => typeof v === "function"),
  );
});

const t = (type: unknown) => space.getTable(type as never) as any;
const all = (type: unknown) => t(type).findMany({ filter: {} });
const byKey = (rows: Array<Record<string, unknown>>, key: string) =>
  [...rows].toSorted((a, b) => String(a[key]).localeCompare(String(b[key])));

describe("nested rows that reference rows the same write creates", () => {
  it("P1: a VIA target with a foreign key to the root", async () => {
    await t(fx.WfUser).insertOne({ id: "u1", groups: [{ title: "g", createdBy: "u1" }] });
    expect(await all(fx.WfGroup)).toMatchObject([{ title: "g", createdBy: "u1" }]);
    expect(await all(fx.WfUserGroup)).toHaveLength(1);
  });

  it("P2: a grandchild with a foreign key to the root", async () => {
    await t(fx.WfUser).insertOne({
      id: "u1",
      orders: [{ code: "o1", notes: [{ text: "n", authorId: "u1" }] }],
    });
    expect(await all(fx.WfNote)).toMatchObject([{ orderCode: "o1", authorId: "u1" }]);
  });

  it("P5: a later item's grandchild with a foreign key to an earlier root", async () => {
    await t(fx.WfUser).insertMany([
      { id: "u1" },
      { id: "u2", orders: [{ code: "o2", notes: [{ text: "n", authorId: "u1" }] }] },
    ]);
    expect(await all(fx.WfNote)).toMatchObject([{ orderCode: "o2", authorId: "u1" }]);
  });

  it("a foreign key to a row nobody writes is still refused", async () => {
    const error = await caught(
      t(fx.WfUser).insertOne({
        id: "u1",
        orders: [{ code: "o1", notes: [{ text: "n", authorId: "nobody" }] }],
      }),
    );
    expect(error.code).toBe("FK_VIOLATION");
  });
});

describe("keyed FROM children that are not stored yet", () => {
  beforeEach(async () => {
    await t(fx.WfUser).insertOne({ id: "u1", orders: [{ code: "o1", label: "first" }] });
  });

  it("replace: a new natural key is inserted, a stored one replaced", async () => {
    const result = await t(fx.WfUser).replaceOne({
      id: "u1",
      orders: [
        { code: "o1", label: "again" },
        { code: "o2", label: "new" },
      ],
    });
    expect(result.matchedCount).toBe(1);
    expect(byKey(await all(fx.WfOrder), "code")).toMatchObject([
      { code: "o1", ownerId: "u1", label: "again" },
      { code: "o2", ownerId: "u1", label: "new" },
    ]);
  });

  it("$replace: new keys inserted, unlisted children removed", async () => {
    await t(fx.WfUser).updateOne({
      id: "u1",
      orders: { $replace: [{ code: "o3", label: "three" }] },
    });
    expect(await all(fx.WfOrder)).toMatchObject([{ code: "o3", ownerId: "u1", label: "three" }]);
  });

  it("$upsert: a stored key is updated, a new one inserted", async () => {
    await t(fx.WfUser).updateOne({
      id: "u1",
      orders: {
        $upsert: [
          { code: "o1", label: "updated" },
          { code: "o4", label: "upserted" },
        ],
      },
    });
    expect(byKey(await all(fx.WfOrder), "code")).toMatchObject([
      { code: "o1", ownerId: "u1", label: "updated" },
      { code: "o4", ownerId: "u1", label: "upserted" },
    ]);
  });

  it("a composite key holding the parent's key: new lines inserted, stored ones replaced", async () => {
    await t(fx.WfOrder).replaceOne({
      code: "o1",
      ownerId: "u1",
      lines: [{ lineNo: 1, qty: 1 }],
    });
    await t(fx.WfOrder).replaceOne({
      code: "o1",
      ownerId: "u1",
      lines: [
        { lineNo: 1, qty: 5 },
        { lineNo: 2, qty: 2 },
      ],
    });
    expect(byKey(await all(fx.WfLine), "lineNo")).toMatchObject([
      { orderCode: "o1", lineNo: 1, qty: 5 },
      { orderCode: "o1", lineNo: 2, qty: 2 },
    ]);
  });

  it("a key stored under another parent is refused, nothing changed", async () => {
    await t(fx.WfUser).insertOne({ id: "u2" });
    const error = await caught(
      t(fx.WfUser).replaceOne({ id: "u2", orders: [{ code: "o1", label: "stolen" }] }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(await all(fx.WfOrder)).toMatchObject([{ code: "o1", ownerId: "u1", label: "first" }]);
  });
});

describe("VIA targets the same write creates", () => {
  it("W1: a grandchild VIA entry naming the root being inserted", async () => {
    await t(fx.WfUser).insertOne({ id: "u1", orders: [{ code: "o1", watchers: [{ id: "u1" }] }] });
    expect(await all(fx.WfOrderWatcher)).toMatchObject([{ orderCode: "o1", userId: "u1" }]);
  });

  it("W2: a later item's grandchild VIA entry naming an earlier root", async () => {
    await t(fx.WfUser).insertMany([
      { id: "u2" },
      { id: "u3", orders: [{ code: "o3", watchers: [{ id: "u2" }] }] },
    ]);
    expect(await all(fx.WfOrderWatcher)).toMatchObject([{ orderCode: "o3", userId: "u2" }]);
  });

  it("W3: a VIA entry naming a row nobody writes is still refused", async () => {
    const error = await caught(
      t(fx.WfUser).insertOne({ id: "u1", orders: [{ code: "o1", watchers: [{ id: "nobody" }] }] }),
    );
    expect(error.code).toBe("FK_VIOLATION");
  });
});

describe("ownership of children keyed by the parent's key", () => {
  it("a $update naming another order's line (composite key) is refused, both lines unchanged", async () => {
    await t(fx.WfUser).insertOne({ id: "u1" });
    await t(fx.WfOrder).insertOne({ code: "o1", ownerId: "u1", lines: [{ lineNo: 1, qty: 1 }] });
    await t(fx.WfOrder).insertOne({ code: "o2", ownerId: "u1", lines: [{ lineNo: 1, qty: 2 }] });
    const error = await caught(
      t(fx.WfOrder).updateOne({
        code: "o2",
        lines: { $update: [{ orderCode: "o1", lineNo: 1, qty: 9 }] },
      }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(byKey(await all(fx.WfLine), "orderCode")).toMatchObject([
      { orderCode: "o1", lineNo: 1, qty: 1 },
      { orderCode: "o2", lineNo: 1, qty: 2 },
    ]);
  });
});
