import { describe, it, expect, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { MetaResponse } from "../types";
import { createClientValidator, ClientValidationError, type ClientValidator } from "../validator";

/**
 * A `@db.json` field is stored and written whole, so array patch operators
 * on it are refused — with their own code (`ARRAY_OP_ON_JSON`), the same the
 * server answers, not a bare `TYPE_ARRAY`.
 */

let validator: ClientValidator;

beforeAll(async () => {
  const { JsonDoc } = await import("./fixtures/json-array.as");
  const meta: MetaResponse = {
    searchable: false,
    vectorSearchable: false,
    searchIndexes: [],
    primaryKeys: ["id"],
    preferredId: ["id"],
    relations: [],
    fields: {},
    type: serializeAnnotatedType(JsonDoc as unknown as TAtscriptAnnotatedType),
    actions: [],
    crud: {},
  };
  validator = createClientValidator(meta);
});

describe("ClientValidator — array operators on a @db.json field", () => {
  it("rejects $insert with ARRAY_OP_ON_JSON", () => {
    let error: unknown;
    try {
      validator.validate({ id: 1, tags: { $insert: ["x"] } }, "patch");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ClientValidationError);
    expect((error as ClientValidationError).errors).toEqual([
      expect.objectContaining({
        path: "tags",
        code: "ARRAY_OP_ON_JSON",
        message:
          "Array patch operators are not supported on a @db.json field — send the whole array",
      }),
    ]);
  });

  it("accepts the whole array, and operators on a plain array", () => {
    expect(() => validator.validate({ id: 1, tags: ["x", "y"] }, "patch")).not.toThrow();
    expect(() => validator.validate({ id: 1, labels: { $remove: ["x"] } }, "patch")).not.toThrow();
  });
});
