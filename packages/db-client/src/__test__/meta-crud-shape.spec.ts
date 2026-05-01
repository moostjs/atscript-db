import { describe, it, expectTypeOf } from "vite-plus/test";

import type { MetaResponse, TCrudOp, TCrudPermissions } from "../index";

describe("MetaResponse — crud shape", () => {
  it("re-exports TCrudOp and TCrudPermissions", () => {
    expectTypeOf<TCrudOp>().toEqualTypeOf<
      "query" | "pages" | "one" | "insert" | "update" | "replace" | "remove"
    >();
    expectTypeOf<TCrudPermissions>().toEqualTypeOf<Partial<Record<TCrudOp, string[]>>>();
  });

  it("MetaResponse carries crud and no longer carries readOnly", () => {
    expectTypeOf<MetaResponse>().toHaveProperty("crud").toEqualTypeOf<TCrudPermissions>();
    expectTypeOf<MetaResponse>().not.toHaveProperty("readOnly");
  });

  it("a fully-shaped /meta payload is assignable to MetaResponse", () => {
    const payload = {
      searchable: false,
      vectorSearchable: false,
      searchIndexes: [],
      primaryKeys: ["id"],
      preferredId: ["id"],
      relations: [],
      fields: {},
      type: { kind: "object" } as never,
      actions: [],
      crud: {
        query: ["filter", "select"],
        one: ["select", "with"],
        insert: [],
      },
    } satisfies MetaResponse;
    expectTypeOf(payload).toMatchTypeOf<MetaResponse>();
  });
});
