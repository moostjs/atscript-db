import { describe, it, expectTypeOf } from "vite-plus/test";

import type { TCrudOp, TCrudPermissions, TMetaResponse } from "../index";

describe("crud permissions types", () => {
  it("TCrudOp is the documented union", () => {
    expectTypeOf<TCrudOp>().toEqualTypeOf<
      "query" | "pages" | "one" | "geo" | "insert" | "update" | "replace" | "remove"
    >();
  });

  it("TCrudPermissions is Partial<Record<TCrudOp, string[]>>", () => {
    expectTypeOf<TCrudPermissions>().toEqualTypeOf<Partial<Record<TCrudOp, string[]>>>();
  });

  it("TMetaResponse carries crud and no longer carries readOnly", () => {
    expectTypeOf<TMetaResponse>().toHaveProperty("crud").toEqualTypeOf<TCrudPermissions>();
    expectTypeOf<TMetaResponse>().not.toHaveProperty("readOnly");
  });

  it("an example value with mixed read + write keys is valid", () => {
    const v: TCrudPermissions = {
      query: ["filter", "select"],
      one: ["select", "with"],
      insert: [],
      remove: [],
    };
    expectTypeOf(v).toEqualTypeOf<TCrudPermissions>();
  });
});
