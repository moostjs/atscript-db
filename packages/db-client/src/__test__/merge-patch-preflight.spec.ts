import { describe, it, expect, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { MetaResponse } from "../types";
import { createClientValidator, ClientValidationError, type ClientValidator } from "../validator";

/**
 * IMPROVE.md #5: patch preflight must mirror the server's merge-aware update
 * validation. A `@db.patch.strategy "merge"` block accepts PARTIAL nested
 * payloads server-side (absent keys survive the merge), so the client's
 * patch validator must treat those blocks as deep-partial too — while
 * non-merge nested objects keep full validation ($set as a whole).
 */

let validator: ClientValidator;

beforeAll(async () => {
  const fixtures = await import("./fixtures/test-table.as");
  const UserType = fixtures.User as unknown as TAtscriptAnnotatedType;
  const meta: MetaResponse = {
    searchable: false,
    vectorSearchable: false,
    searchIndexes: [],
    primaryKeys: ["id"],
    preferredId: ["id"],
    relations: [],
    fields: {},
    type: serializeAnnotatedType(UserType),
    actions: [],
    crud: {},
  };
  validator = createClientValidator(meta);
});

describe("ClientValidator merge-aware patch preflight", () => {
  it("accepts a partial merge block missing a required (server-stamped) key", () => {
    // The report's exact shape: `credit.status` is required but deliberately
    // absent — it is stamped server-side; the merge keeps it intact.
    expect(() =>
      validator.validate(
        {
          id: 1,
          credit: { provider: "credit700", credentials: { account: "a", password: "b" } },
        },
        "patch",
      ),
    ).not.toThrow();
  });

  it("still rejects a partial NON-merge block missing a required key", () => {
    // `profile` has no merge strategy → it is $set as a whole; `bio` required.
    expect(() => validator.validate({ id: 1, profile: { age: 30 } }, "patch")).toThrow(
      ClientValidationError,
    );
  });

  it("still validates present keys inside a merge block against their types", () => {
    expect(() => validator.validate({ id: 1, credit: { status: "bogus" } }, "patch")).toThrow(
      ClientValidationError,
    );
  });

  it("accepts null on an optional key inside a merge block (clear-on-merge)", () => {
    expect(() => validator.validate({ id: 1, credit: { note: null } }, "patch")).not.toThrow();
  });

  it("keeps full validation for non-merge objects nested inside a merge block", () => {
    // `credentials` itself is not merge → provided means provided whole.
    expect(() =>
      validator.validate({ id: 1, credit: { credentials: { account: "a" } } }, "patch"),
    ).toThrow(ClientValidationError);
  });

  it("keeps full validation of merge blocks on insert", () => {
    expect(() =>
      validator.validate({ name: "Ada", credit: { provider: "credit700" } }, "insert"),
    ).toThrow(ClientValidationError);
  });

  it("keeps full validation of merge blocks on replace", () => {
    expect(() =>
      validator.validate({ id: 1, name: "Ada", credit: { provider: "credit700" } }, "replace"),
    ).toThrow(ClientValidationError);
  });
});
