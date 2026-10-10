import { describe, it, expect, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { MetaResponse } from "../types";
import { ClientValidationError, createClientValidator } from "../validator";

/**
 * db-client and `number.timestamp.created` (atscript 0.1.104 / db 0.1.155): the
 * field carries `@db.default.now`, which `/meta.type` keeps, so the shared
 * validator plugin lets an insert omit it — also as `T | null` and inside an
 * embedded object, not as a member of another union.
 */

let meta: MetaResponse;

beforeAll(async () => {
  const fixtures = (await import("./fixtures/test-table.as")) as Record<string, unknown>;
  meta = {
    primaryKeys: ["id"],
    preferredId: ["id"],
    relations: [],
    fields: {},
    actions: [],
    crud: {},
    type: serializeAnnotatedType(fixtures.CreatedRow as unknown as TAtscriptAnnotatedType, {
      refDepth: 0.5,
    }),
  } as unknown as MetaResponse;
});

describe("ClientValidator — number.timestamp.created is server-managed", () => {
  it("insert may omit it, directly, as T | null and nested", () => {
    const v = createClientValidator(meta);
    expect(() => v.validate({ id: 1, stamp: "s", audit: {} }, "insert")).not.toThrow();
  });

  it("a member of another union is still required", () => {
    const v = createClientValidator(meta);
    expect(() => v.validate({ id: 1, audit: {} }, "insert")).toThrow(ClientValidationError);
  });
});
