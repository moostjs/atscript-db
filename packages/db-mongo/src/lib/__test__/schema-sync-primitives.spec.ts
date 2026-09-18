import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { AtscriptDbView } from "@atscript/db";

import { ensureTableImpl, hasRowsImpl, getObjectKindImpl } from "../mongo-schema-sync";
import type { TMongoSchemaSyncHost } from "../mongo-schema-sync";
import { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Schema-sync primitives (since 0.1.128) against a fake host — no server.

function fakeHost(opts: {
  findOne?: unknown;
  collections?: Array<{ name: string; type: string }>;
  exists?: boolean;
}) {
  const findOne = vi.fn().mockResolvedValue(opts.findOne ?? null);
  const createCollection = vi.fn().mockResolvedValue(undefined);
  const host = {
    db: {
      collection: vi.fn(() => ({ findOne })),
      listCollections: vi.fn(() => ({ toArray: async () => opts.collections ?? [] })),
      createCollection,
    },
    _table: { tableName: "things", indexes: new Map(), flatMap: new Map() },
    _getSessionOpts: () => ({}),
    _log: () => {},
    resolveTableName: () => "things",
    collectionExists: async () => opts.exists ?? false,
    ensureCollectionExists: vi.fn().mockResolvedValue(undefined),
  };
  return { host: host as unknown as TMongoSchemaSyncHost, findOne, createCollection, raw: host };
}

beforeAll(prepareFixtures);

describe("[mongo] hasRowsImpl", () => {
  it("probes with findOne + _id projection (exact, not the estimated count)", async () => {
    const { host, findOne, raw } = fakeHost({ findOne: { _id: 1 } });
    expect(await hasRowsImpl(host)).toBe(true);
    expect(raw.db.collection).toHaveBeenCalledWith("things");
    expect(findOne).toHaveBeenCalledWith({}, { projection: { _id: 1 } });
    const empty = fakeHost({ findOne: null });
    expect(await hasRowsImpl(empty.host, "old_things")).toBe(false);
    expect(empty.raw.db.collection).toHaveBeenCalledWith("old_things");
  });
});

describe("[mongo] getObjectKindImpl", () => {
  it("maps listCollections types", async () => {
    expect(
      await getObjectKindImpl(
        fakeHost({ collections: [{ name: "x", type: "collection" }] }).host,
        "x",
      ),
    ).toBe("table");
    expect(
      await getObjectKindImpl(fakeHost({ collections: [{ name: "x", type: "view" }] }).host, "x"),
    ).toBe("view");
    expect(await getObjectKindImpl(fakeHost({ collections: [] }).host, "x")).toBeUndefined();
  });
});

describe("[mongo] ensureTableImpl — structural view detection", () => {
  it("creates a view for a duck-typed readable and excludes @db.ignore fields from $project", async () => {
    const mongo = createTestSpace();
    const { ViTaskList } = await import("./fixtures/view-ignore.as");
    const real = mongo.getView(ViTaskList) as AtscriptDbView;
    const duck = {
      isView: true,
      isExternal: false,
      tableName: real.tableName,
      viewPlan: real.viewPlan,
      fieldDescriptors: real.fieldDescriptors,
      getViewColumnMappings: () => real.getViewColumnMappings(),
    };
    expect(duck instanceof AtscriptDbView).toBe(false);

    const { host, createCollection, raw } = fakeHost({ exists: false });
    (raw._table as any).tableName = real.tableName;
    await ensureTableImpl(host, duck);

    expect(raw.ensureCollectionExists).not.toHaveBeenCalled();
    expect(createCollection).toHaveBeenCalledOnce();
    const [name, options] = createCollection.mock.calls[0] as [
      string,
      { viewOn: string; pipeline: any[] },
    ];
    expect(name).toBe("vi_task_list");
    expect(options.viewOn).toBe("vi_tasks");
    const project = options.pipeline.find((s) => s.$project)!.$project;
    expect(Object.keys(project).toSorted()).toEqual(["_id", "id", "title"]);
    expect(project).not.toHaveProperty("computed");
  });

  it("a plain table still goes through ensureCollectionExists", async () => {
    const { host, createCollection, raw } = fakeHost({});
    await ensureTableImpl(host, { isView: false, tableName: "things" });
    expect(raw.ensureCollectionExists).toHaveBeenCalledOnce();
    expect(createCollection).not.toHaveBeenCalled();
  });
});

describe("[mongo] adapter wiring", () => {
  it("exposes hasRows / getObjectKind / rebuildPrimaryKey (no-op)", async () => {
    const mongo = createTestSpace();
    const { ViTask } = await import("./fixtures/view-ignore.as");
    const adapter = mongo.getAdapter(ViTask) as unknown as MongoAdapter;
    expect(typeof adapter.hasRows).toBe("function");
    expect(typeof adapter.getObjectKind).toBe("function");
    await expect(
      adapter.rebuildPrimaryKey({ from: ["_id"], to: ["_id"] }),
    ).resolves.toBeUndefined();
  });
});

/** A fake `Db` for an adapter constructed WITHOUT a readable. */
function fakeDb(opts: { findOne?: unknown; collections?: Array<{ name: string; type: string }> }) {
  const findOne = vi.fn().mockResolvedValue(opts.findOne ?? null);
  const drop = vi.fn().mockResolvedValue(true);
  const db = {
    collection: vi.fn((_name: string) => ({ findOne, drop })),
    listCollections: vi.fn(() => ({ toArray: async () => opts.collections ?? [] })),
  };
  return { db, findOne, drop };
}

// `DbSpace` runs the name-taking primitives on a factory-fresh adapter that
// never had a readable registered — they must not touch `this._table`.
describe("[mongo] administrative adapter (no registered readable)", () => {
  it("hasRows(name) / getObjectKind / drops by name work without a readable", async () => {
    const { db, findOne, drop } = fakeDb({
      findOne: { _id: 1 },
      collections: [{ name: "v", type: "view" }],
    });
    const admin = new MongoAdapter(db as any);
    expect(await admin.hasRows("old_things")).toBe(true);
    expect(db.collection).toHaveBeenCalledWith("old_things");
    expect(findOne).toHaveBeenCalledWith({}, { projection: { _id: 1 } });
    expect(await admin.getObjectKind("v")).toBe("view");
    await admin.dropViewByName("v");
    await admin.dropTableByName("things");
    await admin.dropTablesByName(["cycle_a", "cycle_b"]);
    expect(db.collection.mock.calls.map((c) => c[0])).toEqual([
      "old_things",
      "v",
      "things",
      "cycle_a",
      "cycle_b",
    ]);
    expect(drop).toHaveBeenCalledTimes(4);
  });

  it("hasRows() without a name on an unbound adapter fails with a clear error, not a TypeError", async () => {
    const admin = new MongoAdapter(fakeDb({}).db as any);
    await expect(admin.hasRows()).rejects.toThrow(/no registered readable/);
  });
});
