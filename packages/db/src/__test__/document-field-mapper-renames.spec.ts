import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DocumentFieldMapper } from "../strategies/field-mapping";
import { DbSpace } from "../table/db-space";
import type { AtscriptDbTable } from "../table/db-table";
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
    expect(meta.allPhysicalFields).toEqual(["id", "title", "opened_on", "prof", "prof.bio"]);
    const q = new DocumentFieldMapper().translateQuery(
      { filter: {}, controls: { $select: { renamedAt: 0 } } },
      meta,
    );
    expect(q.controls.$select!.asProjection).toEqual({ opened_on: 0 });
    expect(q.controls.$select!.asArray).toEqual(["id", "title", "prof", "prof.bio"]);
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
    expect(q.controls.$sort).toEqual({ opened_on: -1 });
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
    expect(q.controls.$sort).toEqual({ opened_on: 1 });
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
