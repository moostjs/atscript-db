import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import { DbError } from "../db-error";
import { resolveAggregateSearch } from "../agg";

import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

/**
 * `$search` on a grouped query. Search narrows the ROWS, `$groupBy` shapes what
 * is left — orthogonal, so the term has to survive translation and reach the
 * adapter, which applies it before grouping. Until 0.1.129 the relational
 * mapper rebuilt the controls literal without it, so a grouped rollup (and its
 * `$count`) silently described rows the same search excludes from the leaf list.
 */

let AggOrders: any;

beforeAll(async () => {
  await prepareFixtures();
  AggOrders = (await import("./fixtures/agg-orders.as")).AggOrders;
});

class SearchableMockAdapter extends MockAdapter {
  override isSearchable(): boolean {
    return true;
  }
}

class SearchableNestedMockAdapter extends NestedMockAdapter {
  override isSearchable(): boolean {
    return true;
  }
}

// `region` is a declared dimension stored as `region_code`, so these cases also
// prove the mapper still renames while carrying the search controls.
const GROUPED = {
  $groupBy: ["region"],
  $select: ["region", { $fn: "sum", $field: "amount", $as: "total" }],
} as any;

/** The `controls` the adapter's `aggregate()` was last called with. */
function lastControls(adapter: MockAdapter) {
  const call = adapter.calls.filter((c) => c.method === "aggregate").at(-1);
  return call?.args[0].controls;
}

describe("resolveAggregateSearch", () => {
  it("returns the trimmed term and the named index", () => {
    expect(resolveAggregateSearch({ $search: "  hotel  ", $index: "by_title" })).toEqual({
      text: "hotel",
      indexName: "by_title",
    });
  });

  it("leaves indexName undefined when no index is named", () => {
    expect(resolveAggregateSearch({ $search: "hotel" })).toEqual({
      text: "hotel",
      indexName: undefined,
    });
    expect(resolveAggregateSearch({ $search: "hotel", $index: "" })).toEqual({
      text: "hotel",
      indexName: undefined,
    });
  });

  it("treats absent, blank and non-string terms as no search at all", () => {
    expect(resolveAggregateSearch(undefined)).toBeUndefined();
    expect(resolveAggregateSearch({})).toBeUndefined();
    expect(resolveAggregateSearch({ $search: "" })).toBeUndefined();
    expect(resolveAggregateSearch({ $search: "   " })).toBeUndefined();
    expect(resolveAggregateSearch({ $search: 42 })).toBeUndefined();
    expect(resolveAggregateSearch({ $search: null })).toBeUndefined();
  });
});

describe("AtscriptDbTable.aggregate — $search reaches the adapter", () => {
  it("relational mapper forwards $search and $index", async () => {
    const adapter = new SearchableMockAdapter();
    const table = new AtscriptDbTable(AggOrders, adapter);
    await table.aggregate({
      filter: {},
      controls: { ...GROUPED, $search: "hotel", $index: "by_title" },
    });
    const controls = lastControls(adapter);
    expect(controls.$search).toBe("hotel");
    expect(controls.$index).toBe("by_title");
    // The grouped shape is untouched by the presence of a term.
    expect(controls.$groupBy).toEqual(["region_code"]);
  });

  it("document mapper forwards $search and $index", async () => {
    const adapter = new SearchableNestedMockAdapter();
    const table = new AtscriptDbTable(AggOrders, adapter);
    await table.aggregate({
      filter: {},
      controls: { ...GROUPED, $search: "hotel", $index: "by_title" },
    });
    const controls = lastControls(adapter);
    expect(controls.$search).toBe("hotel");
    expect(controls.$index).toBe("by_title");
  });

  it("adds nothing when there is no term — the plain grouped path is unchanged", async () => {
    const adapter = new SearchableMockAdapter();
    const table = new AtscriptDbTable(AggOrders, adapter);
    await table.aggregate({ filter: {}, controls: { ...GROUPED } });
    const controls = lastControls(adapter);
    expect(controls.$search).toBeUndefined();
    expect(controls.$index).toBeUndefined();
  });
});

describe("AtscriptDbTable.aggregate — $search on a source that cannot run it", () => {
  it("rejects rather than silently returning unsearched groups", async () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(AggOrders, adapter);
    expect(adapter.isSearchable()).toBe(false);

    const err = await table
      .aggregate({ filter: {}, controls: { ...GROUPED, $search: "hotel" } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("INVALID_QUERY");
    expect((err as DbError).errors[0]?.path).toBe("$search");
    // The query never reached the adapter.
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });

  it("an empty term is no term at all — the plain grouped path runs", async () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(AggOrders, adapter);
    await table.aggregate({ filter: {}, controls: { ...GROUPED, $search: "" } });
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(true);
  });

  it("a blank-but-present term still asks for a search, so it is rejected too", async () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(AggOrders, adapter);
    const err = await table
      .aggregate({ filter: {}, controls: { ...GROUPED, $search: "   " } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).errors[0]?.path).toBe("$search");
  });
});

describe("AtscriptDbTable.aggregate — a blank-but-present $search matches nothing", () => {
  // Leaf parity: `search()` returns [] outright for a whitespace-only term on
  // SQLite/Postgres, and matches nothing on MySQL/Mongo. A grouped query that
  // answered with EVERY group would be the same leaf/rollup divergence this
  // whole change closes, just on a marginal input.
  it("returns no groups, without reaching the adapter", async () => {
    const adapter = new SearchableMockAdapter();
    const table = new AtscriptDbTable(AggOrders, adapter);
    const rows = await table.aggregate({ filter: {}, controls: { ...GROUPED, $search: "   " } });
    expect(rows).toEqual([]);
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });

  it("returns a zero count for the same query with $count", async () => {
    const adapter = new SearchableMockAdapter();
    const table = new AtscriptDbTable(AggOrders, adapter);
    const rows = await table.aggregate({
      filter: {},
      controls: { ...GROUPED, $search: "   ", $count: true },
    });
    expect(rows).toEqual([{ count: 0 }]);
  });
});
