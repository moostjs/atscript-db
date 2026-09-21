import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { AtscriptDbTable, DbError } from "@atscript/db";
import type { TSearchIndexInfo } from "@atscript/db";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";

import { prepareFixtures } from "./test-utils";

// Every vector entry `getSearchIndexes()` publishes must carry `type: "vector"`:
// `BaseDbAdapter.isSearchable()` derives TEXT capability from that tag (vector
// entries are published for the index picker, not for `$search`), so a missed
// tag makes a vector-only table claim a search it cannot run.

let CapText: any;
let CapVector: any;
let CapBoth: any;

const drivers: BetterSqlite3Driver[] = [];

afterAll(() => {
  for (const driver of drivers) driver.close();
});

/** Binds a fixture table to a fresh adapter and forces the schema walk that
 *  registers its FTS5 indexes and vector fields. No table is ever created — the
 *  capability answer comes from the schema, not from the database. */
function bind(type: any) {
  const driver = new BetterSqlite3Driver(":memory:");
  drivers.push(driver);
  const adapter = new SqliteAdapter(driver);
  new AtscriptDbTable(type, adapter).getMetadata();
  return adapter;
}

/** The kinds an index list publishes, sorted — `type` omitted means text. */
const types = (indexes: TSearchIndexInfo[]) =>
  indexes.map((i) => i.type ?? "text").sort((a, b) => a.localeCompare(b));

describe("SqliteAdapter search capability", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/search-capability.as");
    CapText = fixtures.CapText;
    CapVector = fixtures.CapVector;
    CapBoth = fixtures.CapBoth;
  });

  it("a text index makes the table searchable", () => {
    const adapter = bind(CapText);
    expect(types(adapter.getSearchIndexes())).toEqual(["text"]);
    expect(adapter.isSearchable()).toBe(true);
  });

  it("a vector-only table publishes its index but is NOT text-searchable", () => {
    const adapter = bind(CapVector);
    expect(adapter.getSearchIndexes()).toEqual([
      expect.objectContaining({ name: "embedding", type: "vector" }),
    ]);
    expect(adapter.isSearchable()).toBe(false);
  });

  it("a vector index alongside a text one does not hide it", () => {
    const adapter = bind(CapBoth);
    expect(types(adapter.getSearchIndexes())).toEqual(["text", "vector"]);
    expect(adapter.isSearchable()).toBe(true);
  });

  // The DbError itself belongs to the core gate (`_ensureSearchable`), which the
  // core spec covers three ways. It is re-checked here, once across the four
  // adapters, so that a REAL adapter's published index list is proven to drive
  // that gate — the wiring between the two halves of this rule.
  it("$search on the vector-only table is rejected as an invalid query", async () => {
    const table: any = new AtscriptDbTable(CapVector, bind(CapVector));
    const err = (await table.search("hotel", {}).catch((e: unknown) => e)) as DbError;
    expect(err).toBeInstanceOf(DbError);
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.errors[0]?.path).toBe("$search");
  });
});
