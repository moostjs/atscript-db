import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";

import type { DbQuery } from "@atscript/db";
import { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Regression coverage for nested/embedded search fields. The static-mapping
// generator used to emit a flattened dotted key ("identity.name"), which Atlas
// treats as a literal top-level field name — so $search silently matched
// nothing. The correct Atlas static shapes are:
//   - single embedded object → a `document` node; queried with plain operators
//     (the wildcard `text` operator and an explicit dotted `autocomplete` path).
//   - array of objects → an `embeddedDocuments` node; queried via the
//     `embeddedDocument` operator (outer path = array root, inner path = full
//     dotted path), since the wildcard `text` operator can't reach them.

const mongo = createTestSpace();

beforeAll(prepareFixtures);

let adapter: MongoAdapter;
let aggregate: ReturnType<typeof vi.fn>;

function mockCollection() {
  aggregate = vi.fn(() => ({ toArray: async () => [] }));
  vi.spyOn(adapter, "collection", "get").mockReturnValue({ aggregate } as never);
}

function lastStage(): Record<string, any> {
  const pipeline = aggregate.mock.calls.at(-1)?.[0] as Record<string, unknown>[];
  return pipeline[0] as Record<string, any>;
}

const AUTOCOMPLETE_MAPPING = {
  type: "autocomplete",
  tokenization: "edgeGram",
  minGrams: 2,
  maxGrams: 15,
  foldDiacritics: true,
};

const EMPTY_QUERY: DbQuery = { filter: {}, controls: {} };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] single embedded object → document mapping", () => {
  beforeEach(async () => {
    const { DealerGroup } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(DealerGroup) as unknown as MongoAdapter;
    mockCollection();
  });

  it("nests the embedded fields under a `document` node (no dotted key)", () => {
    const index = adapter.getMongoSearchIndex("dg_search") as any;
    const fields = index.definition.mappings.fields;

    // The buggy flattened key must NOT be present.
    expect(fields["identity.name"]).toBeUndefined();
    expect(fields["identity.tagline"]).toBeUndefined();

    // A single `document` container holds both leaves.
    expect(fields.identity.type).toBe("document");
    expect(fields.identity.fields.name).toContainEqual(AUTOCOMPLETE_MAPPING);
    expect(fields.identity.fields.name).toContainEqual({ type: "string" });
    expect(fields.identity.fields.tagline).toEqual({
      type: "string",
      analyzer: "lucene.english",
    });
  });

  it("queries the embedded autocomplete field by its full dotted path (no embeddedDocument)", async () => {
    await adapter.search("sun", EMPTY_QUERY, "dg_search");
    const should = lastStage().$search.compound.should;

    // Wildcard word match reaches `document`-nested string fields.
    expect(should).toContainEqual({
      text: { query: "sun", path: { wildcard: "*" }, fuzzy: { maxEdits: 1 } },
    });
    // Autocomplete uses the explicit dotted path, NOT wrapped in embeddedDocument.
    expect(should).toContainEqual({
      autocomplete: { query: "sun", path: "identity.name", fuzzy: { maxEdits: 1 } },
    });
    expect(JSON.stringify(should)).not.toContain("embeddedDocument");
  });
});

describe("[mongo] array of objects → embeddedDocuments mapping", () => {
  beforeEach(async () => {
    const { DealerList } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(DealerList) as unknown as MongoAdapter;
    mockCollection();
  });

  it("maps the array field as `embeddedDocuments` with nested leaves", () => {
    const index = adapter.getMongoSearchIndex("dl_search") as any;
    const fields = index.definition.mappings.fields;

    expect(fields["dealers.name"]).toBeUndefined();
    expect(fields.dealers.type).toBe("embeddedDocuments");
    expect(fields.dealers.fields.name).toContainEqual(AUTOCOMPLETE_MAPPING);
    expect(fields.dealers.fields.name).toContainEqual({ type: "string" });
    expect(fields.dealers.fields.bio).toEqual({ type: "string", analyzer: "lucene.english" });
  });

  it("queries array-of-object fields via the embeddedDocument operator", async () => {
    await adapter.search("sun", EMPTY_QUERY, "dl_search");
    const should = lastStage().$search.compound.should;

    // Word match inside the array — `text` accepts an array of paths. Both the
    // plain-text `bio` and the autocomplete field's `string` companion (`name`)
    // are word-matchable, so both appear.
    expect(should).toContainEqual({
      embeddedDocument: {
        path: "dealers",
        operator: {
          text: { query: "sun", path: ["dealers.name", "dealers.bio"], fuzzy: { maxEdits: 1 } },
        },
      },
    });
    // Autocomplete inside the array — one explicit path per clause.
    expect(should).toContainEqual({
      embeddedDocument: {
        path: "dealers",
        operator: { autocomplete: { query: "sun", path: "dealers.name", fuzzy: { maxEdits: 1 } } },
      },
    });
    // The top-level wildcard word clause is still present.
    expect(should).toContainEqual({
      text: { query: "sun", path: { wildcard: "*" }, fuzzy: { maxEdits: 1 } },
    });
  });
});

describe("[mongo] array → embedded object → leaf (mixed nesting)", () => {
  beforeEach(async () => {
    const { DealerMixed } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(DealerMixed) as unknown as MongoAdapter;
    mockCollection();
  });

  it("nests embeddedDocuments > document > leaf", () => {
    const index = adapter.getMongoSearchIndex("dm_search") as any;
    const fields = index.definition.mappings.fields;

    expect(fields.dealers.type).toBe("embeddedDocuments");
    expect(fields.dealers.fields.identity.type).toBe("document");
    expect(fields.dealers.fields.identity.fields.name).toContainEqual(AUTOCOMPLETE_MAPPING);
  });

  it("uses the array root as the embeddedDocument path and the full dotted inner path", async () => {
    await adapter.search("sun", EMPTY_QUERY, "dm_search");
    const should = lastStage().$search.compound.should;

    expect(should).toContainEqual({
      embeddedDocument: {
        path: "dealers",
        operator: {
          autocomplete: { query: "sun", path: "dealers.identity.name", fuzzy: { maxEdits: 1 } },
        },
      },
    });
  });
});

describe("[mongo] doubly-nested arrays (array → array → leaf)", () => {
  beforeEach(async () => {
    const { DealerDeep } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(DealerDeep) as unknown as MongoAdapter;
    mockCollection();
  });

  it("nests embeddedDocuments inside embeddedDocuments per array level", () => {
    const index = adapter.getMongoSearchIndex("dd_search") as any;
    const fields = index.definition.mappings.fields;

    expect(fields.regions.type).toBe("embeddedDocuments");
    expect(fields.regions.fields.outlets.type).toBe("embeddedDocuments");
    expect(fields.regions.fields.outlets.fields.name).toContainEqual(AUTOCOMPLETE_MAPPING);
  });

  it("wraps the query in one embeddedDocument operator per array level (outer→inner)", async () => {
    await adapter.search("sun", EMPTY_QUERY, "dd_search");
    const should = lastStage().$search.compound.should;

    // outer path = first array root, inner path = second array root, innermost
    // operator uses the full dotted leaf path.
    expect(should).toContainEqual({
      embeddedDocument: {
        path: "regions",
        operator: {
          embeddedDocument: {
            path: "regions.outlets",
            operator: {
              autocomplete: {
                query: "sun",
                path: "regions.outlets.name",
                fuzzy: { maxEdits: 1 },
              },
            },
          },
        },
      },
    });
  });
});

describe("[mongo] @db.column renames map to the physical top-level key", () => {
  beforeEach(async () => {
    const { RenamedSearch } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(RenamedSearch) as unknown as MongoAdapter;
    mockCollection();
  });

  it("keys the mapping by the physical (renamed) name, not the logical one", () => {
    const index = adapter.getMongoSearchIndex("rn_search") as any;
    const fields = index.definition.mappings.fields;

    // Top-level field `username` is stored as `handle` → mapping keyed `handle`.
    expect(fields.username).toBeUndefined();
    expect(fields.handle).toContainEqual(AUTOCOMPLETE_MAPPING);
    expect(fields.handle).toContainEqual({ type: "string" });

    // Embedded container `profile` is stored as `prof` (top-level rename), but the
    // nested leaf `bio` keeps its logical name (nested keys are stored as-is).
    expect(fields.profile).toBeUndefined();
    expect(fields.prof.type).toBe("document");
    expect(fields.prof.fields.bio).toEqual({ type: "string", analyzer: "lucene.english" });
  });

  it("queries the physical path so it matches stored documents", async () => {
    await adapter.search("ab", EMPTY_QUERY, "rn_search");
    const should = lastStage().$search.compound.should;

    // autocomplete targets the physical key `handle`, not logical `username`.
    expect(should).toContainEqual({
      autocomplete: { query: "ab", path: "handle", fuzzy: { maxEdits: 1 } },
    });
    expect(JSON.stringify(should)).not.toContain("username");
  });
});
