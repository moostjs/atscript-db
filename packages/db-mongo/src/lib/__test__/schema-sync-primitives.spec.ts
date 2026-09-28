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

// ── View pipelines (since 0.1.136) ────────────────────────────────────────

describe("[mongo] view pipeline — $lookup forms, join kinds, physical paths", () => {
  let fx: Record<string, any>;

  beforeAll(async () => {
    fx = await import("./fixtures/views.as");
  });

  async function pipelineOf(type: unknown): Promise<any[]> {
    const view = createTestSpace().getView(type as never) as AtscriptDbView;
    const { host, createCollection, raw } = fakeHost({ exists: false });
    (raw._table as any).tableName = view.tableName;
    await ensureTableImpl(host, view);
    return (createCollection.mock.calls[0] as [string, { pipeline: any[] }])[1].pipeline;
  }

  it("uses the simple $lookup for = on a required target field; left keeps unmatched", async () => {
    const pipeline = await pipelineOf(fx.MvOrdersLeft);
    expect(pipeline.slice(0, 3)).toEqual([
      {
        $lookup: {
          from: "mv_customers",
          localField: "customerId",
          foreignField: "id",
          as: "__joined_mv_customers",
        },
      },
      { $unwind: { path: "$__joined_mv_customers", preserveNullAndEmptyArrays: true } },
      { $match: { status: { $ne: "void" } } },
    ]);
    // Physical (@db.column) and nested document paths; a column whose source
    // may be missing (here: the left-joined table) projects null for it, a
    // required entry column stays a plain path (index pushdown)
    expect(pipeline[3].$project).toEqual({
      _id: 0,
      id: "$id",
      customerName: { $ifNull: ["$__joined_mv_customers.full_name", null] },
      city: { $ifNull: ["$__joined_mv_customers.profile.city", null] },
    });
  });

  it("an inner join unwinds without preserving unmatched documents", async () => {
    const pipeline = await pipelineOf(fx.MvOrdersInner);
    expect(pipeline[1]).toEqual({
      $unwind: { path: "$__joined_mv_customers", preserveNullAndEmptyArrays: false },
    });
    // Required sources through an inner join stay plain paths — a `$match` /
    // `$sort` on the view pushes down (no `$ifNull` wrapper)
    expect(pipeline[2].$project.customerName).toBe("$__joined_mv_customers.full_name");
  });

  it("uses the pipeline form when the target field is optional (null never matches)", async () => {
    const [lookup] = await pipelineOf(fx.MvCustomerByCode);
    expect(lookup).toEqual({
      $lookup: {
        from: "mv_regions",
        let: { v0: "$code" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $gt: ["$code", null] },
                  { $gt: ["$$v0", null] },
                  { $eq: ["$code", "$$v0"] },
                ],
              },
            },
          },
        ],
        as: "__joined_mv_regions",
      },
    });
  });

  it("uses the pipeline form for a compound / non-equality condition", async () => {
    const [lookup] = await pipelineOf(fx.MvCustomerEligible);
    expect(lookup.$lookup.let).toEqual({ v0: "$regionId", v1: "$score" });
    expect(lookup.$lookup.pipeline[0].$match.$expr.$and).toHaveLength(2);
    expect(lookup.$lookup.localField).toBeUndefined();
  });

  it("a chained join reads its local field from the earlier join", async () => {
    const pipeline = await pipelineOf(fx.MvCustomerGeo);
    expect(pipeline[2]).toEqual({
      $lookup: {
        from: "mv_countries",
        localField: "__joined_mv_regions.countryId",
        foreignField: "id",
        as: "__joined_mv_countries",
      },
    });
    expect(pipeline[3]).toEqual({
      $unwind: { path: "$__joined_mv_countries", preserveNullAndEmptyArrays: true },
    });
  });

  it("translates the view filter with the query semantics (exists, not exists, field refs, /re/flags)", async () => {
    const [match] = await pipelineOf(fx.MvFilterOps);
    expect(match).toEqual({
      $match: {
        $and: [
          { code: { $ne: null } },
          { regionId: null },
          {
            $expr: {
              $and: [
                { $gt: ["$score", null] },
                { $gt: ["$regionId", null] },
                { $gt: ["$score", "$regionId"] },
              ],
            },
          },
          { full_name: { $regex: "^a", $options: "i" } },
        ],
      },
    });
  });

  it("reads a nested leaf's @db.column-annotated path where it is stored (since 0.1.137)", async () => {
    const zips = await pipelineOf(fx.MvStoreZips);
    expect(zips).toEqual([
      {
        $match: {
          $and: [
            { "address.zip": { $ne: null } },
            {
              $expr: {
                $and: [{ $gt: ["$qty", null] }, { $gt: ["$cap", null] }, { $gt: ["$qty", "$cap"] }],
              },
            },
          ],
        },
      },
      { $project: { _id: 0, id: "$id", zip: { $ifNull: ["$address.zip", null] } } },
    ]);
    const stats = await pipelineOf(fx.MvZipStats);
    const group = stats.find((s) => s.$group).$group;
    expect(group).toEqual({
      _id: { city: "$address.city" },
      zips: { $addToSet: { $ifNull: ["$address.zip", "$$REMOVE"] } },
    });
    expect(JSON.stringify(stats)).not.toContain("zip_code");
  });

  it("aggregates: COUNT(field) counts non-null values, in-list join condition", async () => {
    const pipeline = await pipelineOf(fx.MvCustomerOrders);
    expect(pipeline[0].$lookup.pipeline[0].$match.$expr.$and[1]).toEqual({
      $in: ["$status", ["paid", "shipped"]],
    });
    const group = pipeline.find((s) => s.$group).$group;
    expect(group).toEqual({
      _id: { city: "$profile.city" },
      orders: { $sum: { $cond: [{ $gt: ["$__joined_mv_orders.id", null] }, 1, 0] } },
      total: { $sum: "$__joined_mv_orders.amount" },
      customers: { $sum: 1 },
    });
    expect(pipeline.find((s) => s.$match && s.$match.customers)).toEqual({
      $match: { customers: { $gt: 0 } },
    });
  });
});

const notNull = (x: unknown) => ({ $gt: [x, null] });
const setSize = (f: string) => ({ $size: `$${f}` });
const nonNull = (x: unknown) => ({ $ifNull: [x, "$$REMOVE"] });

describe("[mongo] view pipeline — countDistinct + conditional aggregates (since 0.1.136)", () => {
  let fx: Record<string, any>;

  beforeAll(async () => {
    fx = await import("./fixtures/agg-distinct.as");
  });

  async function pipelineOf(type: unknown): Promise<any[]> {
    const view = createTestSpace().getView(type as never) as AtscriptDbView;
    const { host, createCollection, raw } = fakeHost({ exists: false });
    (raw._table as any).tableName = view.tableName;
    await ensureTableImpl(host, view);
    return (createCollection.mock.calls[0] as [string, { pipeline: any[] }])[1].pipeline;
  }

  const paid = { $eq: ["$status", "paid"] };

  it("wraps conditional sources in $cond and sizes countDistinct sets right after $group", async () => {
    const pipeline = await pipelineOf(fx.AdCityStats);
    const groupAt = pipeline.findIndex((s) => s.$group);
    expect(pipeline[groupAt].$group).toEqual({
      _id: { city: "$city" },
      orders: { $sum: 1 },
      paidOrders: { $sum: { $cond: [paid, 1, 0] } },
      paidWithAmount: { $sum: { $cond: [{ $and: [paid, notNull("$amount_cents")] }, 1, 0] } },
      paidTotal: { $sum: { $cond: [paid, "$amount_cents", null] } },
      paidAvg: { $avg: { $cond: [paid, "$amount_cents", null] } },
      paidMin: { $min: { $cond: [paid, "$amount_cents", null] } },
      buyers: { $addToSet: nonNull("$customerId") },
      paidBuyers: { $addToSet: nonNull({ $cond: [paid, "$customerId", null] }) },
      vipOrders: { $sum: { $cond: [{ $eq: ["$__joined_ad_customers.vip", true] }, 1, 0] } },
    });
    expect(pipeline[groupAt + 1]).toEqual({
      $addFields: { buyers: setSize("buyers"), paidBuyers: setSize("paidBuyers") },
    });
  });

  it("the HAVING $match runs after the set → size stage", async () => {
    const pipeline = await pipelineOf(fx.AdBusyCities);
    expect(pipeline.slice(-4).map((s) => Object.keys(s)[0])).toEqual([
      "$group",
      "$addFields",
      "$match",
      "$project",
    ]);
    expect(pipeline.at(-2)).toEqual({
      $match: { $and: [{ buyers: { $gt: 1 } }, { paidOrders: { $gt: 0 } }] },
    });
  });
});
