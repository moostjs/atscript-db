import type { DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { bootstrapStoredTables, caught, createTestSpace, prepareFixtures } from "./test-utils";

// The checks a nested write makes before writing — every link resolvable,
// existing VIA targets stored, foreign keys pointing at stored rows, the
// relation shapes a replace can write — apply at every level, not only to the
// root's own relations: a level refused two or three deep leaves nothing
// written (this adapter has no rollback, so a late refusal would show).

let fx: Record<string, any>;
let space: DbSpace;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/nested-deep-checks.as");
});

beforeEach(async () => {
  space = createTestSpace();
  await bootstrapStoredTables(
    space,
    Object.values(fx).filter((v) => typeof v === "function"),
  );
});

const t = (type: unknown) => space.getTable(type as never) as any;
const all = (type: unknown) => t(type).findMany({ filter: {}, controls: { $sort: { id: 1 } } });
/** Every table of the fixture is still empty. */
const nothingWritten = async () => {
  for (const type of [fx.DnRoot, fx.DnMid, fx.DnLeaf, fx.DnTwig, fx.DnSlugged, fx.DnMidTag]) {
    expect(await all(type)).toEqual([]);
  }
};

describe("nested insert — checks below the root's own relations", () => {
  it("depth 2: a TO object without the field its key references → FK_VIOLATION, nothing written", async () => {
    const error = await caught(
      t(fx.DnRoot).insertOne({ label: "r", mids: [{ note: "m", slugged: { label: "s" } }] }),
    );
    expect(error.code).toBe("FK_VIOLATION");
    expect(error.errors[0]?.path).toBe("mids.slugged");
    await nothingWritten();
  });

  it("depth 2: a VIA entry naming a missing target → FK_VIOLATION, nothing written", async () => {
    const error = await caught(
      t(fx.DnRoot).insertOne({ label: "r", mids: [{ note: "m", tags: [{ id: 999 }] }] }),
    );
    expect(error.code).toBe("FK_VIOLATION");
    await nothingWritten();
  });

  it("depth 2: a grandchild's foreign key to a missing row → FK_VIOLATION, nothing written", async () => {
    const error = await caught(
      t(fx.DnRoot).insertOne({
        label: "r",
        mids: [{ note: "m", leaves: [{ note: "l", tagId: 999 }] }],
      }),
    );
    expect(error.code).toBe("FK_VIOLATION");
    await nothingWritten();
  });

  it("depth 3: a TO object under a grandchild without its referenced field → FK_VIOLATION, nothing written", async () => {
    const error = await caught(
      t(fx.DnRoot).insertOne(
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
    await nothingWritten();
  });

  it("depth 3: a level-3 row's foreign key to a missing row → FK_VIOLATION, nothing written", async () => {
    const error = await caught(
      t(fx.DnRoot).insertOne({
        label: "r",
        mids: [{ note: "m", leaves: [{ note: "l", twigs: [{ note: "t", sluggedSlug: "nope" }] }] }],
      }),
    );
    expect(error.code).toBe("FK_VIOLATION");
    await nothingWritten();
  });

  it("a valid three-level tree is written whole", async () => {
    const { insertedId: tagId } = await t(fx.DnTag).insertOne({ name: "known" });
    await t(fx.DnRoot).insertOne(
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
    const [root] = await all(fx.DnRoot);
    const [mid] = await all(fx.DnMid);
    expect(mid).toMatchObject({ rootId: root.id, sluggedSlug: "s1" });
    const [leaf] = await all(fx.DnLeaf);
    expect(leaf).toMatchObject({ midId: mid.id, tagId });
    expect(await all(fx.DnTwig)).toMatchObject([{ leafId: leaf.id, sluggedSlug: "s2" }]);
    expect(await all(fx.DnMidTag)).toHaveLength(2);
  });
});

describe("nested replace / patch — checks below the root's own relations", () => {
  it("depth 2: a replaced child's TO object without its referenced field → INVALID_QUERY, root unchanged", async () => {
    const { insertedId } = await t(fx.DnRoot).insertOne({ label: "before", mids: [{ note: "m" }] });
    const [mid] = await all(fx.DnMid);
    const error = await caught(
      t(fx.DnRoot).replaceOne({
        id: insertedId,
        label: "after",
        mids: [{ id: mid.id, note: "m2", slugged: { label: "s" } }],
      }),
    );
    expect(error.code).toBe("INVALID_QUERY");
    expect((await all(fx.DnRoot))[0].label).toBe("before");
    expect((await all(fx.DnMid))[0].note).toBe("m");
  });

  it("depth 2: a patch inserting a child whose TO object lacks its referenced field → FK_VIOLATION, root unchanged", async () => {
    const { insertedId } = await t(fx.DnRoot).insertOne({ label: "before" });
    const error = await caught(
      t(fx.DnRoot).updateOne({
        id: insertedId,
        label: "after",
        mids: { $insert: [{ note: "m", slugged: { label: "s" } }] },
      }),
    );
    expect(error.code).toBe("FK_VIOLATION");
    expect((await all(fx.DnRoot))[0].label).toBe("before");
    expect(await all(fx.DnMid)).toEqual([]);
  });
});
