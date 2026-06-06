import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// A unique index on an OPTIONAL field must tolerate many value-less rows
// (Mongo would otherwise reject the 2nd null with E11000, blocking startup
// schema sync). SQL adapters already get this from the standard NULLS DISTINCT
// rule; this suite pins the equivalent behaviour for the Mongo adapter, which
// emits a *partial* unique index derived from the field's optionality.

const mongo = createTestSpace();

beforeAll(prepareFixtures);

const NAME = {
  username: "atscript__unique__username_idx",
  email: "atscript__unique__email_idx",
  extid: "atscript__unique__extid_idx",
  tenantHandle: "atscript__unique__tenant_handle_idx",
  extref: "atscript__unique__extref_idx",
  pair: "atscript__unique__pair_idx",
};

let adapter: MongoAdapter;

/** A minimal mocked Mongo collection that records create/drop calls. */
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

/** Options passed to createIndex for a given managed index name (or undefined). */
function createdOpts(
  col: ReturnType<typeof mockCol>,
  name: string,
): Record<string, unknown> | undefined {
  const call = col.createIndex.mock.calls.find(
    (c) => (c[1] as { name?: string } | undefined)?.name === name,
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

/** Keys (field spec) passed to createIndex for a given managed index name. */
function createdFields(
  col: ReturnType<typeof mockCol>,
  name: string,
): Record<string, unknown> | undefined {
  const call = col.createIndex.mock.calls.find(
    (c) => (c[1] as { name?: string } | undefined)?.name === name,
  );
  return call?.[0] as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  const { Creds } = await import("./fixtures/present-only-unique.as");
  adapter = mongo.getAdapter(Creds) as unknown as MongoAdapter;
  vi.spyOn(adapter, "ensureCollectionExists").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] present-only unique indexes (derived from field optionality)", () => {
  it("emits a partial unique index for an optional string field", async () => {
    const col = mockCol([]);
    await adapter.syncIndexes();

    const opts = createdOpts(col, NAME.email);
    expect(opts).toBeDefined();
    expect(opts!.unique).toBe(true);
    expect(opts!.partialFilterExpression).toEqual({ email: { $type: "string" } });
  });

  it("emits a plain unique index (no partial filter) for a required field", async () => {
    const col = mockCol([]);
    await adapter.syncIndexes();

    const opts = createdOpts(col, NAME.username);
    expect(opts).toBeDefined();
    expect(opts!.unique).toBe(true);
    expect(opts!.partialFilterExpression).toBeUndefined();
  });

  it("derives $type from the design type for a non-string optional field", async () => {
    const col = mockCol([]);
    await adapter.syncIndexes();

    // Regression: hardcoding $type:'string' would index zero numeric values
    // and silently drop the uniqueness guarantee. Must be the 'number' alias.
    const opts = createdOpts(col, NAME.extid);
    expect(opts!.partialFilterExpression).toEqual({ externalId: { $type: "number" } });
  });

  it("matches both objectId and string for an optional mongo.objectId field", async () => {
    const col = mockCol([]);
    await adapter.syncIndexes();

    // mongo.objectId is a string primitive but may be stored as a native BSON
    // ObjectId — a hardcoded $type:'string' would silently exempt those rows.
    expect(createdOpts(col, NAME.extref)!.partialFilterExpression).toEqual({
      externalRef: { $type: ["objectId", "string"] },
    });
  });

  it("$ands both fields of a two-optional composite, with clauses sorted by name", async () => {
    const col = mockCol([]);
    await adapter.syncIndexes();

    // Declared zeta-then-alpha; the filter clauses are sorted (alpha, zeta) so a
    // field-order change in the model does not churn the index on the next sync.
    expect(createdOpts(col, NAME.pair)!.partialFilterExpression).toEqual({
      $and: [{ alpha: { $type: "string" } }, { zeta: { $type: "string" } }],
    });
  });

  it("filters only the optional field of a composite required+optional unique index", async () => {
    const col = mockCol([]);
    await adapter.syncIndexes();

    expect(createdFields(col, NAME.tenantHandle)).toEqual({ tenantId: 1, handle: 1 });
    // tenantId is required → not in the filter; handle is optional → present-only.
    expect(createdOpts(col, NAME.tenantHandle)!.partialFilterExpression).toEqual({
      handle: { $type: "string" },
    });
  });

  it("migrates an existing PLAIN unique index to present-only (drop + recreate)", async () => {
    // A collection created before this fix carries a plain unique index whose
    // key { email: 1 } still matches — reconciliation must NOT treat it as equal
    // (the silent-no-op trap), but drop it and rebuild it as partial.
    const col = mockCol([
      { v: 2, name: "_id_", key: { _id: 1 } },
      { v: 2, name: NAME.email, key: { email: 1 }, unique: true },
    ]);
    await adapter.syncIndexes();

    expect(col.dropIndex).toHaveBeenCalledWith(NAME.email);
    const opts = createdOpts(col, NAME.email);
    expect(opts!.partialFilterExpression).toEqual({ email: { $type: "string" } });
  });

  it("is idempotent — leaves an already-correct partial unique index untouched", async () => {
    const col = mockCol([
      { v: 2, name: "_id_", key: { _id: 1 } },
      {
        v: 2,
        name: NAME.email,
        key: { email: 1 },
        unique: true,
        partialFilterExpression: { email: { $type: "string" } },
      },
    ]);
    await adapter.syncIndexes();

    // The matching index is neither dropped nor recreated.
    expect(col.dropIndex).not.toHaveBeenCalledWith(NAME.email);
    expect(createdOpts(col, NAME.email)).toBeUndefined();
  });
});
