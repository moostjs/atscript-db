import { describe, it, expect } from "vite-plus/test";
import { DbError } from "@atscript/db";

import { httpReplyFor } from "./test-utils";

// Since 0.1.165 the `DbError` envelope carries the error's `code` (so a
// client can tell CONFLICT from FK_VIOLATION without parsing text) and each
// entry's `code` / `params` (to translate it). The engine text an entry keeps
// in `details` never reaches the client.

describe("DbError HTTP envelope", () => {
  it("carries the top-level code and per-entry code/params, never details", () => {
    const error = new DbError("CONFLICT", [
      {
        path: "householdId",
        message: 'The combination of "householdId", "name" must be unique',
        code: "UNIQUE",
        params: { index: "by_name", fields: ["householdId", "name"] },
        details: "UNIQUE constraint failed: items.householdId, items.name",
      },
    ]);
    const reply = httpReplyFor(error);
    expect(reply.body).toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      message: 'The combination of "householdId", "name" must be unique',
      errors: [
        {
          path: "householdId",
          message: 'The combination of "householdId", "name" must be unique',
          code: "UNIQUE",
          params: { index: "by_name", fields: ["householdId", "name"] },
        },
      ],
    });
    expect((reply.body as any).errors[0]).not.toHaveProperty("details");
  });

  it("entries without a code stay { path, message }", () => {
    const reply = httpReplyFor(new DbError("NOT_FOUND", [{ path: "id", message: "Not found" }]));
    expect((reply.body as any).errors).toEqual([{ path: "id", message: "Not found" }]);
    expect(reply.body).toMatchObject({
      statusCode: 400,
      code: "NOT_FOUND",
      message: "Not found",
      errors: [{ path: "id", message: "Not found" }],
    });
  });
});
