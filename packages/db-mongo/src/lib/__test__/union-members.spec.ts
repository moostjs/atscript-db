import { describe, it, expect, beforeAll } from "vite-plus/test";

import { createTestSpace, prepareFixtures } from "./test-utils";

// Since atscript 0.1.103 `number.timestamp.created | null` carries
// `@db.default.now` on its member. Members are not fields: no default, no
// index — except the one non-null member of `T | null`, whose db annotations
// apply (`x` / `y` get the `now` default, like `created`).

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/union-members.as");
});

describe("[mongo] union / tuple members", () => {
  it("member annotations do not reach the field descriptors, except T | null's db ones", () => {
    const table = createTestSpace().getTable(fx.UnionMembers);
    for (const path of ["x", "y", "created"]) {
      const fd = table.fieldDescriptors.find((d) => d.path === path)!;
      expect(fd.defaultValue, path).toEqual({ kind: "fn", fn: "now" });
    }
    for (const path of ["pair", "n", "code"]) {
      const fd = table.fieldDescriptors.find((d) => d.path === path)!;
      expect(fd.defaultValue, path).toBeUndefined();
      expect([...fd.type.metadata.keys()], path).toEqual([]);
    }
    expect(table.indexes.size).toBe(0);
  });
});
