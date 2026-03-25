import { describe, it, expect } from "vite-plus/test";

import { parseRegexString } from "../regex";

describe("parseRegexString", () => {
  it("should extract pattern and flags from /pattern/flags string", () => {
    expect(parseRegexString("/^Ali/i")).toEqual({ pattern: "^Ali", flags: "i" });
  });

  it("should extract pattern with multiple flags", () => {
    expect(parseRegexString("/test/gim")).toEqual({ pattern: "test", flags: "gim" });
  });

  it("should extract pattern with no flags", () => {
    expect(parseRegexString("/^start/")).toEqual({ pattern: "^start", flags: "" });
  });

  it("should handle RegExp objects", () => {
    expect(parseRegexString(/^Ali/i)).toEqual({ pattern: "^Ali", flags: "i" });
  });

  it("should handle RegExp objects without flags", () => {
    expect(parseRegexString(/test/)).toEqual({ pattern: "test", flags: "" });
  });

  it("should pass through raw pattern strings unchanged", () => {
    expect(parseRegexString("^Ali")).toEqual({ pattern: "^Ali", flags: "" });
  });

  it("should pass through contains patterns unchanged", () => {
    expect(parseRegexString("Ali")).toEqual({ pattern: "Ali", flags: "" });
  });

  it("should handle pattern with slashes inside", () => {
    expect(parseRegexString("/path\\/to\\/file/g")).toEqual({
      pattern: "path\\/to\\/file",
      flags: "g",
    });
  });
});
