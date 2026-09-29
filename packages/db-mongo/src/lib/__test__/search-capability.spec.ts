import { describe, it, expect, beforeAll } from "vite-plus/test";
import type { TSearchIndexInfo } from "@atscript/db";

import type { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Every vector entry `getSearchIndexes()` publishes must carry `type: "vector"`:
// `BaseDbAdapter.isSearchable()` derives TEXT capability from that tag, so a
// missed tag makes a vector-only collection claim a `$search` it cannot run.
// Mongo is where that is least obvious — classic `$text`, Atlas `$search` and
// `$vectorSearch` all register in ONE index map, keyed by name.

const mongo = createTestSpace();

let fixtures: any;

beforeAll(async () => {
  await prepareFixtures();
  fixtures = await import("./fixtures/search-capability.as");
});

const adapterFor = (type: any) => mongo.getAdapter(type) as unknown as MongoAdapter;

/** The kinds an index list publishes, sorted — `type` omitted means text. */
const types = (indexes: TSearchIndexInfo[]) =>
  indexes.map((i) => i.type ?? "text").sort((a, b) => a.localeCompare(b));

describe("MongoAdapter search capability", () => {
  it("a classic @db.index.fulltext collection is searchable", () => {
    expect(types(adapterFor(fixtures.CapText).getSearchIndexes())).toEqual(["text"]);
    expect(adapterFor(fixtures.CapText).isSearchable()).toBe(true);
  });

  // The Atlas track reaches text search with no `@db.index.fulltext` at all —
  // which is why the capability is derived from the published index list rather
  // than from any one annotation.
  it("an Atlas dynamic-text collection is searchable", () => {
    expect(types(adapterFor(fixtures.CapAtlas).getSearchIndexes())).toEqual(["text"]);
    expect(adapterFor(fixtures.CapAtlas).isSearchable()).toBe(true);
  });

  it("a vector-only collection publishes its index but is NOT text-searchable", () => {
    const adapter = adapterFor(fixtures.CapVector);
    expect(types(adapter.getSearchIndexes())).toEqual(["vector"]);
    expect(adapter.isSearchable()).toBe(false);
    expect(adapter.isVectorSearchable()).toBe(true);
  });

  it("a vector index alongside a text one does not hide it", () => {
    const adapter = adapterFor(fixtures.CapBoth);
    expect(types(adapter.getSearchIndexes())).toEqual(["text", "vector"]);
    expect(adapter.isSearchable()).toBe(true);
    expect(adapter.isVectorSearchable()).toBe(true);
  });

  // since 0.1.143 — the logical fields each index reads + the default of each type.
  it("publishes each index's logical fields and the per-type default", () => {
    expect(adapterFor(fixtures.CapBoth).getSearchIndexes()).toEqual([
      expect.objectContaining({
        name: "embedding",
        type: "vector",
        fields: ["embedding"],
        isDefault: true,
      }),
      expect.objectContaining({
        name: "DEFAULT",
        type: "text",
        fields: ["title"],
        isDefault: true,
      }),
    ]);
  });

  it("a dynamic mapping reads every field (fields omitted)", () => {
    const [index] = adapterFor(fixtures.CapAtlas).getSearchIndexes();
    expect(index).toMatchObject({ name: "DEFAULT", type: "text", isDefault: true });
    expect(index!.fields).toBeUndefined();
  });

  it("static Atlas indexes list their mapped fields; DEFAULT aliases the first", async () => {
    const { Member, Person } = await import("./fixtures/search-collection.as");
    expect(
      adapterFor(Member)
        .getSearchIndexes()
        .map((i) => [i.name, i.fields, i.isDefault]),
    ).toEqual([
      ["members_exact", ["username"], false],
      ["members_prefix", ["username"], false],
      ["DEFAULT", ["username"], true],
    ]);
    expect(adapterFor(Person).getSearchIndexes()[0]).toMatchObject({
      name: "people",
      fields: ["username", "bio"],
    });
  });
});
