import { describe, it, expect, beforeAll } from "vite-plus/test";
import { defineAnnotatedType as $ } from "@atscript/typescript/utils";

import { DbSpace } from "../index";
import { computeTableSnapshot } from "../schema/schema-hash";
import { resolveViewSource } from "../table/view-source";
import { DocumentFieldMapper } from "../strategies/field-mapping";

import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

// `@db.column.derived` (since 0.1.141) on both adapter families: metadata,
// the runtime mirror of the compile-time rules, write stripping, `$inc`
// rejection, document-adapter query translation and read filling / pruning,
// views over a derived column.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/derived.as");
});

const sqlSpace = () => new DbSpace(() => new MockAdapter());
const docSpace = () => new DbSpace(() => new NestedMockAdapter());
const lastCall = (adapter: MockAdapter, method: string) =>
  adapter.calls.findLast((c) => c.method === method)!.args;

describe("TableMetadata — derived fields", () => {
  it("records what each derived field reads (relational layout of the source)", () => {
    const meta = sqlSpace().getTable(fx.DvOrder).getMetadata();
    expect([...meta.derivedFields.keys()]).toEqual([
      "customerId",
      "vip",
      "amount",
      "region",
      "tier",
    ]);
    expect(meta.derivedFields.get("customerId")).toEqual({
      sourcePath: "payload.customer.id",
      sourceColumn: "payload",
      jsonPath: ["customer", "id"],
      type: "string",
    });
    expect(meta.derivedFields.get("vip")).toMatchObject({
      jsonPath: ["customer", "vip"],
      type: "boolean",
    });
    expect(meta.derivedFields.get("amount")).toMatchObject({ jsonPath: ["total"], type: "number" });
    // The source JSON column carries its @db.column rename
    expect(meta.derivedFields.get("region")).toEqual({
      sourcePath: "meta.region",
      sourceColumn: "meta_json",
      jsonPath: ["region"],
      type: "string",
    });
  });

  it("relational: a derived field is a plain column with its own physical name", () => {
    const meta = sqlSpace().getTable(fx.DvOrder).getMetadata();
    const fd = meta.descriptorByPath.get("region")!;
    expect(fd.physicalName).toBe("region_code");
    expect(fd.storage).toBe("column");
    expect(fd.derived).toBe(meta.derivedFields.get("region"));
    expect(meta.descriptorByPath.get("customerId")!.physicalName).toBe("customerId");
    expect(meta.descriptorByPath.get("tier")!.collate).toBe("nocase");
    // Indexes address the column
    const index = [...meta.indexes.values()].find((i) => i.name === "customerId")!;
    expect(index.fields[0]!.name).toBe("customerId");
    expect([...meta.indexes.values()].find((i) => i.type === "unique")!.fields[0]!.name).toBe(
      "region_code",
    );
    expect(meta.allPhysicalFields).toContain("customerId");
    expect(meta.allPhysicalFields).toContain("region_code");
  });

  it("document adapters: the physical path is the source's document path; nothing is stored", () => {
    const meta = docSpace().getTable(fx.DvOrder).getMetadata();
    expect(meta.physicalPath("customerId")).toBe("payload.customer.id");
    expect(meta.physicalPath("region")).toBe("meta_json.region");
    expect(meta.descriptorByPath.get("customerId")!.physicalName).toBe("payload.customer.id");
    const index = [...meta.indexes.values()].find((i) => i.name === "customerId")!;
    expect(index.fields[0]).toMatchObject({
      name: "payload.customer.id",
      optional: false,
      designType: "string",
    });
    expect([...meta.indexes.values()].find((i) => i.type === "unique")!.fields[0]!.name).toBe(
      "meta_json.region",
    );
    // Not a stored field — an exclusion `$select` must not invert to it
    expect(meta.allPhysicalFields).not.toContain("customerId");
    expect(meta.allPhysicalFields).toContain("payload.customer.id");
  });

  it("the snapshot carries the extraction for derived fields only", () => {
    const snapshot = computeTableSnapshot(sqlSpace().getTable(fx.DvOrder));
    const byName = new Map(snapshot.fields.map((f) => [f.physicalName, f]));
    expect(byName.get("customerId")!.derived).toEqual({
      sourceColumn: "payload",
      jsonPath: ["customer", "id"],
      type: "string",
    });
    expect(byName.get("region_code")!.derived).toMatchObject({ sourceColumn: "meta_json" });
    expect("derived" in byName.get("payload")!).toBe(false);
    expect("derived" in byName.get("status")!).toBe(false);
  });
});

describe("TableMetadata — runtime mirror of the compile-time rules", () => {
  /** A hand-built table type (as the compiler emits one). */
  function table(name: string, define: (h: ReturnType<typeof $>) => unknown): any {
    class T {
      static __is_atscript_annotated_type = true;
      static type = {};
      static metadata = new Map();
      static id = name;
    }
    const handle = $("object", T);
    define(handle);
    handle.annotate("db.table", name.toLowerCase());
    return T;
  }
  const str = () => $().designType("string").tags("string").$type;
  const jsonPayload = () =>
    $("object")
      .prop("customer", $("object").prop("id", str()).$type)
      .prop("tags", $("array").of(str()).$type)
      .annotate("db.json", true).$type;

  const failsWith = (type: any, message: string) => {
    expect(() => sqlSpace().getTable(type).getMetadata()).toThrow(message);
    expect(() => docSpace().getTable(type).getMetadata()).toThrow(message);
  };

  it("rejects a derived field that references another table", () => {
    const Other = table("RmOther", (h) => h.prop("payload", jsonPayload()));
    const T = table("RmSelf", (h) =>
      h
        .prop("id", $().designType("number").tags("number").annotate("meta.id", true).$type)
        .prop("payload", jsonPayload())
        .prop(
          "customerId",
          $().refTo(Other, ["payload", "customer", "id"]).annotate("db.column.derived", true).$type,
        ),
    );
    failsWith(
      T,
      '@db.column.derived on "customerId": must reference the enclosing table "RmSelf", not "RmOther"',
    );
  });

  it("rejects a path through an array, outside a JSON field, or with an incompatible annotation", () => {
    let viaArray: any;
    viaArray = table("RmArr", (h) =>
      h.prop("payload", jsonPayload()).prop(
        "tag",
        $()
          .refTo(() => viaArray, ["payload", "tags"])
          .annotate("db.column.derived", true).$type,
      ),
    );
    failsWith(viaArray, 'crosses the array "payload.tags"');

    let notJson: any;
    notJson = table("RmFlat", (h) =>
      h.prop("address", $("object").prop("city", str()).$type).prop(
        "city",
        $()
          .refTo(() => notJson, ["address", "city"])
          .annotate("db.column.derived", true).$type,
      ),
    );
    failsWith(notJson, 'path "address.city" does not read inside a @db.json field');

    let withDefault: any;
    withDefault = table("RmDef", (h) =>
      h.prop("payload", jsonPayload()).prop(
        "customerId",
        $()
          .refTo(() => withDefault, ["payload", "customer", "id"])
          .annotate("db.column.derived", true)
          .annotate("db.default", "x").$type,
      ),
    );
    failsWith(withDefault, "cannot coexist with @db.default");
  });
});

describe("writes — derived fields are stripped, never SET", () => {
  const row = {
    id: 1,
    status: "open",
    payload: { customer: { id: "c1", vip: true }, total: 10 },
    customerId: "zzz",
    vip: false,
    amount: 99,
  };

  it.each([
    ["relational", sqlSpace],
    ["document", docSpace],
  ])("%s: insert / replace / patch / updateMany drop the derived keys", async (_family, make) => {
    const space = make();
    const table = space.getTable(fx.DvOrder);
    const adapter = space.getAdapter(fx.DvOrder) as MockAdapter;

    await table.insertOne(row);
    const inserted = lastCall(adapter, "insertMany")[0][0];
    expect(Object.keys(inserted).toSorted()).toEqual(["id", "payload", "status"]);

    await table.replaceOne(row);
    const replaced = lastCall(adapter, "replaceOne")[1];
    expect(Object.keys(replaced).toSorted()).toEqual(["id", "payload", "status"]);

    await table.updateOne({ id: 1, status: "paid", customerId: "zzz", amount: 5 });
    const [, patched, ops] = lastCall(adapter, "updateOne");
    expect(patched).toEqual({ status: "paid" });
    expect(ops).toBeUndefined();

    await table.updateMany({ status: "open" }, { status: "closed", vip: true });
    expect(lastCall(adapter, "updateMany")[1]).toEqual({ status: "closed" });
  });

  it("a payload without the (required) derived fields is valid", async () => {
    const table = sqlSpace().getTable(fx.DvOrder);
    await expect(
      table.insertOne({
        id: 2,
        status: "open",
        payload: { customer: { id: "c2", vip: false }, total: 1 },
      }),
    ).resolves.toBeDefined();
  });

  it("$inc / $dec / $mul on a derived field are rejected before anything is written", async () => {
    const space = sqlSpace();
    const table = space.getTable(fx.DvOrder);
    const adapter = space.getAdapter(fx.DvOrder) as MockAdapter;
    for (const op of [{ $inc: 1 }, { $dec: 1 }, { $mul: 2 }]) {
      let error: unknown;
      try {
        await table.updateOne({ id: 1, amount: op } as never);
      } catch (e) {
        error = e;
      }
      expect((error as Error).message).toContain(
        "Field operations ($inc/$dec/$mul) are not allowed on a @db.column.derived field",
      );
    }
    expect(adapter.calls.some((c) => c.method === "updateOne")).toBe(false);
  });
});

describe("document adapters — queries address the source path", () => {
  it("filters, sorts, inclusion / exclusion projections and grouped queries", async () => {
    const space = docSpace();
    const table = space.getTable(fx.DvOrder);
    const adapter = space.getAdapter(fx.DvOrder) as MockAdapter;

    await table.findMany({
      filter: { customerId: "c1", vip: true, $or: [{ region: "eu" }, { status: "x" }] },
      controls: { $sort: { customerId: -1, status: 1 }, $select: ["customerId", "status"] },
    } as never);
    const [query] = lastCall(adapter, "findMany");
    expect(query.filter).toEqual({
      "payload.customer.id": "c1",
      "payload.customer.vip": true,
      $or: [{ "meta_json.region": "eu" }, { status: "x" }],
    });
    expect(query.controls.$sort).toEqual({ "payload.customer.id": -1, status: 1, id: 1 });
    expect(query.controls.$select.asProjection).toEqual({ "payload.customer.id": 1, status: 1 });

    // Exclusion: a derived key is not a stored path; an excluded source of a
    // wanted derived field is fetched (and pruned after the read)
    await table.findMany({
      filter: {},
      controls: { $select: { customerId: 0, status: 0 } },
    } as never);
    expect(lastCall(adapter, "findMany")[0].controls.$select.asProjection).toEqual({ status: 0 });
    await table.findMany({ filter: {}, controls: { $select: { payload: 0 } } } as never);
    expect(lastCall(adapter, "findMany")[0].controls.$select.asProjection).toBeUndefined();

    adapter.aggregateResult = [];
    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["customerId"],
        $select: ["customerId", { $fn: "sum", $field: "amount" }],
      },
    } as never);
    const [agg] = lastCall(adapter, "aggregate");
    expect(agg.controls.$groupBy).toEqual(["payload.customer.id"]);
    expect(agg.controls.$select.asArray).toEqual(["payload.customer.id"]);
    expect(agg.controls.$select.aggregates).toEqual([
      { $fn: "sum", $field: "payload.total", $as: "sum_amount" },
    ]);
  });

  it("reads fill the derived fields from the source and prune what was not selected", async () => {
    const space = docSpace();
    const table = space.getTable(fx.DvOrder);
    const adapter = space.getAdapter(fx.DvOrder) as MockAdapter;
    const stored = () => [
      {
        id: 1,
        status: "open",
        payload: { customer: { id: "c1", vip: true }, total: 10 },
        meta_json: { region: "eu" },
      },
      { id: 2, status: "paid", payload: { customer: { id: 5 }, total: 3 } },
    ];

    // No projection: every derived field, sources kept; missing leaf → null,
    // off-type value as stored (no type guard on document adapters)
    adapter.store.set("dv_orders", stored());
    expect(await table.findMany({ filter: {}, controls: {} })).toEqual([
      {
        id: 1,
        status: "open",
        payload: { customer: { id: "c1", vip: true }, total: 10 },
        meta: { region: "eu" },
        customerId: "c1",
        vip: true,
        amount: 10,
        region: "eu",
        tier: null,
      },
      {
        id: 2,
        status: "paid",
        payload: { customer: { id: 5 }, total: 3 },
        customerId: 5,
        vip: null,
        amount: 3,
        region: null,
        tier: null,
      },
    ]);

    // Inclusion: the derived value only — its source does not leak. (The mock
    // ignores projections, so the rows are what a real adapter returns for
    // `{ "payload.customer.id": 1, "meta_json.region": 1 }`.)
    adapter.store.set("dv_orders", [
      { id: 1, payload: { customer: { id: "c1" } }, meta_json: { region: "eu" } },
      { id: 2, payload: { customer: { id: 5 } } },
    ]);
    const rows = await table.findMany({
      filter: {},
      controls: { $select: ["customerId", "region"] },
    } as never);
    expect(rows[0]).not.toHaveProperty("payload");
    expect(rows[0]).not.toHaveProperty("meta");
    expect(rows[0]).toMatchObject({ customerId: "c1", region: "eu" });
    expect(rows[1]).toMatchObject({ customerId: 5, region: null });

    // A sibling under the same JSON root was selected: the root stays, the source leaf goes
    adapter.store.set("dv_orders", [{ id: 1, payload: { customer: { id: "c1" }, total: 10 } }]);
    const partial = await table.findMany({
      filter: {},
      controls: { $select: ["customerId", "payload.total"] },
    } as never);
    expect(partial[0]).toMatchObject({ customerId: "c1", payload: { total: 10 } });
    expect((partial[0] as any).payload.customer).toBeUndefined();

    // The source itself was selected: nothing to prune
    adapter.store.set("dv_orders", stored());
    const withSource = await table.findOne({
      filter: {},
      controls: { $select: { customerId: 1, payload: 1 } },
    } as never);
    expect(withSource).toMatchObject({ customerId: "c1", payload: { customer: { id: "c1" } } });

    // Exclusion of the source: the derived value survives, the source goes
    adapter.store.set("dv_orders", stored());
    const excluded = await table.findOne({
      filter: {},
      controls: { $select: { payload: 0 } },
    } as never);
    expect(excluded).toMatchObject({ customerId: "c1", vip: true, amount: 10 });
    expect(excluded).not.toHaveProperty("payload");

    // Exclusion of a derived field: not filled
    adapter.store.set("dv_orders", stored());
    const noDerived = await table.findOne({
      filter: {},
      controls: { $select: { customerId: 0 } },
    } as never);
    expect(noDerived).not.toHaveProperty("customerId");
    expect(noDerived).toMatchObject({ vip: true, payload: { customer: { id: "c1" } } });
  });

  it("grouped rows come back under the derived name", async () => {
    const space = docSpace();
    const table = space.getTable(fx.DvOrder);
    const adapter = space.getAdapter(fx.DvOrder) as MockAdapter;
    adapter.aggregateResult = [
      { payload: { customer: { id: "c1" } }, total: 15 },
      { payload: { customer: { id: null } }, total: 3 },
    ];
    const rows = await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["customerId"],
        $select: ["customerId", { $fn: "sum", $field: "amount", $as: "total" }],
      },
    } as never);
    expect(rows).toEqual([
      { customerId: "c1", total: 15 },
      { customerId: null, total: 3 },
    ]);
  });

  it("a single-string $groupBy fills the grouped derived field too (regression: the string form used to be skipped)", () => {
    // `aggregate()` takes an array, but the raw controls a document mapper
    // receives (`TReadControls`) may carry the string form the path guard
    // accepts — the fill used to bind the string branch under the array one.
    const space = docSpace();
    const meta = space.getTable(fx.DvOrder).getMetadata();
    const mapper = new DocumentFieldMapper();
    const controls = {
      $groupBy: "customerId",
      $select: ["customerId", { $fn: "sum", $field: "amount", $as: "total" }],
    };
    expect(
      mapper.reconstructFromRead(
        { payload: { customer: { id: "c1" } }, total: 15 },
        meta,
        controls,
      ),
    ).toEqual({ customerId: "c1", total: 15 });
    expect(
      mapper.reconstructRows(
        [
          { payload: { customer: { id: "c1" } }, total: 15 },
          { payload: { customer: { id: null } }, total: 3 },
        ],
        meta,
        controls,
      ),
    ).toEqual([
      { customerId: "c1", total: 15 },
      { customerId: null, total: 3 },
    ]);
  });

  it("relational rows are returned as the adapter read them", async () => {
    const space = sqlSpace();
    const table = space.getTable(fx.DvOrder);
    const adapter = space.getAdapter(fx.DvOrder) as MockAdapter;
    adapter.store.set("dv_orders", [
      {
        id: 1,
        status: "open",
        payload: '{"customer":{"id":"c1"}}',
        customerId: "c1",
        vip: 1,
        amount: 10,
        region_code: null,
        tier: null,
      },
    ]);
    expect(await table.findMany({ filter: {}, controls: {} })).toEqual([
      {
        id: 1,
        status: "open",
        payload: { customer: { id: "c1" } },
        customerId: "c1",
        vip: true,
        amount: 10,
        region: null,
        tier: null,
      },
    ]);
  });
});

describe("views over a derived column", () => {
  it("relational: reads the derived column; document adapters: the source path (nullable)", () => {
    const sql = sqlSpace().getView(fx.DvOrderView).getViewColumnMappings();
    expect(sql.find((m) => m.viewPath === "customer")).toEqual({
      viewColumn: "customer",
      viewPath: "customer",
      sourceTable: "dv_orders",
      sourceColumn: "customerId",
      nullable: true,
    });
    expect(sql.find((m) => m.viewPath === "vip")!.json).toBeUndefined();

    const doc = docSpace().getView(fx.DvOrderView).getViewColumnMappings();
    expect(doc.find((m) => m.viewPath === "customer")).toMatchObject({
      sourceColumn: "payload.customer.id",
      nullable: true,
    });
    expect(doc.find((m) => m.viewPath === "vip")).toMatchObject({
      sourceColumn: "payload.customer.vip",
      nullable: true,
    });
  });

  it("resolveViewSource resolves a derived path on both layouts", () => {
    expect(resolveViewSource(fx.DvOrder, "region", false)).toEqual({
      column: "region_code",
      designType: "string",
      optional: true,
    });
    expect(resolveViewSource(fx.DvOrder, "region", true)).toEqual({
      column: "meta_json.region",
      designType: "string",
      optional: true,
    });
  });
});

describe("validator", () => {
  it("the $inc rejection is a ValidatorError keyed by the field", async () => {
    const table = sqlSpace().getTable(fx.DvOrder);
    let error: unknown;
    try {
      await table.updateOne({ id: 1, amount: { $inc: 1 } } as never);
    } catch (e) {
      error = e;
    }
    expect((error as Error).constructor.name).toBe("ValidatorError");
    expect((error as Error).message).toContain(
      "amount: Field operations ($inc/$dec/$mul) are not allowed",
    );
  });
});
