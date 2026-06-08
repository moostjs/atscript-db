import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// `@db.index.fulltext` on MongoDB used to be registered through TWO paths — core
// (`atscript__fulltext__<name>`) AND the adapter (`atscript__text__<name>`) —
// producing two differently-named text indexes. MongoDB allows only one text
// index per collection, so the second createIndex threw IndexOptionsConflict
// (code 85), aborting schema sync. The adapter path is now gone: core is the
// single source, and the conversion defaults field weights to 1 to keep re-sync
// idempotent.

const mongo = createTestSpace();

beforeAll(prepareFixtures);

const TEXT_INDEX = "atscript__fulltext__articles_fts";
const LEGACY_DUP = "atscript__text__articles_fts";

let adapter: MongoAdapter;

function mockCol(existing: unknown[] = []) {
  const col = {
    listIndexes: () => ({ toArray: async () => existing }),
    createIndex: vi.fn(async (_fields: unknown, _opts?: unknown) => "ok"),
    dropIndex: vi.fn(async (_name: string) => undefined),
    listSearchIndexes: () => ({ toArray: async () => [] }),
  };
  vi.spyOn(adapter, "collection", "get").mockReturnValue(col as never);
  return col;
}

type Col = ReturnType<typeof mockCol>;

/** All createIndex calls whose options name === `name`. */
function createCalls(col: Col, name: string) {
  return col.createIndex.mock.calls.filter(
    (c) => (c[1] as { name?: string } | undefined)?.name === name,
  );
}

beforeEach(async () => {
  const { Article } = await import("./fixtures/search-collection.as");
  adapter = mongo.getAdapter(Article) as unknown as MongoAdapter;
  vi.spyOn(adapter, "ensureCollectionExists").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] @db.index.fulltext syncs to exactly ONE text index (no code 85)", () => {
  it("creates a single text index and never the duplicate atscript__text__* one", async () => {
    const col = mockCol([]);
    await adapter.syncIndexes();

    expect(createCalls(col, TEXT_INDEX)).toHaveLength(1);
    // The duplicate that used to collide with code 85 must NOT be created.
    expect(createCalls(col, LEGACY_DUP)).toHaveLength(0);
  });

  it("defaults every field's weight to 1 in the created text index", async () => {
    const col = mockCol([]);
    await adapter.syncIndexes();

    const [fields, opts] = createCalls(col, TEXT_INDEX)[0] as [
      Record<string, unknown>,
      { weights?: Record<string, number> },
    ];
    expect(fields).toEqual({ title: "text", body: "text" });
    expect(opts.weights).toEqual({ title: 1, body: 1 });
  });

  it("is idempotent — leaves an already-correct text index untouched on re-sync", async () => {
    // listIndexes() reports unweighted text fields as weight 1; the conversion
    // must match that, otherwise objMatch churns the index every sync.
    const col = mockCol([
      { v: 2, name: "_id_", key: { _id: 1 } },
      {
        v: 2,
        name: TEXT_INDEX,
        key: { _fts: "text", _ftsx: 1 },
        weights: { title: 1, body: 1 },
      },
    ]);
    await adapter.syncIndexes();

    expect(col.dropIndex).not.toHaveBeenCalledWith(TEXT_INDEX);
    expect(createCalls(col, TEXT_INDEX)).toHaveLength(0);
  });
});
