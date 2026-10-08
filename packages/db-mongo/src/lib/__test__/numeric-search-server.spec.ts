import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import type { MongoClient } from "mongodb";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Integer fulltext members against a real MongoDB (mongodb-memory-server):
// `$or` of `$text` and an index-backed `$type`-guarded equality — including an
// OPTIONAL unique member (partial index) — plus `$regex` on integer fields.

let fx: Record<string, any>;
let space: DbSpace;
let server: any;
let client: MongoClient;

const t = (type: unknown): any => space.getTable(type as never);
const ids = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => r.id as number).toSorted((a, b) => a - b);

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/numeric-search.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  const db = client.db("numsearch");
  space = new DbSpace(() => new MongoAdapter(db, client));
  const result = await new SchemaSync(space).run([fx.NsItem, fx.NsCode, fx.NsFallback], {
    force: true,
  });
  expect(result.status).toBe("synced");
  await t(fx.NsItem).insertMany([
    { id: 1, title: "quokka login", ref_no: 29461277, alt_no: 700 },
    { id: 2, title: "payment 2946 timeout", ref_no: 15, alt_no: 29460 },
    { id: 3, title: "settings", ref_no: 2946 },
    { id: 4, title: "export", ref_no: -2946, alt_no: 12 },
    { id: 5, title: "dashboard", ref_no: 0, alt_no: 101 },
    { id: 6, title: "quokka sync", ref_no: 4242, alt_no: 2946 },
    { id: 7, title: "no alt", ref_no: 9 },
  ]);
  await t(fx.NsCode).insertMany([
    { id: 4, label: "a" },
    { id: 44, label: "b" },
  ]);
  await t(fx.NsFallback).insertMany([
    { id: 1, title: "a", ref_no: 29461277 },
    { id: 2, title: "b", ref_no: 15 },
    { id: 3, title: "c", ref_no: -2946 },
    { id: 4, title: "d", ref_no: 0 },
    { id: 5, title: "e", ref_no: 10000000000000000 },
  ]);
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

describe("[mongo] integer fulltext members (real server)", () => {
  it("creates one text index over the text members only", async () => {
    const indexes = await client.db("numsearch").collection("ns_items").indexes();
    const text = indexes.find((i) => i.name === "atscript__fulltext__ns_ft")!;
    expect(Object.keys(text.weights as object)).toEqual(["title"]);
  });

  it("a whole-number term finds the text token and the exact members, not substrings", async () => {
    const rows = await t(fx.NsItem).search("2946", {});
    expect(ids(rows)).toEqual([2, 3, 6]); // title token, ref_no, alt_no — NOT 29461277
    expect(ids(await t(fx.NsItem).search("29461277", {}))).toEqual([1]);
    expect(ids(await t(fx.NsItem).search("0", {}))).toEqual([5]);
    expect(await t(fx.NsItem).search("02946", {})).toEqual([]);
  });

  it("a negative term hits the exact member (and `-` negation never drops it)", async () => {
    expect(ids(await t(fx.NsItem).search("-2946", {}))).toEqual([4]);
  });

  it("text hits come before equality-only rows", async () => {
    const rows = await t(fx.NsItem).search("2946", {});
    expect(rows[0].id).toBe(2);
  });

  it("searchWithCount and a grouped $count agree", async () => {
    const res = await t(fx.NsItem).searchWithCount("2946", {});
    expect(res.count).toBe(3);
    const agg = await t(fx.NsItem).aggregate({
      filter: {},
      controls: { $groupBy: ["title"], $count: true, $search: "2946" },
    });
    expect(agg[0].count).toBe(3);
  });

  it("an integer-only index matches by number and nothing else", async () => {
    expect(ids(await t(fx.NsCode).search("4", {}))).toEqual([4]);
    expect(await t(fx.NsCode).search("04", {})).toEqual([]);
    expect(await t(fx.NsCode).search("abc", {})).toEqual([]);
    expect((await t(fx.NsCode).searchWithCount("abc", {})).count).toBe(0);
  });
});

describe("[mongo] $regex on integer fields (real server)", () => {
  const match = async (pattern: string) =>
    ids(await t(fx.NsFallback).findMany({ filter: { ref_no: { $regex: pattern } } }));

  it("matches the decimal text of the stored number", async () => {
    expect(await match("/2946/")).toEqual([1, 3]);
    expect(await match("/^29/")).toEqual([1]);
    expect(await match("/-29/")).toEqual([3]);
    expect(await match("/0/")).toEqual([4, 5]);
    // a 10^16 double prints as 10000000000000000, not 1e+16
    expect(await match("/^1000000000000000/")).toEqual([5]);
  });

  it("composes inside $or / $not", async () => {
    const rows = await t(fx.NsFallback).findMany({
      filter: { $or: [{ ref_no: /^15$/ }, { title: { $regex: "/^c$/" } }] },
    });
    expect(ids(rows)).toEqual([2, 3]);
    const none = await t(fx.NsFallback).findMany({ filter: { $not: { ref_no: /2946/ } } });
    expect(ids(none)).toEqual([2, 4, 5]);
  });
});

describe("[mongo] why every member needs an index backing", () => {
  it("an unindexed member next to $text is refused by MongoDB (error 291)", async () => {
    const col = client.db("numsearch").collection("ns_items");
    await expect(
      col
        .aggregate([{ $match: { $or: [{ $text: { $search: "x" } }, { title: "nope-no-index" }] } }])
        .toArray(),
    ).rejects.toThrow(/291|indexed/);
  });

  it("the $type-guarded equality uses the partial unique index of an optional member", async () => {
    const col = client.db("numsearch").collection("ns_items");
    const rows = await col
      .aggregate([
        {
          $match: {
            $or: [{ $text: { $search: "zzzz" } }, { alt_no: { $eq: 2946, $type: "number" } }],
          },
        },
      ])
      .toArray();
    expect(rows.map((r) => r.id)).toEqual([6]);
  });
});
