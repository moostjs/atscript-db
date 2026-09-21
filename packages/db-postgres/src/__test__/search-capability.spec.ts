import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";
import type { TSearchIndexInfo } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

// Every vector entry `getSearchIndexes()` publishes must carry `type: "vector"`:
// `BaseDbAdapter.isSearchable()` derives TEXT capability from that tag (vector
// entries are published for the index picker, not for `$search`), so a missed
// tag makes a vector-only table claim a search it cannot run.

let CapText: any;
let CapVector: any;
let CapBoth: any;

/** Binds a fixture table to a fresh adapter and forces the schema walk that
 *  registers its fulltext indexes and vector fields. */
function bind(type: any) {
  const adapter = new PostgresAdapter(createMockDriver());
  new AtscriptDbTable(type, adapter).getMetadata();
  return adapter;
}

/** The kinds an index list publishes, sorted — `type` omitted means text. */
const types = (indexes: TSearchIndexInfo[]) =>
  indexes.map((i) => i.type ?? "text").sort((a, b) => a.localeCompare(b));

describe("PostgresAdapter search capability", () => {
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
});
