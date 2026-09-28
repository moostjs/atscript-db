import type { TColumnDiff, TDbFieldMeta } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { syncColumnsImpl, dropColumnsImpl } from "../mongo-schema-sync";
import { createTestSpace, prepareFixtures } from "./test-utils";

const mongo = createTestSpace();

function pickField(table: any, path: string): TDbFieldMeta {
  const fd = table.fieldDescriptors.find((f: TDbFieldMeta) => f.path === path);
  if (!fd) throw new Error(`No field descriptor for path "${path}"`);
  return fd;
}

function makeDiff(added: TDbFieldMeta[]): TColumnDiff {
  return {
    added,
    removed: [],
    renamed: [],
    typeChanged: [],
    nullableChanged: [],
    defaultChanged: [],
    conflicts: [],
  };
}

beforeAll(prepareFixtures);

let table: any;
let adapter: MongoAdapter;
let mockCol: { updateMany: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
  table = mongo.getTable(ArraysCollection);
  adapter = mongo.getAdapter(ArraysCollection) as unknown as MongoAdapter;
  mockCol = { updateMany: vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }) };
  vi.spyOn(adapter, "collection", "get").mockReturnValue(mockCol as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[mongo] syncColumnsImpl — array-of-objects sub-fields", () => {
  // Bug A: optional default-less fields used to be backfilled with null,
  // which crashed on empty arrays (Mongo code 28).
  it("skips updateMany when only optional default-less fields are added", async () => {
    const optionalField = pickField(table, "withoutKey.attribute");
    expect(optionalField.optional).toBe(true);
    expect(optionalField.defaultValue).toBeUndefined();

    const result = await syncColumnsImpl(adapter as any, makeDiff([optionalField]));
    expect(result.added).toContain("withoutKey.attribute");
    expect(mockCol.updateMany).not.toHaveBeenCalled();
  });

  // Bug B: paths crossing an array-of-objects boundary need $[] so Mongo
  // walks every element instead of erroring on empty arrays.
  it("rewrites dotted path with $[] for array-element field add with default", async () => {
    const field = pickField(table, "withoutKey.attribute");
    const withDefault: TDbFieldMeta = {
      ...field,
      optional: false,
      defaultValue: { kind: "value", value: "n/a" },
    };

    await syncColumnsImpl(adapter as any, makeDiff([withDefault]));
    expect(mockCol.updateMany).toHaveBeenCalledOnce();
    const [filter, update, options] = mockCol.updateMany.mock.calls[0]!;
    expect(filter).toEqual({});
    // The innermost array is narrowed to elements missing the field (since 0.1.137)
    expect(update).toEqual({ $set: { "withoutKey.$[backfill].attribute": "n/a" } });
    expect(options).toEqual({ arrayFilters: [{ "backfill.attribute": { $exists: false } }] });
  });

  it("leaves non-array paths flat", async () => {
    const field = pickField(table, "primitive");
    const withDefault: TDbFieldMeta = {
      ...field,
      optional: false,
      defaultValue: { kind: "value", value: "[]" },
    };

    await syncColumnsImpl(adapter as any, makeDiff([withDefault]));
    const [, update] = mockCol.updateMany.mock.calls[0]!;
    expect(update).toEqual({ $set: { primitive: [] } });
  });
});

describe("[mongo] syncColumnsImpl — backfill fills only where the field is missing (since 0.1.137)", () => {
  // A snapshot can report a field as added although its documents already hold
  // it — e.g. a nested leaf whose `@db.column` no longer renames it on
  // documents (`zip_code` → `address.zip`). A stored value is never overwritten.
  it("filters a non-array path on $exists: false", async () => {
    const withDefault: TDbFieldMeta = {
      ...pickField(table, "primitive"),
      path: "address.zip",
      physicalName: "address.zip",
      designType: "string",
      optional: false,
      defaultValue: { kind: "value", value: "n/a" },
    };

    await syncColumnsImpl(adapter as any, makeDiff([withDefault]));
    const [filter, update] = mockCol.updateMany.mock.calls[0]!;
    expect(filter).toEqual({ "address.zip": { $exists: false } });
    expect(update).toEqual({ $set: { "address.zip": "n/a" } });
  });

  it("runs renames first, then one guarded backfill per defaulted field", async () => {
    const proto = pickField(table, "primitive");
    const a: TDbFieldMeta = {
      ...proto,
      path: "a",
      physicalName: "a",
      designType: "number",
      optional: false,
      defaultValue: { kind: "value", value: "1" },
    };
    const b: TDbFieldMeta = { ...a, path: "b", physicalName: "b" };
    const diff = { ...makeDiff([a, b]), renamed: [{ field: proto, oldName: "old_primitive" }] };

    const result = await syncColumnsImpl(adapter as any, diff);
    expect(result).toEqual({ added: ["a", "b"], renamed: ["primitive"] });
    expect(mockCol.updateMany.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      [{}, { $rename: { old_primitive: "primitive" } }],
      [{ a: { $exists: false } }, { $set: { a: 1 } }],
      [{ b: { $exists: false } }, { $set: { b: 1 } }],
    ]);
  });
});

describe("[mongo] syncColumnsImpl — @db.default literal coercion", () => {
  // .as syntax always stores @db.default as a string (TDbDefaultValue.value).
  // The runtime insert path coerces to designType before writing; the sync
  // backfill path used to skip coercion, so `@db.default '0'` on a number
  // column landed "0" (string) in every doc — breaking equality and
  // validation. resolveSyncDefault now mirrors the insert-path coercion.

  it("coerces '0' to integer 0 for number designType", async () => {
    const proto = pickField(table, "primitive");
    const numField: TDbFieldMeta = {
      ...proto,
      path: "counter",
      physicalName: "counter",
      designType: "number",
      optional: false,
      defaultValue: { kind: "value", value: "0" },
    };

    await syncColumnsImpl(adapter as any, makeDiff([numField]));
    const [, update] = mockCol.updateMany.mock.calls[0]!;
    expect(update).toEqual({ $set: { counter: 0 } });
    expect(typeof (update as any).$set.counter).toBe("number");
  });

  it("coerces 'true' to boolean true for boolean designType", async () => {
    const proto = pickField(table, "primitive");
    const boolField: TDbFieldMeta = {
      ...proto,
      path: "enabled",
      physicalName: "enabled",
      designType: "boolean",
      optional: false,
      defaultValue: { kind: "value", value: "true" },
    };

    await syncColumnsImpl(adapter as any, makeDiff([boolField]));
    const [, update] = mockCol.updateMany.mock.calls[0]!;
    expect(update).toEqual({ $set: { enabled: true } });
    expect(typeof (update as any).$set.enabled).toBe("boolean");
  });

  // Leading "0" would parse to number 0 if JSON.parsed; string design type
  // must preserve the literal text verbatim.
  it("passes string defaults through as-is for string designType", async () => {
    const proto = pickField(table, "primitive");
    const strField: TDbFieldMeta = {
      ...proto,
      path: "label",
      physicalName: "label",
      designType: "string",
      optional: false,
      defaultValue: { kind: "value", value: "0" },
    };

    await syncColumnsImpl(adapter as any, makeDiff([strField]));
    const [, update] = mockCol.updateMany.mock.calls[0]!;
    expect(update).toEqual({ $set: { label: "0" } });
    expect(typeof (update as any).$set.label).toBe("string");
  });

  // Stacks Bug B (array-safe path rewrite) with the coercion fix on a real
  // number field inside an array of objects — the reported portal scenario
  // shape, mapped onto the existing fixture.
  it("coerces inside array-of-objects (portal case)", async () => {
    const field = pickField(table, "uniqueObjects.score");
    expect(field.designType).toBe("number");
    const withDefault: TDbFieldMeta = {
      ...field,
      optional: false,
      defaultValue: { kind: "value", value: "0" },
    };

    await syncColumnsImpl(adapter as any, makeDiff([withDefault]));
    const [, update] = mockCol.updateMany.mock.calls[0]!;
    expect(update).toEqual({ $set: { "uniqueObjects.$[backfill].score": 0 } });
  });
});

describe("[mongo] dropColumnsImpl — array-of-objects sub-fields", () => {
  it("rewrites $unset path with $[] when dropping a field inside an array", async () => {
    await dropColumnsImpl(adapter as any, ["withoutKey.attribute"]);
    const [, update] = mockCol.updateMany.mock.calls[0]!;
    expect(update).toEqual({ $unset: { "withoutKey.$[].attribute": "" } });
  });
});

describe("[mongo] dropColumnsImpl — parent/child overlap collapse", () => {
  // Bug: an embedded object is tracked in flatMap as BOTH the container path
  // and its leaves, so removing the whole field puts the parent and every
  // descendant into the drop set. Emitting one $unset key per column yields
  // { groupContact: '', 'groupContact.email': '', ... }, which Mongo rejects
  // ("would create a conflict at 'groupContact'", code 40). The fix keeps only
  // the shallowest dropped paths — the parent's $unset removes the subtree.
  it("collapses a dropped embedded object to a single parent $unset (no descendant keys)", async () => {
    await dropColumnsImpl(adapter as any, [
      "groupContact",
      "groupContact.name",
      "groupContact.title",
      "groupContact.email",
      "groupContact.phone",
    ]);
    const [, update] = mockCol.updateMany.mock.calls[0]!;
    expect(update).toEqual({ $unset: { groupContact: "" } });
  });

  // When the whole array-of-objects is dropped (parent + its leaf together),
  // collapsing to the array parent also avoids a latent conflict: unsetting
  // both `withoutKey` and `withoutKey.$[].attribute` would itself be code 40.
  it("collapses a dropped array-of-objects to the array parent (no $[] leaf key)", async () => {
    await dropColumnsImpl(adapter as any, ["withoutKey", "withoutKey.attribute"]);
    const [, update] = mockCol.updateMany.mock.calls[0]!;
    expect(update).toEqual({ $unset: { withoutKey: "" } });
  });

  // A leaf drop whose parent array stays in the schema must be untouched by the
  // collapse (the parent isn't in the drop set) so $[] handling still applies.
  it("leaves an array-leaf drop alone when the parent array is not dropped", async () => {
    await dropColumnsImpl(adapter as any, ["withoutKey.attribute"]);
    const [, update] = mockCol.updateMany.mock.calls[0]!;
    expect(update).toEqual({ $unset: { "withoutKey.$[].attribute": "" } });
  });
});
