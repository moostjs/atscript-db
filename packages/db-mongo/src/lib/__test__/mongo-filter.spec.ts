import { describe, it, expect } from "vite-plus/test";

import { buildMongoFilter } from "../mongo-filter";

describe("buildMongoFilter", () => {
  it("should return empty for empty filter", () => {
    expect(buildMongoFilter({})).toEqual({});
  });

  it("should handle simple equality", () => {
    expect(buildMongoFilter({ name: "Alice" })).toEqual({ name: "Alice" });
  });

  it("should pass through raw $regex string", () => {
    expect(buildMongoFilter({ name: { $regex: "^Ali" } })).toEqual({
      name: { $regex: "^Ali" },
    });
  });

  it("should parse /pattern/flags format into $regex + $options", () => {
    expect(buildMongoFilter({ name: { $regex: "/^Ali/i" } })).toEqual({
      name: { $regex: "^Ali", $options: "i" },
    });
  });

  it("should parse /pattern/ format without flags", () => {
    expect(buildMongoFilter({ name: { $regex: "/^Ali/" } })).toEqual({
      name: { $regex: "^Ali" },
    });
  });

  it("should handle RegExp objects", () => {
    expect(buildMongoFilter({ name: { $regex: /^Ali/i } })).toEqual({
      name: { $regex: "^Ali", $options: "i" },
    });
  });

  it("should handle RegExp objects without flags", () => {
    expect(buildMongoFilter({ name: { $regex: /^Ali/ } })).toEqual({
      name: { $regex: "^Ali" },
    });
  });
});
