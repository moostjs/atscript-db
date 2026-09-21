import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import { DbError } from "../db-error";
import type { TSearchIndexInfo } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * `isSearchable()` answers one question: can this source run `$search`?
 *
 * It used to answer a different one — "does this source list any search index
 * at all" — and every adapter publishes its VECTOR indexes there too, for the
 * index picker. So a table whose only declaration was `@db.search.vector`
 * claimed text search it cannot do: the core let the term through and the
 * adapter threw a raw "no fulltext index" (a 500, not the 400 an unsupported
 * query deserves), while the `@db.column.searchable` HTTP fallback — gated on
 * this being `false` — stayed switched off on exactly those tables.
 */

let AggOrders: any;

beforeAll(async () => {
  await prepareFixtures();
  AggOrders = (await import("./fixtures/agg-orders.as")).AggOrders;
});

/** A mock adapter that publishes whatever index list a case needs. */
class IndexedMockAdapter extends MockAdapter {
  constructor(private readonly indexes: TSearchIndexInfo[]) {
    super();
  }
  override getSearchIndexes(): TSearchIndexInfo[] {
    return this.indexes;
  }
}

/** Vector-only, and able to actually run a vector search. */
class VectorOnlyAdapter extends IndexedMockAdapter {
  constructor() {
    super([{ name: "embedding", description: "vector(512)", type: "vector" }]);
  }
  override isVectorSearchable(): boolean {
    return true;
  }
  override async vectorSearch(): Promise<Array<Record<string, unknown>>> {
    this.record("vectorSearch");
    return [{ id: 1 }];
  }
}

describe("BaseDbAdapter.isSearchable — text indexes only", () => {
  const cases: Array<[string, TSearchIndexInfo[], boolean]> = [
    ["no indexes at all", [], false],
    ["a text index", [{ name: "ft", type: "text" }], true],
    ["a vector index only", [{ name: "embedding", type: "vector" }], false],
    [
      "both kinds",
      [
        { name: "embedding", type: "vector" },
        { name: "ft", type: "text" },
      ],
      true,
    ],
    // `type` is optional. An adapter written before the field existed only ever
    // listed text indexes, so an untyped entry has to keep meaning "text".
    ["an untyped index", [{ name: "legacy" }], true],
  ];

  for (const [label, indexes, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(new IndexedMockAdapter(indexes).isSearchable()).toBe(expected);
    });
  }
});

describe("a vector-only table and $search", () => {
  let adapter: VectorOnlyAdapter;
  let table: any;

  beforeEach(() => {
    adapter = new VectorOnlyAdapter();
    table = new AtscriptDbTable(AggOrders, adapter);
  });

  /** Asserts the query was refused as unsupported, not answered wrongly. */
  async function expectSearchRejected(promise: Promise<unknown>) {
    const err = (await promise.catch((e: unknown) => e)) as DbError;
    expect(err).toBeInstanceOf(DbError);
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.errors[0]?.path).toBe("$search");
    expect(err.errors[0]?.message).toContain("no text search index");
  }

  it("rejects search() at the core gate instead of reaching the adapter", async () => {
    await expectSearchRejected(table.search("hotel", {}));
    expect(adapter.calls.some((c) => c.method === "search")).toBe(false);
  });

  it("rejects searchWithCount() the same way", async () => {
    await expectSearchRejected(table.searchWithCount("hotel", {}));
  });

  it("rejects a grouped $search — the rollup never describes unsearched rows", async () => {
    await expectSearchRejected(
      table.aggregate({
        filter: {},
        controls: {
          $groupBy: ["region"],
          $select: ["region", { $fn: "sum", $field: "amount", $as: "total" }],
          $search: "hotel",
        },
      }),
    );
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });

  it("points at the vector index, but only on a table that has one", async () => {
    const bare: any = new AtscriptDbTable(AggOrders, new MockAdapter());
    const bareErr = (await bare.search("hotel", {}).catch((e: unknown) => e)) as DbError;
    expect(bareErr.errors[0]?.message).not.toContain("vectorSearch()");

    const vectorErr = (await table.search("hotel", {}).catch((e: unknown) => e)) as DbError;
    expect(vectorErr.errors[0]?.message).toContain("vectorSearch()");
  });

  it("still runs vectorSearch() — that path never took the text gate", async () => {
    const rows = await table.vectorSearch([0.1, 0.2, 0.3]);
    expect(rows).toEqual([{ id: 1 }]);
    expect(adapter.calls.some((c) => c.method === "vectorSearch")).toBe(true);
  });
});
