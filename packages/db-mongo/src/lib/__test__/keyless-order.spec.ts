import { ObjectId } from "mongodb";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { CollectionPatcher } from "../collection-patcher";
import type { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// The pipeline of key-less array operators whose items hold objects: an
// element equals an item whatever the order of the objects' properties, as
// on the other adapters (since 0.1.182). keyless-order-server.spec.ts runs
// the same shapes on a real MongoDB.

const mongo = createTestSpace();
let type: any;

beforeAll(async () => {
  await prepareFixtures();
  type = (await import("./fixtures/keyless-order.as")).KeylessOrder;
});

/** `$set` stages of `patch`, validated as `updateOne` validates it unless `raw`. */
function stages(patch: Record<string, unknown>, raw = false): any[] {
  const table = mongo.getTable(type);
  const adapter = mongo.getAdapter(type) as unknown as MongoAdapter;
  const payload = { id: 1, ...patch };
  if (!raw) {
    const v = table.getValidator("bulkUpdate")!;
    if (!v.validate(payload, false, { mode: "patch", flatMap: table.flatMap })) {
      throw new Error("Invalid payload");
    }
  }
  return new CollectionPatcher(adapter.getPatcherContext(), payload).preparePatch().updateFilter;
}

/** The `$filter` condition of a key-less `$remove` of `items` on `field`. */
const removeCond = (field: string, items: unknown[], raw = false) =>
  stages({ [field]: { $remove: items } }, raw)[0].$set[field].$filter.cond;

const objectOf = (expr: unknown, size: number) => ({
  $eq: [
    { $cond: [{ $eq: [{ $type: expr }, "object"] }, { $size: { $objectToArray: expr } }, -1] },
    size,
  ],
});

/** The 0.1.181 `$upsert` / unique `$insert` of `["a"]` on `field`, kept for values. */
const appendUnless = (field: string) => ({
  $reduce: {
    input: { $literal: ["a"] },
    initialValue: { $ifNull: [`$${field}`, []] },
    in: {
      $cond: [
        { $in: ["$$this", "$$value"] },
        "$$value",
        { $concatArrays: ["$$value", ["$$this"]] },
      ],
    },
  },
});

describe("[mongo] key-less array operators", () => {
  it("[PRIMITIVE] values keep the BSON `$in` expressions", () => {
    expect(removeCond("tags", ["a"])).toEqual({ $not: { $in: ["$$el", { $literal: ["a"] }] } });
    expect(stages({ tags: { $upsert: ["a"] } })[0].$set.tags).toEqual(appendUnless("tags"));
    expect(stages({ uniqTags: { $insert: ["a"] } })[0].$set.uniqTags).toEqual(
      appendUnless("uniqTags"),
    );
  });

  it("an object item: its size, then each property by field path", () => {
    expect(removeCond("entries", [{ note: "n", label: "x" }])).toEqual({
      $not: {
        $and: [
          objectOf("$$el", 2),
          { $eq: ["$$el.note", { $literal: "n" }] },
          { $eq: ["$$el.label", { $literal: "x" }] },
        ],
      },
    });
  });

  it("the checks go as deep as the item: nested objects flat by path, array elements by position", () => {
    const cond = removeCond("entries", [
      { label: "p", meta: { b: "z", a: 1 }, points: [{ y: 2, x: 1 }], codes: ["a", "b"] },
    ]);
    expect(cond).toEqual({
      $not: {
        $and: [
          objectOf("$$el", 4),
          { $eq: ["$$el.label", { $literal: "p" }] },
          objectOf("$$el.meta", 2),
          { $eq: ["$$el.meta.b", { $literal: "z" }] },
          { $eq: ["$$el.meta.a", { $literal: 1 }] },
          {
            $cond: [
              { $isArray: "$$el.points" },
              {
                $and: [
                  { $eq: [{ $size: "$$el.points" }, 1] },
                  {
                    $let: {
                      vars: { v0: { $arrayElemAt: ["$$el.points", 0] } },
                      in: {
                        $and: [
                          objectOf("$$v0", 2),
                          { $eq: ["$$v0.y", { $literal: 2 }] },
                          { $eq: ["$$v0.x", { $literal: 1 }] },
                        ],
                      },
                    },
                  },
                ],
              },
              false,
            ],
          },
          // an array of scalars: BSON equality, in order
          { $eq: ["$$el.codes", { $literal: ["a", "b"] }] },
        ],
      },
    });
  });

  it("an array element inside an array element gets the next variable", () => {
    const cond = removeCond("entries", [[[{ a: 1 }]]], true);
    expect(JSON.stringify(cond)).toContain('"vars":{"v0":{"$arrayElemAt":["$$el",0]}}');
    expect(JSON.stringify(cond)).toContain('"vars":{"v1":{"$arrayElemAt":["$$v0",0]}}');
  });

  it("a null property is checked by type, so a missing one does not equal it", () => {
    expect(removeCond("entries", [{ label: "a", note: null }])).toEqual({
      $not: {
        $and: [
          objectOf("$$el", 2),
          { $eq: ["$$el.label", { $literal: "a" }] },
          { $eq: [{ $type: "$$el.note" }, "null"] },
        ],
      },
    });
  });

  it("a property name a field path cannot spell is read with $getField", () => {
    const cond = removeCond("entries", [{ "a.b": 1 }], true);
    const isObject = { $eq: [{ $type: "$$el" }, "object"] };
    expect(cond).toEqual({
      $not: {
        $and: [
          objectOf("$$el", 1),
          {
            $cond: [
              isObject,
              {
                $eq: [
                  { $getField: { field: { $literal: "a.b" }, input: "$$el" } },
                  { $literal: 1 },
                ],
              },
              false,
            ],
          },
        ],
      },
    });
  });

  it("scalar items next to object items share one `$in`; equal object items are sent once", () => {
    const cond = removeCond("entries", ["x", { label: "x" }, "x", { label: "x" }], true);
    expect(cond.$not.$or).toHaveLength(2);
    expect(cond.$not.$or[0]).toEqual({ $in: ["$$el", { $literal: ["x", "x"] }] });
  });

  it("$upsert / unique $insert: stored array + each new item unless an element equals it", () => {
    const set = stages({
      entries: {
        $upsert: [
          { label: "u", note: "n" },
          { note: "n", label: "u" },
        ],
      },
    })[0].$set.entries;
    expect(set.$let.vars).toEqual({ arr: { $ifNull: ["$entries", []] } });
    const [stored, ...added] = set.$let.in.$concatArrays;
    expect(stored).toBe("$$arr");
    // the re-ordered second item equals the first: one item left
    expect(added).toEqual([
      {
        $cond: [
          {
            $anyElementTrue: {
              $map: {
                input: "$$arr",
                as: "el",
                in: {
                  $and: [
                    objectOf("$$el", 2),
                    { $eq: ["$$el.label", { $literal: "u" }] },
                    { $eq: ["$$el.note", { $literal: "n" }] },
                  ],
                },
              },
            },
          },
          [],
          { $literal: [{ label: "u", note: "n" }] },
        ],
      },
    ]);
    const uniq = stages({ uniq: { $insert: [{ name: "a", score: 1 }] } })[0].$set.uniq;
    expect(uniq.$let.in.$concatArrays).toHaveLength(2);
  });

  it("strings in items stay `$literal`s", () => {
    const json = JSON.stringify(
      stages({
        entries: { $remove: [{ label: "$secret" }], $upsert: [{ label: "$$ROOT" }] },
        uniq: { $insert: [{ name: "$secret", score: 1 }] },
      }),
    );
    expect(json.match(/"\$secret"/g)).toHaveLength(3);
    expect(json.match(/\{"\$literal":"\$secret"\}/g)).toHaveLength(2);
    expect(json).toContain('{"$literal":[{"name":"$secret","score":1}]}');
    expect(json.match(/"\$\$ROOT"/g)).toHaveLength(2);
    expect(json).toContain('{"$literal":"$$ROOT"}');
  });
});

// Which items of one operator are the same (since 0.1.182): one rule
// whatever the other items — the sorted JSON form the other adapters compare
// by, except that a value JSON cannot represent keeps its BSON type, as `$in`
// compares it. Before, an `ObjectId` and its hex string (a `Date` and its ISO
// text) collapsed into one item only when another item held an object.
describe("[mongo] repeated operator items", () => {
  const oid = new ObjectId();
  const hex = oid.toHexString();
  const date = new Date(0);
  const iso = date.toISOString();

  /** The items a unique `$insert` of `items` on `field` may append, in order. */
  const appended = (field: string, items: unknown[]) =>
    stages({ [field]: { $insert: items } }, true)[0]
      .$set[field].$let.in.$concatArrays.slice(1)
      .map((piece: any) => piece.$cond[2].$literal[0]);

  it("a BSON value never equals its JSON text, also next to an object item", () => {
    expect(appended("uniqTags", [oid, hex, date, iso, { a: 1 }, { a: 1 }, oid, date])).toEqual([
      oid,
      hex,
      date,
      iso,
      { a: 1 },
    ]);
  });

  it("objects are the same whatever the order of their properties; a nested BSON value keeps its type", () => {
    expect(
      appended("uniqTags", [{ a: 1, b: 2 }, { b: 2, a: 1 }, { r: oid }, { r: hex }, { r: oid }]),
    ).toEqual([{ a: 1, b: 2 }, { r: oid }, { r: hex }]);
  });

  it("$remove: an object item with a BSON value and one with its text are two checks", () => {
    const cond = removeCond("entries", [{ label: oid }, { label: hex }, { label: hex }], true);
    expect(cond.$not.$or).toHaveLength(2);
  });

  it("scalars only: BSON `$in` at run time, as before", () => {
    expect(stages({ uniqTags: { $insert: ["a"] } })[0].$set.uniqTags).toEqual(
      appendUnless("uniqTags"),
    );
  });
});
