import { describe, it, expect } from "vite-plus/test";
import { encodeNavigateId, formatIdentifier, formatIdentifierField } from "../client";

describe("formatIdentifierField", () => {
  it("renders strings verbatim", () => {
    expect(formatIdentifierField("abc")).toBe("abc");
    expect(formatIdentifierField("")).toBe("");
  });

  it("renders numbers, booleans, bigints via String()", () => {
    expect(formatIdentifierField(42)).toBe("42");
    expect(formatIdentifierField(0)).toBe("0");
    expect(formatIdentifierField(true)).toBe("true");
    expect(formatIdentifierField(false)).toBe("false");
    expect(formatIdentifierField(123n)).toBe("123");
  });

  it("renders null and undefined as empty string (NOT 'null' / 'undefined')", () => {
    expect(formatIdentifierField(null)).toBe("");
    expect(formatIdentifierField(undefined)).toBe("");
  });

  it("JSON-stringifies objects and arrays", () => {
    expect(formatIdentifierField({ a: 1 })).toBe('{"a":1}');
    expect(formatIdentifierField([1, 2])).toBe("[1,2]");
  });
});

describe("formatIdentifier", () => {
  it("returns empty string for undefined identifier", () => {
    expect(formatIdentifier(undefined, ["id"])).toBe("");
  });

  it("joins single-field id verbatim (no encoding)", () => {
    expect(formatIdentifier({ id: "abc/123" }, ["id"])).toBe("abc/123");
    expect(formatIdentifier({ id: 42 }, ["id"])).toBe("42");
  });

  it("walks preferredId declaration order, NOT object-key order", () => {
    // Object keys deliberately reversed.
    const id = { userId: "jane", tenantId: "acme" };
    expect(formatIdentifier(id, ["tenantId", "userId"])).toBe("acme/jane");
  });

  it("renders missing fields as empty segments", () => {
    expect(formatIdentifier({ tenantId: "acme" }, ["tenantId", "userId"])).toBe("acme/");
    expect(formatIdentifier({}, ["id"])).toBe("");
  });

  it("returns empty string when preferredId is empty", () => {
    expect(formatIdentifier({ id: 1 }, [])).toBe("");
  });
});

describe("encodeNavigateId", () => {
  it("URL-encodes each field, joins with literal /", () => {
    expect(encodeNavigateId({ id: "abc/123" }, ["id"])).toBe("abc%2F123");
  });

  it("walks preferredId declaration order with encoding", () => {
    const id = { userId: "jane", tenantId: "acme/co" };
    expect(encodeNavigateId(id, ["tenantId", "userId"])).toBe("acme%2Fco/jane");
  });

  it("renders a missing field as an empty segment, NOT literal 'undefined'", () => {
    // Regression: previously String(undefined) → 'undefined' baked into the URL.
    expect(encodeNavigateId({ tenantId: "acme" }, ["tenantId", "userId"])).toBe("acme/");
    expect(encodeNavigateId({}, ["id"])).toBe("");
  });

  it("encodes special characters in numeric and boolean values too", () => {
    expect(encodeNavigateId({ id: 42 }, ["id"])).toBe("42");
    expect(encodeNavigateId({ id: true }, ["id"])).toBe("true");
  });
});
