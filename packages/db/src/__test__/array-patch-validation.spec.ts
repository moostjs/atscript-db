import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import { buildDbValidator, buildValidationContext } from "../validator";
import type { DbValidationContext } from "../validator";

import { prepareFixtures, MockAdapter } from "./test-utils";

/**
 * FW-27b (db side): items of an embedded-array `$update` / `$remove` are
 * validated with the same optional/null semantics as a plain array set, and
 * their errors point at the item prop (`items.$update[0].qty`), not at the
 * array field.
 */

let ApOrder: any;

beforeAll(async () => {
  await prepareFixtures();
  ApOrder = (await import("./fixtures/array-patch-items.as")).ApOrder;
});

function patchCtx(): DbValidationContext {
  const { flatMap, navFields } = buildValidationContext(ApOrder);
  return { mode: "patch", flatMap, navFields };
}

function check(payload: Record<string, unknown>) {
  const validator = buildDbValidator(ApOrder, "patch");
  const ok = validator.validate(payload, true, patchCtx());
  return { ok, errors: validator.errors };
}

const item = { sku: "a", qty: 1 };

describe("embedded array $update / $remove item validation", () => {
  it("accepts null on an optional item field in $update", () => {
    expect(check({ id: 1, items: { $update: [{ ...item, note: null }] } }).ok).toBe(true);
  });

  it("accepts null on an optional item field in a merge-strategy $update", () => {
    expect(check({ id: 1, mergedItems: { $update: [{ sku: "a", note: null }] } }).ok).toBe(true);
  });

  it("matches the plain array set for null on optional item fields (incl. @meta.required)", () => {
    for (const field of ["note", "label"]) {
      const patchOp = check({ id: 1, items: { $update: [{ ...item, [field]: null }] } }).ok;
      const plainSet = check({ id: 1, items: [{ ...item, [field]: null }] }).ok;
      expect(patchOp).toBe(plainSet);
    }
  });

  it("still rejects null on a non-optional item field, at the item prop path", () => {
    const { ok, errors } = check({ id: 1, items: { $update: [item, { ...item, qty: null }] } });
    expect(ok).toBe(false);
    expect(errors).toEqual([expect.objectContaining({ path: "items.$update[1].qty" })]);
  });

  it("reports a wrong item prop type at the item prop path", () => {
    const { ok, errors } = check({
      id: 1,
      mergedItems: { $update: [{ sku: "a", note: 5 }] },
    });
    expect(ok).toBe(false);
    expect(errors).toEqual([expect.objectContaining({ path: "mergedItems.$update[0].note" })]);
  });

  it("applies db checks (geo range) to item props like the plain array set", () => {
    const bad = { ...item, loc: [500, 0] };
    expect(check({ id: 1, items: [bad] }).ok).toBe(false);
    const { ok, errors } = check({ id: 1, items: { $update: [bad] } });
    expect(ok).toBe(false);
    expect(errors).toEqual([expect.objectContaining({ path: "items.$update[0].loc" })]);
  });

  it("rejects field ops on array item props (arrays are written whole)", () => {
    const withOp = { ...item, qty: { $inc: 1 } };
    for (const items of [{ $update: [withOp] }, { $insert: [withOp] }, [withOp]]) {
      const { ok, errors } = check({ id: 1, items });
      expect(ok).toBe(false);
      expect(errors[0]?.message).toMatch(/Field operations/);
    }
  });

  it("keeps the existing structural checks", () => {
    expect(check({ id: 1, items: { $update: [{ qty: 1 }] } }).errors[0]?.message).toMatch(
      /key field 'sku' is required/,
    );
    expect(check({ id: 1, items: { $update: [{ sku: "a" }] } }).errors[0]?.message).toMatch(
      /field 'qty' is required \(replace strategy\)/,
    );
    expect(check({ id: 1, items: { $update: [null] } }).errors[0]?.message).toMatch(
      /expected object/,
    );
  });

  it("$remove items are validated element-wise, with item paths", () => {
    // Array-level constraints (@expect.minLength 2) do not apply to the payload.
    expect(check({ id: 1, tags: { $remove: ["x"] } }).ok).toBe(true);
    const { ok, errors } = check({ id: 1, tags: { $remove: ["x", 5] } });
    expect(ok).toBe(false);
    expect(errors).toEqual([expect.objectContaining({ path: "tags.$remove[1]" })]);
    expect(check({ id: 1, items: { $remove: [{ sku: "a" }] } }).ok).toBe(true);
  });

  it("$insert / $upsert items keep full-array validation", () => {
    expect(check({ id: 1, items: { $insert: [{ ...item, note: null }] } }).ok).toBe(true);
    expect(check({ id: 1, items: { $upsert: [{ ...item, note: null }] } }).ok).toBe(true);
    expect(check({ id: 1, items: { $insert: [{ sku: "a" }] } }).ok).toBe(false);
    const { ok, errors } = check({ id: 1, items: { $upsert: [{ ...item, qty: null }] } });
    expect(ok).toBe(false);
    expect(errors).toEqual([expect.objectContaining({ path: "items.0.qty" })]);
  });

  it("the server's bulkUpdate validator agrees with buildDbValidator", () => {
    const table = new AtscriptDbTable(ApOrder, new MockAdapter());
    const server = table.getValidator("bulkUpdate");
    const client = buildDbValidator(ApOrder, "patch");
    const payloads = [
      { id: 1, items: { $update: [{ ...item, note: null }] } },
      { id: 1, items: { $update: [{ ...item, qty: null }] } },
      { id: 1, items: { $update: [{ ...item, qty: { $inc: 1 } }] } },
    ];
    for (const payload of payloads) {
      expect(client.validate(payload, true, patchCtx())).toBe(
        server.validate(payload, true, patchCtx()),
      );
    }
  });
});
