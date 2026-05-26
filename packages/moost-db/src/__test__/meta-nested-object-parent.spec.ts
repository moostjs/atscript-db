import { describe, it, expect } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
import { makeApp, makeTable } from "./actions-test-utils";

/**
 * `/meta.fields` must omit non-JSON nested-object parents (`designType: "object"`).
 * Mongo keeps parents in `fieldDescriptors` for schema-hash + sync, but a parent
 * + leaf pair in Mongo's `$project` errors with code 31249 (Path collision).
 */

function build(fieldDescriptors: Array<{ path: string; designType: string }>): AsDbController {
  return new AsDbController(makeTable({ fieldDescriptors }) as never, makeApp().app);
}

describe("AsDbReadableController — /meta.fields filtering of nested-object parents", () => {
  it("omits non-JSON nested-object parents from /meta.fields so Mongo $select cannot collide on Path 31249", async () => {
    const ctrl = build([
      { path: "id", designType: "string" },
      { path: "password", designType: "object" },
      { path: "password.hash", designType: "string" },
      { path: "password.salt", designType: "string" },
    ]);

    const meta = await ctrl.meta();

    expect(meta.fields["password.hash"]).toBeDefined();
    expect(meta.fields["password.salt"]).toBeDefined();
    expect(meta.fields.password).toBeUndefined();
  });

  it("keeps @db.json object fields (designType: 'json') in /meta.fields", async () => {
    const ctrl = build([
      { path: "id", designType: "string" },
      { path: "preferences", designType: "json" },
    ]);

    const meta = await ctrl.meta();

    expect(meta.fields.preferences).toBeDefined();
  });

  it("keeps scalar leaves and arrays in /meta.fields (filter must only drop designType === 'object')", async () => {
    const ctrl = build([
      { path: "id", designType: "string" },
      { path: "age", designType: "number" },
      { path: "active", designType: "boolean" },
      { path: "tags", designType: "array" },
    ]);

    const meta = await ctrl.meta();

    expect(meta.fields.id).toBeDefined();
    expect(meta.fields.age).toBeDefined();
    expect(meta.fields.active).toBeDefined();
    expect(meta.fields.tags).toBeDefined();
  });
});
