import { formatValidatorMessage } from "@atscript/typescript/utils";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { buildDbValidator, buildValidationContext, DB_VALIDATOR_MESSAGES } from "../validator";
import type { ValidatorMode } from "../validator";

import { prepareFixtures } from "./test-utils";

/**
 * Every error the db validator plugin reports carries a stable code and the
 * params its message names, so a translator can render it in another
 * language; the English message is the code's template filled with them.
 */

let ApOrder: any;
let Post: any;
let Task: any;
let DvOrder: any;

beforeAll(async () => {
  await prepareFixtures();
  ApOrder = (await import("./fixtures/array-patch-items.as")).ApOrder;
  Post = (await import("./fixtures/test-relations.as")).Post;
  Task = (await import("./fixtures/rel-task.as")).Task;
  DvOrder = (await import("./fixtures/derived.as")).DvOrder;
});

function firstError(type: any, mode: ValidatorMode, payload: Record<string, unknown>) {
  const { flatMap, navFields } = buildValidationContext(type);
  const validator = buildDbValidator(type, mode);
  expect(validator.validate(payload, true, { mode, flatMap, navFields })).toBe(false);
  return validator.errors[0]!;
}

const item = { sku: "a", qty: 1 };

describe("db validator plugin — coded errors", () => {
  it.each([
    [
      "GEO_POINT_SHAPE",
      () => firstError(ApOrder, "insert", { id: 1, title: "t", items: [{ ...item, loc: [1] }] }),
      {},
      "Expected a [lng, lat] tuple of two finite numbers (GeoJSON order)",
    ],
    [
      "GEO_LONGITUDE_RANGE",
      () =>
        firstError(ApOrder, "insert", { id: 1, title: "t", items: [{ ...item, loc: [200, 0] }] }),
      { value: 200 },
      "Longitude 200 out of range [-180, 180] (geo points are [lng, lat])",
    ],
    [
      "GEO_LATITUDE_RANGE",
      () =>
        firstError(ApOrder, "insert", { id: 1, title: "t", items: [{ ...item, loc: [0, 99] }] }),
      { value: 99 },
      "Latitude 99 out of range [-90, 90] (geo points are [lng, lat])",
    ],
    [
      "FIELD_OP_ON_DERIVED",
      () => firstError(DvOrder, "patch", { id: 1, amount: { $inc: 1 } }),
      {},
      "Field operations ($inc/$dec/$mul) are not allowed on a @db.column.derived field — it is computed from its @db.json source; patch the source leaf instead",
    ],
    [
      "FIELD_OP_CONTEXT",
      () => firstError(ApOrder, "patch", { id: 1, items: [{ ...item, qty: { $inc: 1 } }] }),
      {},
      'Field operations ($inc/$dec/$mul) are not supported inside @db.json fields, array items, or nested objects without @db.patch.strategy "merge"',
    ],
    [
      "FIELD_OP_NOT_NUMERIC",
      () => firstError(ApOrder, "patch", { id: 1, title: { $inc: 1 } }),
      {},
      "Field operations ($inc/$dec/$mul) can only be applied to numeric fields",
    ],
    [
      "NAV_NULL",
      () => firstError(Post, "insert", { title: "t", authorId: 1, author: null }),
      { field: "author" },
      "Cannot process null navigation property 'author'",
    ],
    [
      "NAV_PATCH_PLAIN_VALUE",
      () => firstError(Post, "patch", { id: 1, comments: [] }),
      { relation: "1:N", field: "comments" },
      "Cannot patch 1:N relation 'comments' with a plain value — use patch operators ({ $insert, $remove, $replace, $update, $upsert })",
    ],
    [
      "PATCH_UNKNOWN_OPERATOR",
      () => firstError(ApOrder, "patch", { id: 1, items: { $insert: [], $push: [], $pop: 1 } }),
      { operators: ["$push", "$pop"] },
      "Unknown patch operator(s): $push, $pop. Allowed: $replace, $insert, $upsert, $update, $remove",
    ],
    [
      "PATCH_OPERAND_NOT_ARRAY",
      () => firstError(ApOrder, "patch", { id: 1, items: { $update: item } }),
      { op: "$update" },
      "$update must be an array",
    ],
    [
      "PATCH_ITEM_NOT_OBJECT",
      () => firstError(ApOrder, "patch", { id: 1, items: { $remove: [item, 5] } }),
      { op: "$remove", index: 1 },
      "$remove[1]: expected object",
    ],
    [
      "PATCH_KEY_REQUIRED",
      () => firstError(ApOrder, "patch", { id: 1, items: { $update: [{ qty: 2 }] } }),
      { op: "$update", index: 0, field: "sku" },
      "$update[0]: key field 'sku' is required",
    ],
    [
      "PATCH_FIELD_REQUIRED",
      () => firstError(ApOrder, "patch", { id: 1, items: { $update: [{ sku: "a" }] } }),
      { op: "$update", index: 0, field: "qty" },
      "$update[0]: field 'qty' is required (replace strategy)",
    ],
  ] as const)("%s", (code, run, params, message) => {
    const error = run();
    expect(error.code).toBe(code);
    expect(error.params).toEqual(params);
    expect(error.message).toBe(message);
    expect(error.custom).toBeUndefined();
    expect(formatValidatorMessage(DB_VALIDATOR_MESSAGES[code], params)).toBe(message);
  });

  it("FIELD_OP_NOT_FINITE carries the operand as text (JSON-safe)", async () => {
    const { FvItem } = await import("./fixtures/filter-values.as");
    const error = firstError(FvItem, "patch", { id: 1, n: { $inc: Number.NaN } });
    expect(error).toMatchObject({
      code: "FIELD_OP_NOT_FINITE",
      params: { operand: "NaN" },
      message: "Field operation operand must be a finite number, got NaN",
    });
  });

  it("NAV_PATCH_NOT_ARRAY names the relation", async () => {
    const { VcParent } = await import("./fixtures/validator-codes.as");
    const error = firstError(VcParent, "patch", { id: 1, profile: { $insert: [] } });
    expect(error).toMatchObject({
      code: "NAV_PATCH_NOT_ARRAY",
      params: { field: "profile" },
      message: "Cannot use patch operators on non-array relation 'profile'",
    });
  });

  it("VIA relations report the M:N kind", () => {
    const error = firstError(Task, "patch", { id: 1, tags: [] });
    expect(error).toMatchObject({
      code: "NAV_PATCH_PLAIN_VALUE",
      params: { relation: "M:N", field: "tags" },
    });
  });

  it("every code has an English template", () => {
    for (const [code, template] of Object.entries(DB_VALIDATOR_MESSAGES)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(typeof template).toBe("string");
    }
    expect(Object.isFrozen(DB_VALIDATOR_MESSAGES)).toBe(true);
  });
});
