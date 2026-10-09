import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbSpace } from "../index";
import type { DbQuery } from "../types";
import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

/**
 * Deterministic paging tie-breaker (since 0.1.153): a read whose `$sort` does
 * not already order rows totally gets the primary key appended, in the
 * direction of the last `$sort` key, before it reaches the adapter.
 */

let fx: typeof import("./fixtures/paging-tiebreak.as");

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/paging-tiebreak.as");
});

function setup(nested = false) {
  let last: MockAdapter | undefined;
  const space = new DbSpace(() => (last = nested ? new NestedMockAdapter() : new MockAdapter()));
  return { space, adapter: () => last! };
}

/** The `$sort` the adapter received on its last read. */
function sentSort(adapter: MockAdapter): Record<string, unknown> | undefined {
  const call = adapter.calls.findLast((c) =>
    ["findMany", "findOne", "findManyWithCount"].includes(c.method),
  );
  return (call?.args[0] as DbQuery | undefined)?.controls?.$sort as
    | Record<string, unknown>
    | undefined;
}

async function sortFor(controls: Record<string, unknown>, nested = false) {
  const { space, adapter } = setup(nested);
  const table = space.getTable(fx.TbItem);
  await table.findMany({ filter: {}, controls } as any);
  return { sort: sentSort(adapter()), keys: Object.keys(sentSort(adapter()) ?? {}) };
}

describe("primary-key tie-breaker", () => {
  it("appends the primary key after a non-unique $sort", async () => {
    const { sort, keys } = await sortFor({ $sort: { category: 1 } });
    expect(sort).toEqual({ category: 1, id: 1 });
    expect(keys).toEqual(["category", "id"]);
  });

  it("follows the direction of the LAST $sort key", async () => {
    expect((await sortFor({ $sort: { category: 1, amount: -1 } })).sort).toEqual({
      category: 1,
      amount: -1,
      id: -1,
    });
    expect((await sortFor({ $sort: { amount: -1, category: 1 } })).sort).toEqual({
      amount: -1,
      category: 1,
      id: 1,
    });
  });

  it("leaves a $sort that already names the primary key as written", async () => {
    expect((await sortFor({ $sort: { id: -1, category: 1 } })).keys).toEqual(["id", "category"]);
    expect((await sortFor({ $sort: { category: 1, id: 1 } })).sort).toEqual({
      category: 1,
      id: 1,
    });
  });

  it("a unique index over required fields orders totally — nothing appended", async () => {
    expect((await sortFor({ $sort: { code: 1 } })).sort).toEqual({ code: 1 });
    // composite unique: every field must be in the $sort
    expect((await sortFor({ $sort: { seq: -1, region: 1 } })).sort).toEqual({
      seq: -1,
      region: 1,
    });
    expect((await sortFor({ $sort: { region: 1 } })).sort).toEqual({ region: 1, id: 1 });
  });

  it("a unique index over a nullable field does not count", async () => {
    expect((await sortFor({ $sort: { nick: -1 } })).sort).toEqual({ nick: -1, id: -1 });
    // a required leaf under an optional parent is nullable too
    expect((await sortFor({ $sort: { "info.tag": 1 } })).sort).toEqual({
      info__tag: 1,
      id: 1,
    });
  });

  it("composite primary key: every missing field, in declaration order", async () => {
    const { space, adapter } = setup();
    const lines = space.getTable(fx.TbLine);
    await lines.findMany({ filter: {}, controls: { $sort: { amount: -1 } } });
    const sort = sentSort(adapter())!;
    expect(sort).toEqual({ amount: -1, orderId: -1, lineNo: -1 });
    expect(Object.keys(sort)).toEqual(["amount", "orderId", "lineNo"]);

    await lines.findMany({ filter: {}, controls: { $sort: { lineNo: 1, amount: -1 } } });
    expect(Object.keys(sentSort(adapter())!)).toEqual(["lineNo", "amount", "orderId"]);
    expect(sentSort(adapter())).toEqual({ lineNo: 1, amount: -1, orderId: -1 });

    await lines.findMany({ filter: {}, controls: { $sort: { lineNo: 1, orderId: -1 } } });
    expect(sentSort(adapter())).toEqual({ lineNo: 1, orderId: -1 });
  });

  it("maps renamed fields when checking coverage (physical names reach the adapter)", async () => {
    expect((await sortFor({ $sort: { renamed: 1 } })).sort).toEqual({ renamed_col: 1, id: 1 });
  });

  it("document storage gets the same tie-breaker", async () => {
    expect((await sortFor({ $sort: { amount: -1 } }, true)).sort).toEqual({
      amount: -1,
      id: -1,
    });
    expect((await sortFor({ $sort: { code: 1 } }, true)).sort).toEqual({ code: 1 });
  });

  it("no $sort → no order imposed", async () => {
    expect((await sortFor({})).sort).toBeUndefined();
    expect((await sortFor({ $sort: {} })).sort).toEqual({});
  });

  it("does not mutate the caller's query", async () => {
    const { space } = setup();
    const table = space.getTable(fx.TbItem);
    const sort = { category: 1 as const };
    const controls = { $sort: sort, $limit: 5 };
    const query = { filter: {}, controls };
    await table.findMany(query);
    await table.findManyWithCount(query);
    await table.findOne(query);
    expect(query.controls).toBe(controls);
    expect(controls.$sort).toBe(sort);
    expect(sort).toEqual({ category: 1 });
    expect(Object.keys(controls)).toEqual(["$sort", "$limit"]);
  });

  it("applies to findOne and findManyWithCount", async () => {
    const { space, adapter } = setup();
    const table = space.getTable(fx.TbItem);
    await table.findOne({ filter: {}, controls: { $sort: { amount: -1 } } });
    expect(sentSort(adapter())).toEqual({ amount: -1, id: -1 });
    adapter().calls.length = 0;
    await table.findManyWithCount({ filter: {}, controls: { $sort: { amount: 1 } } });
    const sorts = adapter()
      .calls.filter((c) => c.method === "findMany")
      .map((c) => (c.args[0] as DbQuery).controls.$sort);
    expect(sorts).toEqual([{ amount: 1, id: 1 }]);
  });

  it("skips $count reads and aggregate selects", async () => {
    expect((await sortFor({ $sort: { category: 1 }, $count: true })).sort).toEqual({
      category: 1,
    });
    const { space, adapter } = setup();
    const table = space.getTable(fx.TbItem);
    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["category"],
        $select: ["category", { $fn: "sum", $field: "amount", $as: "total" }],
        $sort: { category: 1 },
      },
    });
    const agg = adapter().calls.find((c) => c.method === "aggregate")!;
    expect((agg.args[0] as DbQuery).controls.$sort).toEqual({ category: 1 });
  });

  it("views: no declared primary key → skipped; a declared one is appended", async () => {
    const { space, adapter } = setup();
    const cats = space.getView(fx.TbItemCats);
    expect(cats.primaryKeys).toEqual([]);
    await cats.findMany({ filter: {}, controls: { $sort: { category: 1 } } });
    expect(sentSort(adapter())).toEqual({ category: 1 });

    // Selecting the source's key does not declare it: the view needs its own `@meta.id`.
    const refId = space.getView(fx.TbItemRefId);
    expect(refId.primaryKeys).toEqual([]);
    await refId.findMany({ filter: {}, controls: { $sort: { category: 1 } } });
    expect(sentSort(adapter())).toEqual({ category: 1 });

    const keyed = space.getView(fx.TbItemKeyed);
    expect(keyed.primaryKeys).toEqual(["id"]);
    await keyed.findMany({ filter: {}, controls: { $sort: { category: -1 } } });
    expect(sentSort(adapter())).toEqual({ category: -1, id: -1 });
  });
});
