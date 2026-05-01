import { describe, it, expect } from "vite-plus/test";

import { ONE_CONTROLS, PAGES_CONTROLS, QUERY_CONTROLS } from "../permissions/crud-controls";

describe("crud-controls — exported constants", () => {
  it("QUERY_CONTROLS matches the documented set", () => {
    expect(new Set(QUERY_CONTROLS)).toEqual(
      new Set([
        "filter",
        "insights",
        "skip",
        "limit",
        "count",
        "sort",
        "select",
        "search",
        "index",
        "vector",
        "threshold",
        "with",
        "groupBy",
        "actions",
      ]),
    );
  });

  it("PAGES_CONTROLS excludes count and groupBy but includes actions", () => {
    expect(new Set(PAGES_CONTROLS)).toEqual(
      new Set([
        "filter",
        "page",
        "size",
        "sort",
        "select",
        "search",
        "index",
        "vector",
        "threshold",
        "with",
        "actions",
      ]),
    );
    expect(PAGES_CONTROLS).not.toContain("count");
    expect(PAGES_CONTROLS).not.toContain("groupBy");
    expect(PAGES_CONTROLS).toContain("actions");
  });

  it("ONE_CONTROLS contains select, with, actions", () => {
    expect(new Set(ONE_CONTROLS)).toEqual(new Set(["select", "with", "actions"]));
    expect(ONE_CONTROLS).not.toContain("filter");
    expect(ONE_CONTROLS).toContain("actions");
  });
});
