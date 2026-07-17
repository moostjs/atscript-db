import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import { buildDbValidator, buildValidationContext } from "../validator";
import type { DbValidationContext } from "../validator";

import { prepareFixtures, MockAdapter } from "./test-utils";

/**
 * IMPROVE.md #5: `buildDbValidator(type, "patch")` — the path db-client's
 * preflight uses — must apply the SAME path-aware partial logic as the
 * server's `bulkUpdate` validator: root partial, nav subtrees partial,
 * `@db.patch.strategy "merge"` blocks partial, everything else strict.
 */

let ProductTable: any;
let ProfileTable: any;

beforeAll(async () => {
  await prepareFixtures();
  const fixtures = await import("./fixtures/test-table.as");
  ProductTable = fixtures.ProductTable;
  ProfileTable = fixtures.ProfileTable;
});

function makeCtx(type: any): DbValidationContext {
  const { flatMap, navFields } = buildValidationContext(type);
  return { mode: "patch", flatMap, navFields };
}

describe("buildDbValidator patch mode (shared client/server partial)", () => {
  it("accepts a partial merge block (missing required sibling)", () => {
    // ProductTable.stats is @db.patch.strategy 'merge' with two required keys.
    const validator = buildDbValidator(ProductTable, "patch");
    expect(validator.validate({ id: 1, stats: { views: 5 } }, true, makeCtx(ProductTable))).toBe(
      true,
    );
  });

  it("rejects a partial non-merge block (missing required key)", () => {
    // ProfileTable.contact has no merge strategy → $set whole, email required.
    const validator = buildDbValidator(ProfileTable, "patch");
    expect(
      validator.validate({ id: 1, contact: { phone: "123" } }, true, makeCtx(ProfileTable)),
    ).toBe(false);
  });

  it("still validates present keys inside a merge block", () => {
    const validator = buildDbValidator(ProductTable, "patch");
    expect(
      validator.validate({ id: 1, stats: { views: "many" } }, true, makeCtx(ProductTable)),
    ).toBe(false);
  });

  it("matches the server's bulkUpdate validator on the same payloads", () => {
    const table = new AtscriptDbTable(ProductTable, new MockAdapter());
    const serverValidator = table.getValidator("bulkUpdate");
    const clientValidator = buildDbValidator(ProductTable, "patch");
    const ctx = makeCtx(ProductTable);

    const payloads = [
      { id: 1, stats: { views: 5 } }, // partial merge → both accept
      { id: 1, stats: { views: "many" } }, // wrong type in merge → both reject
      { id: 1, name: "renamed" }, // top-level partial → both accept
    ];
    for (const payload of payloads) {
      expect(clientValidator.validate(payload, true, ctx)).toBe(
        serverValidator.validate(payload, true, ctx),
      );
    }
  });
});
