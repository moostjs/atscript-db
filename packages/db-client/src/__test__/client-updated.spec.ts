import { describe, it, expect, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { MetaResponse } from "../types";
import { ClientValidationError, createClientValidator } from "../validator";

/**
 * db-client and `number.timestamp.updated` (atscript 0.1.106 / db 0.1.156): the
 * field carries `@db.default.now` and `@db.onUpdate.now`, which `/meta.type`
 * keeps, so the shared validator plugin lets an insert and a replace omit it.
 * A bare `@db.onUpdate.now` field may be omitted on replace only.
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
    type: serializeAnnotatedType(fixtures.UpdatedRow as unknown as TAtscriptAnnotatedType, {
      refDepth: 0.5,
    }),
  } as unknown as MetaResponse;
});

describe("ClientValidator — number.timestamp.updated is server-managed", () => {
  it("insert may omit it, directly, as T | null and nested", () => {
    const v = createClientValidator(meta);
    expect(() => v.validate({ id: 1, audit: {}, editedAt: 1 }, "insert")).not.toThrow();
  });

  it("replace may omit it and a bare @db.onUpdate.now field", () => {
    const v = createClientValidator(meta);
    expect(() => v.validate({ id: 1, audit: {} }, "replace")).not.toThrow();
  });

  it("a bare @db.onUpdate.now field is still required on insert", () => {
    const v = createClientValidator(meta);
    expect(() => v.validate({ id: 1, audit: {} }, "insert")).toThrow(ClientValidationError);
  });
});
