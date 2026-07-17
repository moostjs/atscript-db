import { describe, it, expect, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { MetaResponse } from "../types";
import { createClientValidator, ClientValidationError } from "../validator";

/**
 * `lenientWrites` (IMPROVE.md #2 stopgap): when the served `/meta` type is a
 * projection of the full server-side type (ARBAC read overlay stripping
 * write-only fields), strict preflight rejects legitimate writes carrying
 * those fields. The opt-in relaxes unknown-property checking on writes while
 * keeping every other rule (required fields, formats) enforced.
 */

let meta: MetaResponse;

beforeAll(async () => {
  const fixtures = await import("./fixtures/test-table.as");
  const UserType = fixtures.User as unknown as TAtscriptAnnotatedType;
  meta = {
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
});

describe("ClientValidator lenientWrites", () => {
  it("strict mode (default) rejects unknown properties in write payloads", () => {
    const validator = createClientValidator(meta);
    expect(() =>
      validator.validate({ name: "Ada", credentials: { user: "x", pass: "y" } }, "patch"),
    ).toThrow(ClientValidationError);
  });

  it("lenientWrites tolerates unknown properties (projection-stripped fields)", () => {
    const validator = createClientValidator(meta, { lenientWrites: true });
    expect(() =>
      validator.validate({ name: "Ada", credentials: { user: "x", pass: "y" } }, "patch"),
    ).not.toThrow();
  });

  it("lenientWrites still enforces the served type's own rules", () => {
    const validator = createClientValidator(meta, { lenientWrites: true });
    // `name` is required on insert — leniency only covers UNKNOWN props.
    expect(() => validator.validate({ status: "active" }, "insert")).toThrow(ClientValidationError);
  });
});
