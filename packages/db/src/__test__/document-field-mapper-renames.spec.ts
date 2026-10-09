import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DocumentFieldMapper } from "../strategies/field-mapping";
import { DbSpace } from "../table/db-space";
import type { AtscriptDbTable } from "../table/db-table";
import { resolveViewSource } from "../table/view-source";
import type { DbQuery } from "../types";
import { NestedMockAdapter, prepareFixtures } from "./test-utils";

/**
 * `DocumentFieldMapper.translateQuery` (the non-grouped path of document
 * adapters) maps `@db.column` renames on every field-path position — filter
 * keys, `$select` (array, inclusion and exclusion forms) and `$sort` — and
 * rows come back under the logical names. A document renames the TOP-LEVEL
 * key only, so a dotted path under a renamed object renames its first segment.
 */

let DocRename: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ DocRename } = await import("./fixtures/doc-renames.as"));
});

function nested() {
  let adapter!: NestedMockAdapter;
  const db = new DbSpace(() => (adapter = new NestedMockAdapter()));
  const table = db.getTable(DocRename) as AtscriptDbTable;
  table.getMetadata();
  return { table, adapter };
}

function sent(adapter: NestedMockAdapter, method: string): DbQuery {
  const call = adapter.calls.find((c) => c.method === method);
  expect(call).toBeDefined();
  return call!.args[0] as DbQuery;
}

describe("DocumentFieldMapper.translateQuery — @db.column renames", () => {
  it("maps array-form $select names, incl. a dotted path under a renamed object", () => {
    const { table } = nested();
    const q = new DocumentFieldMapper().translateQuery(
      { filter: {}, controls: { $select: ["id", "renamedAt", "profile.bio"] } },
      table.getMetadata(),
    );
    expect(q.controls.$select!.asArray).toEqual(["id", "opened_on", "prof.bio"]);
    expect(q.controls.$select!.asProjection).toEqual({ id: 1, opened_on: 1, "prof.bio": 1 });
  });

  it("maps object-form $select keys (inclusion)", () => {
    const { table } = nested();
    const q = new DocumentFieldMapper().translateQuery(
      { filter: {}, controls: { $select: { renamedAt: 1, profile: 1 } } },
      table.getMetadata(),
    );
    expect(q.controls.$select!.asProjection).toEqual({ opened_on: 1, prof: 1 });
  });

  it("maps object-form $select keys (exclusion) and inverts over physical names", () => {
    const { table } = nested();
    const meta = table.getMetadata();
    const stored = ["prof", "prof.bio", "address", "address.city", "address.zip", "cnt"];
    expect(meta.allPhysicalFields).toEqual(["id", "title", "opened_on", ...stored]);
    const q = new DocumentFieldMapper().translateQuery(
      { filter: {}, controls: { $select: { renamedAt: 0 } } },
      meta,
    );
    expect(q.controls.$select!.asProjection).toEqual({ opened_on: 0 });
    expect(q.controls.$select!.asArray).toEqual(["id", "title", ...stored]);
  });

  it("maps $sort keys ascending and descending, preserving key order", () => {
    const { table } = nested();
    const mapper = new DocumentFieldMapper();
    const meta = table.getMetadata();
    const asc = mapper.translateQuery({ filter: {}, controls: { $sort: { renamedAt: 1 } } }, meta);
    expect(asc.controls.$sort).toEqual({ opened_on: 1 });
    const mixed = mapper.translateQuery(
      { filter: {}, controls: { $sort: { renamedAt: -1, "profile.bio": 1, id: 1 } } },
      meta,
    );
    expect(Object.entries(mixed.controls.$sort!)).toEqual([
      ["opened_on", -1],
      ["prof.bio", 1],
      ["id", 1],
    ]);
  });

  it("maps a dotted filter key under a renamed object", () => {
    const { table } = nested();
    const q = new DocumentFieldMapper().translateQuery(
      { filter: { "profile.bio": "x", renamedAt: { $gt: 1 } }, controls: {} },
      table.getMetadata(),
    );
    expect(q.filter).toEqual({ "prof.bio": "x", opened_on: { $gt: 1 } });
  });

  it("leaves other controls untouched and drops $with", () => {
    const { table } = nested();
    const q = new DocumentFieldMapper().translateQuery(
      { filter: {}, controls: { $limit: 5, $skip: 2, $count: true } },
      table.getMetadata(),
    );
    expect(q.controls).toEqual({ $limit: 5, $skip: 2, $count: true });
  });
});

describe("AtscriptDbTable over a document adapter — renamed fields end to end", () => {
  it("findMany sends physical $select / $sort and reverse-maps rows", async () => {
    const { table, adapter } = nested();
    adapter.store.set("doc_renames", [
      { id: 1, title: "a", opened_on: 20, prof: { bio: "x" } },
      { id: 2, title: "b", opened_on: 10, prof: { bio: "y" } },
    ]);
    const rows = await table.findMany({
      filter: {},
      controls: { $select: ["id", "renamedAt", "profile"], $sort: { renamedAt: -1 } },
    });
    const q = sent(adapter, "findMany");
    expect(q.controls.$select!.asProjection).toEqual({ id: 1, opened_on: 1, prof: 1 });
    // the primary-key tie-breaker follows the last key (since 0.1.153)
    expect(q.controls.$sort).toEqual({ opened_on: -1, id: -1 });
    // The mock ignores projection — the point is the logical keys on read.
    expect(rows[0]).toEqual({ id: 1, title: "a", renamedAt: 20, profile: { bio: "x" } });
    expect(rows[0]).not.toHaveProperty("opened_on");
    expect(rows[0]).not.toHaveProperty("prof");
  });

  it("findManyWithCount goes through the same translation", async () => {
    const { table, adapter } = nested();
    adapter.store.set("doc_renames", [{ id: 1, title: "a", opened_on: 5 }]);
    const res = await table.findManyWithCount({
      filter: { renamedAt: 5 },
      controls: { $select: { renamedAt: 1 }, $sort: { renamedAt: 1 }, $limit: 10 },
    });
    const q = sent(adapter, "findMany");
    expect(q.filter).toEqual({ opened_on: 5 });
    expect(q.controls.$select!.asProjection).toEqual({ opened_on: 1 });
    expect(q.controls.$sort).toEqual({ opened_on: 1, id: 1 });
    expect(res.count).toBe(1);
    expect(res.data).toEqual([{ id: 1, title: "a", renamedAt: 5 }]);
  });

  it("the grouped path maps a dotted $groupBy / $sort under a renamed object too", async () => {
    const { table, adapter } = nested();
    adapter.aggregateResult = [{ prof: { bio: "x" }, n: 2 }];
    await table.aggregate({
      filter: {},
      controls: {
        $select: ["profile.bio", { $fn: "count", $field: "*", $as: "n" }],
        $groupBy: ["profile.bio"],
        $sort: { "profile.bio": 1, n: -1 },
      },
    } as any);
    const q = sent(adapter, "aggregate");
    expect(q.controls.$groupBy).toEqual(["prof.bio"]);
    expect(q.controls.$select!.asArray).toEqual(["prof.bio"]);
    expect(q.controls.$sort).toEqual({ "prof.bio": 1, n: -1 });
  });
});

describe("a nested-leaf @db.column on a document adapter renames nothing (since 0.1.137)", () => {
  it("metadata: no columnMap entry, descriptor / index / documentPath on the stored path", () => {
    const { table } = nested();
    const meta = table.getMetadata();
    expect(meta.columnMap.has("address.zip")).toBe(false);
    expect([...meta.columnMap]).toEqual([
      ["renamedAt", "opened_on"],
      ["profile", "prof"],
      ["visits", "cnt"],
    ]);
    expect(meta.documentPath("address.zip")).toBe("address.zip");
    const fd = meta.descriptorByPath.get("address.zip")!;
    expect(fd.physicalName).toBe("address.zip");
    // `@db.column.renamed` on a nested leaf is no rename either — sync sees no change
    expect(fd.renamedFrom).toBeUndefined();
    expect(table.indexes.get("atscript__plain__zip_idx")!.fields.map((f) => f.name)).toEqual([
      "address.zip",
    ]);
  });

  it("view sources: the stored path on documents, the flattened rename on relational", () => {
    // One layout index serves both families — only the document read ignores the leaf rename
    expect(resolveViewSource(DocRename, "address.zip", true).column).toBe("address.zip");
    expect(resolveViewSource(DocRename, "address.zip", false).column).toBe("address__zip_code");
    expect(resolveViewSource(DocRename, "profile.bio", true).column).toBe("prof.bio");
  });

  it("filter, $select, $sort address the stored path", () => {
    const { table } = nested();
    const q = new DocumentFieldMapper().translateQuery(
      {
        filter: { "address.zip": "75001", $or: [{ "address.zip": { $in: ["1", "2"] } }] },
        controls: { $select: ["address.zip", "address"], $sort: { "address.zip": -1 } },
      },
      table.getMetadata(),
    );
    expect(q.filter).toEqual({
      "address.zip": "75001",
      $or: [{ "address.zip": { $in: ["1", "2"] } }],
    });
    expect(q.controls.$select!.asArray).toEqual(["address.zip", "address"]);
    expect(q.controls.$sort).toEqual({ "address.zip": -1 });
  });

  it("the grouped path groups, selects and aggregates on the stored path", async () => {
    const { table, adapter } = nested();
    await table.aggregate({
      filter: { "address.zip": { $exists: true } },
      controls: {
        $select: ["address.zip", { $fn: "count", $field: "address.zip", $as: "n" }],
        $groupBy: ["address.zip"],
        $sort: { "address.zip": 1 },
      },
    } as any);
    const q = sent(adapter, "aggregate");
    expect(q.filter).toEqual({ "address.zip": { $exists: true } });
    expect(q.controls.$groupBy).toEqual(["address.zip"]);
    expect(q.controls.$select!.asArray).toEqual(["address.zip"]);
    expect(q.controls.$select!.aggregates).toEqual([
      { $fn: "count", $field: "address.zip", $as: "n" },
    ]);
    expect(q.controls.$sort).toEqual({ "address.zip": 1 });
  });

  it("writes and reads keep the nested leaf where it is stored", async () => {
    const { table, adapter } = nested();
    await table.insertOne({ id: 1, title: "a", address: { city: "Paris", zip: "75001" } });
    expect(adapter.calls.find((c) => c.method === "insertMany")!.args[0]).toEqual([
      { id: 1, title: "a", address: { city: "Paris", zip: "75001" } },
    ]);
    // A top-level `zip_code` key is not the nested leaf — it is not reverse-mapped
    adapter.store.set("doc_renames", [
      { id: 2, title: "b", address: { zip: "1" }, zip_code: "other" },
    ]);
    const rows = await table.findMany({ filter: {}, controls: {} });
    expect(rows[0]).toEqual({ id: 2, title: "b", address: { zip: "1" }, zip_code: "other" });
  });
});

describe("fields under a renamed top-level object (since 0.1.137)", () => {
  it("descriptor physicalName and index field use the document path", () => {
    const { table } = nested();
    const meta = table.getMetadata();
    expect(meta.descriptorByPath.get("profile.bio")!.physicalName).toBe("prof.bio");
    expect(meta.physicalPath("profile.bio")).toBe("prof.bio");
    expect(table.indexes.get("atscript__plain__bio_idx")!.fields.map((f) => f.name)).toEqual([
      "prof.bio",
    ]);
  });
});

describe("document patch keys follow documentPath (since 0.1.137)", () => {
  it("a decomposed merge patch under a renamed object renames the first segment", async () => {
    const { table, adapter } = nested();
    await table.updateMany({ id: 1 }, { profile: { bio: "x" }, address: { zip: "2" } } as any);
    const [, data] = adapter.calls.find((c) => c.method === "updateMany")!.args;
    expect(data).toEqual({ "prof.bio": "x", address: { zip: "2" } });
  });

  it("$inc / $mul field ops target the physical key", async () => {
    const { table, adapter } = nested();
    await table.updateMany({ id: 1 }, { visits: { $inc: 2 } } as any);
    const [, , ops] = adapter.calls.find((c) => c.method === "updateMany")!.args;
    expect(ops.inc).toEqual({ cnt: 2 });
  });
});
