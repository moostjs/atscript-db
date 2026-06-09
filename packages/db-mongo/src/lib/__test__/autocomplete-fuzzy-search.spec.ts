import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";

import type { DbQuery } from "@atscript/db";
import { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Covers the richer Atlas Search wiring:
//  - `@db.mongo.search.autocomplete` → field double-mapped as autocomplete +
//    string, and search() emits a `compound.should` (text + per-field
//    autocomplete) since the autocomplete operator can't use a wildcard path.
//  - Declared `fuzzy` is carried as index metadata (NOT in the Atlas index
//    definition) and applied at query time on the emitted operator.
//  - The `$fuzzy` request control overrides the declared fuzzy (and `0` disables).

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

const EMPTY_QUERY: DbQuery = { filter: {}, controls: {} };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] @db.mongo.search.autocomplete index shape", () => {
  beforeEach(async () => {
    const { Person } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Person) as unknown as MongoAdapter;
    mockCollection();
  });

  it("double-maps the autocomplete field as autocomplete + string", () => {
    const index = adapter.getMongoSearchIndex("people") as any;
    expect(index.type).toBe("search_text");

    const username = index.definition.mappings.fields.username;
    expect(Array.isArray(username)).toBe(true);
    expect(username).toContainEqual({
      type: "autocomplete",
      tokenization: "edgeGram",
      minGrams: 2,
      maxGrams: 15,
      foldDiacritics: true,
    });
    expect(username).toContainEqual({ type: "string" });

    // A plain @db.mongo.search.text field stays a single string mapping.
    expect(index.definition.mappings.fields.bio).toEqual({
      type: "string",
      analyzer: "lucene.english",
    });
  });

  it("carries declared fuzzy as index metadata, NOT in the Atlas definition", () => {
    const index = adapter.getMongoSearchIndex("people") as any;
    expect(index.fuzzy).toEqual({ maxEdits: 1 });
    // The inert `text` root key must be gone from what we send to Atlas.
    expect(index.definition.text).toBeUndefined();
  });
});

describe("[mongo] autocomplete search() query", () => {
  beforeEach(async () => {
    const { Person } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Person) as unknown as MongoAdapter;
    mockCollection();
  });

  it("emits compound.should: a wildcard text clause + a per-field autocomplete clause", async () => {
    await adapter.search("art", EMPTY_QUERY);
    const stage = lastStage();

    expect(stage.$search.compound.minimumShouldMatch).toBe(1);
    const should = stage.$search.compound.should;
    // exact-word ranking across all string-mapped fields
    expect(should).toContainEqual({
      text: { query: "art", path: { wildcard: "*" }, fuzzy: { maxEdits: 1 } },
    });
    // prefix/typeahead on the autocomplete field (explicit single path)
    expect(should).toContainEqual({
      autocomplete: { query: "art", path: "username", fuzzy: { maxEdits: 1 } },
    });
    // autocomplete must never reuse the wildcard path
    expect(JSON.stringify(should)).not.toContain('autocomplete":{"query":"art","path":{"wildcard');
  });

  it("$fuzzy control overrides the declared fuzzy", async () => {
    await adapter.search("art", { filter: {}, controls: { $fuzzy: 2 } } as unknown as DbQuery);
    const should = lastStage().$search.compound.should;
    expect(should).toContainEqual({
      autocomplete: { query: "art", path: "username", fuzzy: { maxEdits: 2 } },
    });
  });

  it("$fuzzy=0 disables fuzzy even when declared", async () => {
    await adapter.search("art", { filter: {}, controls: { $fuzzy: 0 } } as unknown as DbQuery);
    const should = lastStage().$search.compound.should;
    expect(should).toContainEqual({ autocomplete: { query: "art", path: "username" } });
    expect(JSON.stringify(should)).not.toContain("fuzzy");
  });
});

describe("[mongo] declared fuzzy without autocomplete", () => {
  beforeEach(async () => {
    const { Ticket } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Ticket) as unknown as MongoAdapter;
    mockCollection();
  });

  it("emits a plain text operator with fuzzy (no compound) when no field is autocomplete", async () => {
    await adapter.search("paymnt", EMPTY_QUERY);
    const stage = lastStage();
    expect(stage.$search.text).toEqual({
      query: "paymnt",
      path: { wildcard: "*" },
      fuzzy: { maxEdits: 2 },
    });
    expect(stage.$search.compound).toBeUndefined();
  });
});

describe("[mongo] same field, two indexes — variant selected by $index", () => {
  // The blessed way to use one search index "differently": define each behavior
  // as its own central index, then pick per request via $index. No query-time
  // mode switching — the index's behavior is locked in the annotation.
  beforeEach(async () => {
    const { Member } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Member) as unknown as MongoAdapter;
    mockCollection();
  });

  it("registers both indexes over the same field with distinct mappings", () => {
    const exact = adapter.getMongoSearchIndex("members_exact") as any;
    const prefix = adapter.getMongoSearchIndex("members_prefix") as any;

    // exact: plain word match, no fuzzy (declared 0)
    expect(exact.fuzzy).toBeUndefined();
    expect(exact.definition.mappings.fields.username).toEqual({
      type: "string",
      analyzer: "lucene.english",
    });

    // prefix: autocomplete + string, fuzzy declared
    expect(prefix.fuzzy).toEqual({ maxEdits: 1 });
    expect(Array.isArray(prefix.definition.mappings.fields.username)).toBe(true);
    expect(prefix.definition.mappings.fields.username).toContainEqual({
      type: "autocomplete",
      tokenization: "edgeGram",
      minGrams: 2,
      maxGrams: 15,
      foldDiacritics: true,
    });
  });

  it("$index=members_exact → plain word `text` operator, no compound, no fuzzy", async () => {
    await adapter.search("art", EMPTY_QUERY, "members_exact");
    const stage = lastStage();
    expect(stage.$search.text).toEqual({ query: "art", path: { wildcard: "*" } });
    expect(stage.$search.compound).toBeUndefined();
  });

  it("$index=members_prefix → compound autocomplete with the index's declared fuzzy", async () => {
    await adapter.search("art", EMPTY_QUERY, "members_prefix");
    const should = lastStage().$search.compound.should;
    expect(should).toContainEqual({
      autocomplete: { query: "art", path: "username", fuzzy: { maxEdits: 1 } },
    });
  });

  it("the two indexes target different mongot indexes (distinct keys)", () => {
    const exact = adapter.getMongoSearchIndex("members_exact") as any;
    const prefix = adapter.getMongoSearchIndex("members_prefix") as any;
    expect(exact.key).not.toBe(prefix.key);
  });
});

describe("[mongo] index strategy locks the query shape", () => {
  it("strategy 'autocomplete' (single field) → a single autocomplete operator, no text clause", async () => {
    const { Handle } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Handle) as unknown as MongoAdapter;
    mockCollection();
    expect((adapter.getMongoSearchIndex("handles") as any).strategy).toBe("autocomplete");

    await adapter.search("ab", EMPTY_QUERY);
    const stage = lastStage();
    expect(stage.$search.autocomplete).toEqual({ query: "ab", path: "nick" });
    expect(stage.$search.text).toBeUndefined();
    expect(stage.$search.compound).toBeUndefined();
  });

  it("strategy 'autocomplete' (multiple fields) → compound.should of autocomplete clauses only", async () => {
    const { Tag } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Tag) as unknown as MongoAdapter;
    mockCollection();

    await adapter.search("ab", EMPTY_QUERY);
    const should = lastStage().$search.compound.should;
    expect(should).toContainEqual({ autocomplete: { query: "ab", path: "label" } });
    expect(should).toContainEqual({ autocomplete: { query: "ab", path: "slug" } });
    expect(should.some((c: Record<string, unknown>) => "text" in c)).toBe(false);
  });

  it("strategy 'text' → a single text operator (no autocomplete clause); fuzzy still applies", async () => {
    const { Label } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Label) as unknown as MongoAdapter;
    mockCollection();
    expect((adapter.getMongoSearchIndex("labels") as any).strategy).toBe("text");

    await adapter.search("ab", EMPTY_QUERY);
    const stage = lastStage();
    expect(stage.$search.text).toEqual({
      query: "ab",
      path: { wildcard: "*" },
      fuzzy: { maxEdits: 1 },
    });
    expect(stage.$search.compound).toBeUndefined();
    expect(JSON.stringify(stage)).not.toContain("autocomplete");
  });

  it("default strategy (unset) still emits compound when autocomplete fields exist", async () => {
    const { Person } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(Person) as unknown as MongoAdapter;
    mockCollection();
    expect((adapter.getMongoSearchIndex("people") as any).strategy).toBeUndefined();

    await adapter.search("art", EMPTY_QUERY);
    expect(lastStage().$search.compound).toBeDefined();
  });
});

describe("[mongo] no declared fuzzy (dynamic index)", () => {
  beforeEach(async () => {
    const { SearchDoc } = await import("./fixtures/search-collection.as");
    adapter = mongo.getAdapter(SearchDoc) as unknown as MongoAdapter;
    mockCollection();
  });

  it("emits no fuzzy clause when none is declared or requested", async () => {
    await adapter.search("hello", EMPTY_QUERY);
    const stage = lastStage();
    expect(stage.$search.text).toEqual({ query: "hello", path: { wildcard: "*" } });
    expect(JSON.stringify(stage)).not.toContain("fuzzy");
  });

  it("applies a query-time $fuzzy even when nothing was declared", async () => {
    await adapter.search("hello", { filter: {}, controls: { $fuzzy: 1 } } as unknown as DbQuery);
    const stage = lastStage();
    expect(stage.$search.text).toEqual({
      query: "hello",
      path: { wildcard: "*" },
      fuzzy: { maxEdits: 1 },
    });
  });
});
