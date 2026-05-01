import { describe, it, expect } from "vite-plus/test";
import { ValidatorError } from "@atscript/typescript/utils";
import type { TDbFieldMeta, TIdentification } from "@atscript/db";

import {
  isIdValidationSource,
  validateSingleId,
  validateMultiId,
  type IdValidationSource,
} from "../actions/id-validation";

/**
 * Targets the validator helpers used by `@DbActionID()` / `@DbActionIDs()` —
 * exercises shape coverage independently of the full Moost handler chain.
 */

function makeSource(
  identifications: readonly TIdentification[],
  fieldDescriptors: readonly Pick<TDbFieldMeta, "path" | "designType">[],
): IdValidationSource {
  return {
    identifications,
    fieldDescriptors: fieldDescriptors as readonly TDbFieldMeta[],
  };
}

const stringPkSource = makeSource(
  [{ fields: ["id"], source: "primaryKey" }],
  [{ path: "id", designType: "string" }],
);

const numberPkSource = makeSource(
  [{ fields: ["id"], source: "primaryKey" }],
  [{ path: "id", designType: "number" }],
);

const compositePkSource = makeSource(
  [{ fields: ["tenantId", "userId"], source: "primaryKey" }],
  [
    { path: "tenantId", designType: "string" },
    { path: "userId", designType: "string" },
  ],
);

const uniqueSource = makeSource(
  [
    { fields: ["id"], source: "primaryKey" },
    { fields: ["email"], source: "email" },
    { fields: ["tenantId", "slug"], source: "tenant_slug" },
  ],
  [
    { path: "id", designType: "string" },
    { path: "email", designType: "string" },
    { path: "tenantId", designType: "string" },
    { path: "slug", designType: "string" },
  ],
);

describe("validateSingleId", () => {
  it("accepts an object-shaped string ID", () => {
    expect(() => validateSingleId({ id: "abc123" }, stringPkSource)).not.toThrow();
  });

  it("accepts an object-shaped numeric ID", () => {
    expect(() => validateSingleId({ id: 42 }, numberPkSource)).not.toThrow();
  });

  it("rejects a string when the ID type is number (no coercion)", () => {
    expect(() => validateSingleId({ id: "42" }, numberPkSource)).toThrow(ValidatorError);
  });

  it("accepts a JSON object for composite ID", () => {
    expect(() =>
      validateSingleId({ tenantId: "acme", userId: "u1" }, compositePkSource),
    ).not.toThrow();
  });

  it("rejects composite ID with missing field", () => {
    try {
      validateSingleId({ tenantId: "acme" }, compositePkSource);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidatorError);
      const err = e as ValidatorError;
      expect(err.errors[0].path).toBe("");
      expect(err.errors[0].message).toContain("Identifier fields must exactly match");
    }
  });

  it("rejects composite ID with wrong-typed field", () => {
    try {
      validateSingleId({ tenantId: "acme", userId: 42 }, compositePkSource);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidatorError);
      expect((e as ValidatorError).errors[0].path).toBe("userId");
    }
  });

  it("rejects scalar passed for composite ID", () => {
    expect(() => validateSingleId("acme/u1", compositePkSource)).toThrow(ValidatorError);
  });

  it("accepts single-field unique-index identifiers", () => {
    expect(() => validateSingleId({ email: "a@example.com" }, uniqueSource)).not.toThrow();
  });

  it("accepts compound unique-index identifiers", () => {
    expect(() => validateSingleId({ tenantId: "acme", slug: "alpha" }, uniqueSource)).not.toThrow();
  });

  it("rejects unknown field combinations strictly", () => {
    expect(() => validateSingleId({ id: "1", email: "a@example.com" }, uniqueSource)).toThrow(
      ValidatorError,
    );
  });

  it("uses logical prop names for unique-index identifiers — physical column names are rejected", () => {
    // Prop `slug: string` carries `@db.column "url_slug"`. The wire/UI sees
    // the logical name `slug`; the physical name `url_slug` is an adapter
    // concern and MUST NOT be accepted as a request-body identifier — the
    // table's identification list only carries the logical name.
    const physicalAliasSource = makeSource(
      [
        { fields: ["id"], source: "primaryKey" },
        { fields: ["slug"], source: "by_slug" },
      ],
      [
        { path: "id", designType: "string" },
        { path: "slug", designType: "string" },
      ],
    );
    expect(() => validateSingleId({ slug: "alpha" }, physicalAliasSource)).not.toThrow();
    expect(() => validateSingleId({ url_slug: "alpha" }, physicalAliasSource)).toThrow(
      ValidatorError,
    );
  });
});

describe("validateMultiId", () => {
  it("accepts an array of object-shaped IDs", () => {
    expect(() =>
      validateMultiId([{ id: "a" }, { id: "b" }, { id: "c" }], stringPkSource),
    ).not.toThrow();
  });

  it("accepts an array of composite-ID objects", () => {
    expect(() =>
      validateMultiId(
        [
          { tenantId: "acme", userId: "u1" },
          { tenantId: "acme", userId: "u2" },
        ],
        compositePkSource,
      ),
    ).not.toThrow();
  });

  it("rejects when the body is not an array", () => {
    expect(() => validateMultiId("a", stringPkSource)).toThrow(ValidatorError);
  });

  it("rejects when an element is the wrong scalar type", () => {
    try {
      validateMultiId([{ id: "a" }, { id: 42 }, { id: "c" }], stringPkSource);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidatorError);
      expect((e as ValidatorError).errors[0].path).toBe("[1].id");
    }
  });

  it("rejects when a composite element is missing a field", () => {
    try {
      validateMultiId([{ tenantId: "acme" }], compositePkSource);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidatorError);
      expect((e as ValidatorError).errors[0].path).toBe("[0]");
    }
  });

  it("accepts mixed PK and unique-index identifiers", () => {
    expect(() =>
      validateMultiId([{ id: "1" }, { email: "a@example.com" }], uniqueSource),
    ).not.toThrow();
  });
});

describe("isIdValidationSource", () => {
  it("accepts the canonical AtscriptDbReadable shape (`identifications` + `fieldDescriptors` getters returning arrays)", () => {
    const source = {
      get identifications() {
        return [{ fields: ["id"], source: "primaryKey" }];
      },
      get fieldDescriptors() {
        return [{ path: "id", designType: "string" }];
      },
    };
    expect(isIdValidationSource(source)).toBe(true);
  });

  it("accepts plain-object data shape (no getter, just array properties)", () => {
    const source = {
      identifications: [{ fields: ["id"], source: "primaryKey" }],
      fieldDescriptors: [{ path: "id", designType: "string" }],
    };
    expect(isIdValidationSource(source)).toBe(true);
  });

  it("rejects the legacy method-shape `{ getIdentifications: fn, fieldDescriptors: [] }`", () => {
    // Regression: prior contract was `getIdentifications()` as a method;
    // current contract is the `identifications` getter to match
    // `AtscriptDbReadable`'s public surface.
    const legacy = {
      getIdentifications: () => [{ fields: ["id"], source: "primaryKey" }],
      fieldDescriptors: [{ path: "id", designType: "string" }],
    };
    expect(isIdValidationSource(legacy)).toBe(false);
  });

  it("rejects values missing `identifications`", () => {
    expect(isIdValidationSource({ fieldDescriptors: [] })).toBe(false);
  });

  it("rejects values missing `fieldDescriptors`", () => {
    expect(isIdValidationSource({ identifications: [] })).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(isIdValidationSource(null)).toBe(false);
    expect(isIdValidationSource(undefined)).toBe(false);
    expect(isIdValidationSource("table")).toBe(false);
    expect(isIdValidationSource(42)).toBe(false);
  });
});
