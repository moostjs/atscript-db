import { describe, it, expect, expectTypeOf } from "vite-plus/test";

import { ClientError } from "../client-error";
import type { ServerError } from "../types";

// Since 0.1.165 the error body is extensible: `ClientError<B>` types a body
// that carries domain fields next to the envelope (`code`, `limit`, …), and
// `ServerError` itself admits extra fields, the `DbError` `code` and the
// per-entry `code` / `params` moost-db sends. Before, `body` was the closed
// `ServerError`, so reading or building such a body needed a cast.

interface CapBody extends ServerError {
  code: "cap_reached";
  limit: number;
}

describe("ClientError body typing", () => {
  it("types a domain body through the generic parameter", () => {
    const error = new ClientError<CapBody>(409, {
      message: "Cap reached",
      statusCode: 409,
      code: "cap_reached",
      limit: 3,
    });
    expectTypeOf(error.body.limit).toEqualTypeOf<number>();
    expect(error.body.limit).toBe(3);
    expect(error.status).toBe(409);
  });

  it("the default body admits extra fields and the db error codes", () => {
    const error: ClientError = new ClientError(409, {
      message: "Value must be unique",
      statusCode: 409,
      code: "CONFLICT",
      tier: "basic",
      errors: [
        {
          path: "name",
          message: "Value must be unique",
          code: "UNIQUE",
          params: { index: "by_name", fields: ["name"] },
        },
      ],
    });
    expectTypeOf(error.body.code).toEqualTypeOf<string | undefined>();
    expectTypeOf(error.errors[0]!.params).toEqualTypeOf<Record<string, unknown> | undefined>();
    expect(error.body.tier).toBe("basic");
    expect(error.errors[0]!.code).toBe("UNIQUE");
  });
});
