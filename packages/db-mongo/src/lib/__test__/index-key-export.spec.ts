import { describe, expect, it } from "vite-plus/test";

// The physical index-name helpers are part of the package's PUBLIC surface so
// raw-`mongodb`-driver consumers can resolve the Atlas Search index name that
// schema-sync provisions. Import from the package root — this locks both the
// re-export chain (index → lib → mongo-adapter → mongo-types) and the scheme.
import { INDEX_PREFIX, mongoIndexKey } from "../../index";

describe("mongoIndexKey public export", () => {
  it("is re-exported from the package root", () => {
    expect(typeof mongoIndexKey).toBe("function");
    expect(INDEX_PREFIX).toBe("atscript__");
  });

  it("matches the documented scheme atscript__<type>__<cleanName>", () => {
    // `@db.mongo.search.static ... 'inventory_search'` → physical index name.
    expect(mongoIndexKey("search_text", "inventory_search")).toBe(
      "atscript__search_text__inventory_search",
    );
    expect(mongoIndexKey("vector", "doc_vec")).toBe("atscript__vector__doc_vec");
    expect(mongoIndexKey("dynamic_text", "_")).toBe("atscript__dynamic_text___");
    expect(mongoIndexKey("unique", "by_code")).toBe("atscript__unique__by_code");
  });

  it("sanitizes illegal characters and collapses runs of underscores", () => {
    expect(mongoIndexKey("search_text", "my index!!name")).toBe(
      "atscript__search_text__my_index_name",
    );
  });

  it("clamps the full physical name to MongoDB's 127-char index-name limit", () => {
    const name = mongoIndexKey("search_text", "x".repeat(200));
    expect(name.startsWith("atscript__search_text__")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(127);
  });
});
