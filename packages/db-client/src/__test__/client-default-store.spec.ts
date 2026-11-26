import { describe, it, expect, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { MetaResponse } from "../types";
import { ClientValidationError, createClientValidator } from "../validator";

/**
 * db-client and `@db.default.store` (since 0.1.196): `/meta.type` keeps every
 * `db.default*` key, so the shared validator plugin lets an insert or a
 * replace leave a store-filled field out — no client code knows the key.
 */

let meta: MetaResponse;

beforeAll(async () => {
  const fixtures = (await import("./fixtures/test-table.as")) as Record<string, unknown>;
  meta = {
    primaryKeys: ["orderNo"],
    preferredId: ["orderNo"],
    relations: [],
    fields: {},
    actions: [],
    crud: {},
    type: serializeAnnotatedType(fixtures.StoreKeyedOrder as unknown as TAtscriptAnnotatedType, {
      refDepth: 0.5,
    }),
  } as unknown as MetaResponse;
});

describe("ClientValidator — @db.default.store is server-managed", () => {
  it("an insert may leave the store-filled key out", () => {
    const v = createClientValidator(meta);
    expect(() => v.validate({ customer: "C1" }, "insert")).not.toThrow();
  });

  it("the other fields are still required", () => {
    const v = createClientValidator(meta);
    expect(() => v.validate({ orderNo: "SO-1" }, "insert")).toThrow(ClientValidationError);
  });
});
