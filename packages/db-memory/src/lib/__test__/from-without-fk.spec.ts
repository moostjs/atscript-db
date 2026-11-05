import type { DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, caught, createTestSpace, prepareFixtures } from "./test-utils";

// A FROM relation whose child has no foreign key referencing THIS table (here
// inherited through `extends` from the table the key references) cannot link
// nested children: the write is refused, the children are never dropped.

let fx: Record<string, any>;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/from-no-remote-fk.as");
});

beforeEach(async () => {
  space = createTestSpace();
  await bootstrapStoredTables(space, [fx.FrParent, fx.FrKid, fx.FrSpecial]);
});

const t = (type: unknown) => space.getTable(type as never) as any;
const all = (type: unknown) => t(type).findMany({ filter: {} });

describe("FROM relation without a foreign key to this table", () => {
  it("insert with children → INVALID_QUERY naming the relation, nothing written", async () => {
    const error = await caught(
      t(fx.FrSpecial).insertOne({ id: 1, label: "s", kids: [{ note: "k" }] }),
    );
    expect(error.code).toBe("INVALID_QUERY");
    expect(error.errors).toEqual([
      {
        path: "kids",
        message: 'Cannot write "kids" — "fr_kids" has no @db.rel.FK referencing "fr_special"',
      },
    ]);
    expect(await all(fx.FrSpecial)).toEqual([]);
    expect(await all(fx.FrKid)).toEqual([]);
  });

  it("replace / patch with children → INVALID_QUERY, row unchanged", async () => {
    await t(fx.FrSpecial).insertOne({ id: 1, label: "s" });
    const replaced = await caught(
      t(fx.FrSpecial).replaceOne({ id: 1, label: "r", kids: [{ note: "k" }] }),
    );
    expect(replaced.code).toBe("INVALID_QUERY");
    const patched = await caught(
      t(fx.FrSpecial).updateOne({ id: 1, label: "p", kids: { $insert: [{ note: "k" }] } }),
    );
    expect(patched.code).toBe("INVALID_QUERY");
    expect(await all(fx.FrSpecial)).toMatchObject([{ id: 1, label: "s" }]);
    expect(await all(fx.FrKid)).toEqual([]);
  });

  it("the table the foreign key references still writes its children; no children, no check", async () => {
    await t(fx.FrParent).insertOne({ id: 1, label: "p", kids: [{ note: "k" }] });
    expect(await all(fx.FrKid)).toMatchObject([{ parentId: 1, note: "k" }]);
    await t(fx.FrSpecial).insertOne({ id: 2, label: "s" });
    expect(await all(fx.FrSpecial)).toMatchObject([{ id: 2 }]);
  });
});
