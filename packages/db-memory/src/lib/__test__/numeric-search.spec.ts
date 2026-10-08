import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MemoryAdapter } from "../memory-adapter";
import { prepareFixtures } from "./test-utils";

// `$regex` on integer fields matches the decimal text of the number (the
// fallback of `@db.column.searchable` on an integer, since 0.1.150).

let fx: Record<string, any>;
let space: DbSpace;
const t = (type: unknown): any => space.getTable(type as never);

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/numeric-search.as");
  space = new DbSpace(() => new MemoryAdapter());
  await new SchemaSync(space).run([fx.NsFallback], { force: true });
  await t(fx.NsFallback).insertMany([
    { id: 1, title: "a", ref_no: 29461277 },
    { id: 2, title: "b", ref_no: 15 },
    { id: 3, title: "c", ref_no: -2946 },
    { id: 4, title: "d", ref_no: 0 },
  ]);
});

const ids = async (filter: Record<string, unknown>) =>
  (await t(fx.NsFallback).findMany({ filter }))
    .map((r: { id: number }) => r.id)
    .toSorted((a: number, b: number) => a - b);

describe("[memory] $regex on integer fields", () => {
  it("matches substrings of the decimal text", async () => {
    expect(await ids({ ref_no: { $regex: "/2946/" } })).toEqual([1, 3]);
    expect(await ids({ ref_no: /^29/ })).toEqual([1]);
    expect(await ids({ ref_no: { $regex: "/^-/" } })).toEqual([3]);
    expect(await ids({ ref_no: { $regex: "/^0$/" } })).toEqual([4]);
  });

  it("composes in $or with a string field", async () => {
    expect(
      await ids({ $or: [{ ref_no: { $regex: "/^15$/" } }, { title: { $regex: "/^c$/" } }] }),
    ).toEqual([2, 3]);
  });
});
