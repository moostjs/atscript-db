import { describe, it, expect } from "vite-plus/test";
import { ValidatorError } from "@atscript/typescript/utils";

import {
  validateSinglePk,
  validateMultiPk,
  type PkValidationSource,
} from "../actions/pk-validation";

/**
 * Targets the validator helpers used by `@DbActionPK()` / `@DbActionPKs()` —
 * exercises shape coverage independently of the full Moost handler chain.
 */

const stringPkSource: PkValidationSource = {
  primaryKeys: ["id"],
  fieldDescriptors: [{ path: "id", designType: "string" } as never],
};

const numberPkSource: PkValidationSource = {
  primaryKeys: ["id"],
  fieldDescriptors: [{ path: "id", designType: "number" } as never],
};

const compositePkSource: PkValidationSource = {
  primaryKeys: ["tenantId", "userId"],
  fieldDescriptors: [
    { path: "tenantId", designType: "string" } as never,
    { path: "userId", designType: "string" } as never,
  ],
};

describe("validateSinglePk", () => {
  it("accepts a JSON-encoded scalar string for single string PK", () => {
    expect(() => validateSinglePk("abc123", stringPkSource)).not.toThrow();
  });

  it("accepts a JSON-encoded numeric scalar for single number PK", () => {
    expect(() => validateSinglePk(42, numberPkSource)).not.toThrow();
  });

  it("rejects a string when the PK type is number (no coercion)", () => {
    expect(() => validateSinglePk("42", numberPkSource)).toThrow(ValidatorError);
  });

  it("accepts a JSON object for composite PK", () => {
    expect(() =>
      validateSinglePk({ tenantId: "acme", userId: "u1" }, compositePkSource),
    ).not.toThrow();
  });

  it("rejects composite PK with missing field", () => {
    try {
      validateSinglePk({ tenantId: "acme" }, compositePkSource);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidatorError);
      const err = e as ValidatorError;
      expect(err.errors[0].path).toBe("userId");
      expect(err.errors[0].message).toContain("Missing primary-key field");
    }
  });

  it("rejects composite PK with wrong-typed field", () => {
    try {
      validateSinglePk({ tenantId: "acme", userId: 42 }, compositePkSource);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidatorError);
      expect((e as ValidatorError).errors[0].path).toBe("userId");
    }
  });

  it("rejects scalar passed for composite PK", () => {
    expect(() => validateSinglePk("acme/u1", compositePkSource)).toThrow(ValidatorError);
  });
});

describe("validateMultiPk", () => {
  it("accepts an array of scalar PKs", () => {
    expect(() => validateMultiPk(["a", "b", "c"], stringPkSource)).not.toThrow();
  });

  it("accepts an array of composite-PK objects", () => {
    expect(() =>
      validateMultiPk(
        [
          { tenantId: "acme", userId: "u1" },
          { tenantId: "acme", userId: "u2" },
        ],
        compositePkSource,
      ),
    ).not.toThrow();
  });

  it("rejects when the body is not an array", () => {
    expect(() => validateMultiPk("a", stringPkSource)).toThrow(ValidatorError);
  });

  it("rejects when an element is the wrong scalar type", () => {
    try {
      validateMultiPk(["a", 42, "c"], stringPkSource);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidatorError);
      expect((e as ValidatorError).errors[0].path).toBe("[1]");
    }
  });

  it("rejects when a composite element is missing a field", () => {
    try {
      validateMultiPk([{ tenantId: "acme" }], compositePkSource);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidatorError);
      expect((e as ValidatorError).errors[0].path).toBe("[0].userId");
    }
  });
});
