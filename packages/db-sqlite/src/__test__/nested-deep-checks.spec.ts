import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { caught, prepareFixtures } from "./test-utils";

// The checks a nested write makes before writing apply at every level, not
// only to the root's own relations: a level refused two or three deep is
// refused before the root writes anything (SQLite would roll a late refusal
// back — so these tests watch the root's own write calls instead).

let deep: Record<string, any>;
let noFk: Record<string, any>;
let driver: BetterSqlite3Driver;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  deep = await import("./fixtures/nested-deep-checks.as");
  noFk = await import("./fixtures/from-no-remote-fk.as");
});

beforeEach(async () => {
  driver = new BetterSqlite3Driver(":memory:");
  space = new DbSpace(() => new SqliteAdapter(driver));
  const types = [...Object.values(deep), ...Object.values(noFk)].filter(
    (v) => typeof v === "function",
  );
  expect((await new SchemaSync(space).run(types as never, { force: true })).status).toBe("synced");
});

afterEach(() => {
  driver.close();
  vi.restoreAllMocks();
});

const t = (type: unknown) => space.getTable(type as never) as any;
const all = (type: unknown) => t(type).findMany({ filter: {}, controls: { $sort: { id: 1 } } });
/** The write calls `type`'s adapter receives. */
const writesTo = (type: unknown) => {
  const adapter = space.getAdapter(type as never) as any;
  return ["insertMany", "insertOne", "replaceOne", "updateOne"].map((m) => vi.spyOn(adapter, m));
};
const neverCalled = (spies: Array<{ mock: { calls: unknown[] } }>) => {
  for (const spy of spies) expect(spy.mock.calls).toEqual([]);
};

describe("nested writes — checks below the root's own relations", () => {
  it("depth 2: a TO object without the field its key references → FK_VIOLATION before the root insert", async () => {
    const root = writesTo(deep.DnRoot);
    const error = await caught(
      t(deep.DnRoot).insertOne({ label: "r", mids: [{ note: "m", slugged: { label: "s" } }] }),
    );
    expect(error.code).toBe("FK_VIOLATION");
    expect(error.errors[0]?.path).toBe("mids.slugged");
    neverCalled(root);
  });

  it("depth 2: a VIA entry naming a missing target → FK_VIOLATION before the root insert", async () => {
    const root = writesTo(deep.DnRoot);
    const error = await caught(
      t(deep.DnRoot).insertOne({ label: "r", mids: [{ note: "m", tags: [{ id: 999 }] }] }),
    );
    expect(error.code).toBe("FK_VIOLATION");
    neverCalled(root);
  });

  it("depth 3: a TO object under a grandchild without its referenced field → FK_VIOLATION before the root insert", async () => {
    const root = writesTo(deep.DnRoot);
    const error = await caught(
      t(deep.DnRoot).insertOne(
        {
          label: "r",
          mids: [
            { note: "m", leaves: [{ note: "l", twigs: [{ note: "t", slugged: { label: "s" } }] }] },
          ],
        },
        { maxDepth: 4 },
      ),
    );
    expect(error.code).toBe("FK_VIOLATION");
    neverCalled(root);
  });

  it("depth 2: a replaced child's TO object without its referenced field → INVALID_QUERY before the root replace", async () => {
    const { insertedId } = await t(deep.DnRoot).insertOne({
      label: "before",
      mids: [{ note: "m" }],
    });
    const [mid] = await all(deep.DnMid);
    const root = writesTo(deep.DnRoot);
    const error = await caught(
      t(deep.DnRoot).replaceOne({
        id: insertedId,
        label: "after",
        mids: [{ id: mid.id, note: "m2", slugged: { label: "s" } }],
      }),
    );
    expect(error.code).toBe("INVALID_QUERY");
    neverCalled(root);
    expect((await all(deep.DnRoot))[0].label).toBe("before");
  });

  it("depth 2: a patch inserting a child whose TO object lacks its referenced field → FK_VIOLATION before the root patch", async () => {
    const { insertedId } = await t(deep.DnRoot).insertOne({ label: "before" });
    const root = writesTo(deep.DnRoot);
    const error = await caught(
      t(deep.DnRoot).updateOne({
        id: insertedId,
        label: "after",
        mids: { $insert: [{ note: "m", slugged: { label: "s" } }] },
      }),
    );
    expect(error.code).toBe("FK_VIOLATION");
    neverCalled(root);
  });

  it("a valid three-level tree is written whole", async () => {
    const { insertedId: tagId } = await t(deep.DnTag).insertOne({ name: "known" });
    await t(deep.DnRoot).insertOne(
      {
        label: "r",
        mids: [
          {
            note: "m",
            slugged: { slug: "s1", label: "S" },
            tags: [{ id: tagId }, { name: "new" }],
            leaves: [
              { note: "l", tagId, twigs: [{ note: "t", slugged: { slug: "s2", label: "T" } }] },
            ],
          },
        ],
      },
      { maxDepth: 4 },
    );
    const [root] = await all(deep.DnRoot);
    const [mid] = await all(deep.DnMid);
    expect(mid).toMatchObject({ rootId: root.id, sluggedSlug: "s1" });
    const [leaf] = await all(deep.DnLeaf);
    expect(leaf).toMatchObject({ midId: mid.id, tagId });
    expect(await all(deep.DnTwig)).toMatchObject([{ leafId: leaf.id, sluggedSlug: "s2" }]);
    expect(await all(deep.DnMidTag)).toHaveLength(2);
  });
});

describe("FROM relation without a foreign key to this table", () => {
  it("insert / replace / patch with children → INVALID_QUERY, nothing written", async () => {
    const error = await caught(
      t(noFk.FrSpecial).insertOne({ id: 1, label: "s", kids: [{ note: "k" }] }),
    );
    expect(error.code).toBe("INVALID_QUERY");
    expect(error.errors[0]?.message).toBe(
      'Cannot write "kids" — "fr_kids" has no @db.rel.FK referencing "fr_special"',
    );
    expect(await all(noFk.FrSpecial)).toEqual([]);
    await t(noFk.FrSpecial).insertOne({ id: 1, label: "s" });
    for (const write of [
      () => t(noFk.FrSpecial).replaceOne({ id: 1, label: "r", kids: [{ note: "k" }] }),
      () => t(noFk.FrSpecial).updateOne({ id: 1, label: "p", kids: { $insert: [{ note: "k" }] } }),
    ]) {
      expect((await caught(write())).code).toBe("INVALID_QUERY");
    }
    expect(await all(noFk.FrSpecial)).toMatchObject([{ id: 1, label: "s" }]);
    expect(await all(noFk.FrKid)).toEqual([]);
  });
});
