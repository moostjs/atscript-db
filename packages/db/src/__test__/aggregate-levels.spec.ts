import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { collectQueryPaths } from "../query/query-guards";
import { checkAggregateControls } from "../query/nested-aggregate";
import { queryReadColumns } from "../query/read-columns";
import { ALL_AGGREGATE_FNS } from "../query/aggregate-fns";
import { AtscriptDbTable } from "../table/db-table";
import { DbSpace } from "../table/db-space";
import { DbError } from "../db-error";
import type { DbQuery } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * countDistinct over a field list, conditional aggregates (`$where`) and
 * two-level aggregates (`$from`) in the core (since 0.1.168): the fail-closed
 * capabilities, the rules a condition and each listed field meet (the
 * filter's / the aggregate field's: encryption, strict mode, quantity refs),
 * the two-level resolution, path collection and the mapper's physical
 * hand-off (`@db.column` renames, translated conditions, the inner level
 * listing every inner column).
 */

const KEYS = { k1: randomBytes(32) };

class LevelsAdapter extends MockAdapter {
  override aggregateFns() {
    return ALL_AGGREGATE_FNS;
  }
  override supportsAggregateExpressions() {
    return true;
  }
  override supportsConditionalAggregates() {
    return true;
  }
  override supportsDistinctFieldLists() {
    return true;
  }
  override supportsNestedAggregates() {
    return true;
  }
  override calendarBucketUnits() {
    return new Set(["day", "month"] as const);
  }
}

let M: any;

beforeAll(async () => {
  await prepareFixtures();
  M = await import("./fixtures/agg-exprs.as");
});

function bind(make: () => MockAdapter, type: "ExprIssue" | "ExprStrict" = "ExprIssue") {
  const adapters: MockAdapter[] = [];
  const db = new DbSpace(
    () => {
      const a = make();
      adapters.push(a);
      return a;
    },
    { encryption: { defaultKeyId: "k1", keys: KEYS } },
  );
  const table = db.getTable(M[type]) as AtscriptDbTable;
  table.getMetadata();
  return { table, adapter: adapters[adapters.length - 1]! };
}

const levels = (type: "ExprIssue" | "ExprStrict" = "ExprIssue") =>
  bind(() => new LevelsAdapter(), type);

const sent = (adapter: MockAdapter) =>
  adapter.calls.find((c) => c.method === "aggregate")!.args[0] as DbQuery;

async function rejects(promise: Promise<unknown>, code: string, message?: RegExp) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe(code);
  if (message) expect(JSON.stringify((error as DbError).errors)).toMatch(message);
  return error as DbError;
}

const agg = (table: AtscriptDbTable, controls: object, filter: object = {}) =>
  table.aggregate({ filter, controls } as never);

describe("fail-closed capabilities", () => {
  it("an adapter without them rejects a condition, a field list and $from before dispatch", async () => {
    const { table, adapter } = bind(() => new MockAdapter());
    await rejects(
      agg(table, {
        $groupBy: ["status"],
        $select: [{ $fn: "sum", $field: "price", $where: { qty: 1 }, $as: "p" }],
      }),
      "AGG_WHERE_NOT_SUPPORTED",
    );
    await rejects(
      agg(table, {
        $groupBy: ["status"],
        $select: [{ $fn: "countDistinct", $field: ["ticketId", "status"], $as: "p" }],
      }),
      "AGG_FIELD_LIST_NOT_SUPPORTED",
    );
    await rejects(
      agg(table, {
        $from: { $groupBy: ["status"] },
        $select: [{ $fn: "count", $field: "*", $as: "n" }],
      }),
      "AGG_NESTED_NOT_SUPPORTED",
    );
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });
});

describe("the rules a condition and each listed field meet", () => {
  it("an encrypted field in a condition is ENC_FIELD_FILTER, in a field list ENC_FIELD_AGG", async () => {
    const { table } = levels();
    await rejects(
      agg(table, {
        $groupBy: ["status"],
        $select: [{ $fn: "count", $field: "*", $where: { secretScore: 1 }, $as: "n" }],
      }),
      "ENC_FIELD_FILTER",
    );
    await rejects(
      agg(table, {
        $groupBy: ["status"],
        $select: [{ $fn: "countDistinct", $field: ["status", "secretScore"], $as: "n" }],
      }),
      "ENC_FIELD_AGG",
    );
  });

  it("a condition value that cannot denote its field's type is rejected like a filter value", async () => {
    const { table } = levels();
    const filter = await rejects(
      agg(table, { $groupBy: ["status"] }, { price: "x" }),
      "INVALID_QUERY",
    );
    const where = await rejects(
      agg(table, {
        $groupBy: ["status"],
        $select: [{ $fn: "count", $field: "*", $where: { price: "x" }, $as: "n" }],
      }),
      "INVALID_QUERY",
    );
    expect(where.errors).toEqual(filter.errors);
  });

  it("strict mode checks each listed field; quantity refs each listed field", async () => {
    const strict = levels("ExprStrict").table;
    await agg(strict, {
      $groupBy: ["status"],
      $select: [{ $fn: "countDistinct", $field: ["status", "price"], $as: "n" }],
    });
    await rejects(
      agg(strict, {
        $groupBy: ["status"],
        $select: [{ $fn: "countDistinct", $field: ["status", "id"], $as: "n" }],
      }),
      "INVALID_QUERY",
      /Aggregate field \\"id\\" is not a dimension or measure/,
    );
    await rejects(
      agg(levels().table, {
        $groupBy: ["status"],
        $select: [{ $fn: "countDistinct", $field: ["weight", "status"], $as: "n" }],
      }),
      "INVALID_QUERY",
      /countDistinct\(weight, status\)\\" requires \\"unit\\" in \$groupBy/,
    );
  });

  it("the inner level of $from meets every rule of a standalone grouped query", async () => {
    await rejects(
      agg(levels().table, {
        $from: { $groupBy: ["secretScore"], $select: [{ $fn: "count", $field: "*", $as: "n" }] },
        $select: [{ $fn: "sum", $field: "n", $as: "t" }],
      }),
      "ENC_FIELD_AGG",
    );
    await rejects(
      agg(levels("ExprStrict").table, {
        $from: { $groupBy: ["qty"], $select: [{ $fn: "count", $field: "*", $as: "n" }] },
        $select: [{ $fn: "sum", $field: "n", $as: "t" }],
      }),
      "INVALID_QUERY",
      /Field \\"qty\\" is not a dimension/,
    );
  });

  it("an outer level over a strict table's inner level may group by an inner alias", async () => {
    const { table, adapter } = levels("ExprStrict");
    await agg(table, {
      $from: { $groupBy: ["status"], $select: [{ $fn: "sum", $field: "price", $as: "total" }] },
      $groupBy: ["total"],
      $select: ["total", { $fn: "count", $field: "*", $as: "n" }],
    });
    expect(sent(adapter).controls.$groupBy).toEqual(["total"]);
  });
});

describe("the mapper's physical hand-off", () => {
  it("renames listed fields and translates a condition like the filter", async () => {
    const { table, adapter } = levels();
    await agg(table, {
      $groupBy: ["status"],
      $select: [
        "status",
        { $fn: "countDistinct", $field: ["estimate", "status"] },
        { $fn: "sum", $field: "price", $where: { estimate: { $gt: 2 } }, $as: "p" },
        {
          $fn: "sum",
          $expr: { $op: "*", $args: ["price", "qty"] },
          $where: { estimate: null },
          $as: "v",
        },
      ],
    });
    const select = sent(adapter).controls.$select!;
    expect(select.aggregates).toEqual([
      {
        $fn: "countDistinct",
        $field: ["est_points", "status"],
        $as: "countDistinct_estimate_status",
      },
      { $fn: "sum", $field: "price", $where: { est_points: { $gt: 2 } }, $as: "p" },
    ]);
    expect(select.exprAggregates![0].where).toEqual({ est_points: null });
  });

  it("hands a two-level aggregate over with every inner column listed and outer names mapped", async () => {
    const { table, adapter } = levels();
    await agg(
      table,
      {
        $from: {
          $groupBy: ["status", "estimate"],
          $select: [
            { $fn: "sum", $field: "price", $as: "spent" },
            { $fn: "max", $field: "raisedAt", $as: "lastAt" },
          ],
        },
        $groupBy: ["estimate", "lastDay"],
        $select: [
          "estimate",
          { $bucket: "day", $field: "lastAt", $as: "lastDay" },
          { $fn: "avg", $field: "spent", $where: { estimate: { $gt: 1 } }, $as: "avg" },
          { $fn: "first", $field: "status", $as: "top" },
        ],
        $rowOrder: { spent: -1 },
        $having: { avg: { $gt: 0 } },
        $sort: { estimate: 1, avg: -1 },
      },
      { qty: 1 },
    );
    const q = sent(adapter);
    expect(q.filter).toEqual({ qty: 1 });
    const inner = q.controls.$from!;
    expect(inner.$groupBy).toEqual(["status", "est_points"]);
    expect(inner.$select!.asArray).toEqual(["status", "est_points"]);
    expect(inner.$select!.computedAliases).toEqual(["spent", "lastAt"]);
    expect(q.controls.$groupBy).toEqual(["est_points", "lastDay"]);
    expect(q.controls.$select!.asArray).toEqual(["est_points"]);
    expect(q.controls.$select!.buckets).toMatchObject([
      { alias: "lastDay", field: "lastAt", unit: "day", fd: { path: "raisedAt" } },
    ]);
    expect(q.controls.$select!.aggregates).toEqual([
      { $fn: "avg", $field: "spent", $where: { est_points: { $gt: 1 } }, $as: "avg" },
    ]);
    // first() reads inner rows ordered by $rowOrder, then by every inner $groupBy column
    expect(q.controls.$select!.rowOrder).toEqual([
      { column: "spent", desc: true },
      { column: "status", desc: false },
      { column: "est_points", desc: false },
    ]);
    expect(q.controls.$having).toEqual({ avg: { $gt: 0 } });
    expect(q.controls.$sort).toEqual({ est_points: 1, avg: -1 });
  });

  it("returns the outer rows with inner keys under their logical names", async () => {
    const { table, adapter } = levels();
    adapter.aggregateResult = [{ est_points: 3, n: 2 }];
    expect(
      await agg(table, {
        $from: { $groupBy: ["estimate"], $select: [{ $fn: "count", $field: "*", $as: "c" }] },
        $groupBy: ["estimate"],
        $select: ["estimate", { $fn: "count", $field: "*", $as: "n" }],
      }),
    ).toEqual([{ estimate: 3, n: 2 }]);
  });
});

describe("paths, controls and read columns", () => {
  it("collectQueryPaths lists a condition's keys as filter entries and reads $from's inner level", () => {
    const refs = collectQueryPaths(
      {
        filter: { qty: 1 },
        controls: {
          $groupBy: ["status"],
          $select: [
            {
              $fn: "count",
              $field: "*",
              $where: { price: { $gt: 1 }, flag: { $exists: true } },
              $as: "n",
            },
            { $fn: "countDistinct", $field: ["a", "b"], $as: "d" },
          ],
        },
      },
      true,
    );
    expect(refs.filter.map((r) => [r.path, r.predicate])).toEqual([
      ["qty", "compare"],
      ["price", "compare"],
      ["flag", "exists"],
    ]);
    expect(refs.aggregate).toEqual(["a", "b"]);

    const nested = collectQueryPaths({
      filter: { qty: 1 },
      controls: {
        $from: {
          $groupBy: ["status"],
          $select: [{ $fn: "sum", $field: "price", $where: { flag: true }, $as: "s" }],
        },
        $groupBy: ["s"],
        $select: ["s", { $fn: "count", $field: "*", $where: { ghost: 1 }, $as: "n" }],
        $sort: { nope: 1 },
      },
    });
    expect(nested.nested).toBe(true);
    expect(nested.groupBy).toEqual(["status"]);
    expect(nested.aggregate).toEqual(["price"]);
    expect(nested.filter.map((r) => r.path)).toEqual(["qty", "flag"]);
    expect(nested.sort).toEqual([]);
  });

  it("checkAggregateControls refuses unknown controls and a non-empty $with", () => {
    expect(() =>
      checkAggregateControls({ $groupBy: [], $limit: 1, $from: {}, $with: [] }),
    ).not.toThrow();
    expect(() => checkAggregateControls({ $groupBy: [], $vector: "x" })).toThrow(
      /Unknown aggregate control "\$vector"/,
    );
    expect(() => checkAggregateControls({ $groupBy: [], $with: [{ name: "r" }] })).toThrow(
      /\$with/,
    );
  });

  it("queryReadColumns reads a condition's columns and the inner level's", async () => {
    const { table, adapter } = levels();
    await agg(table, {
      $groupBy: ["status"],
      $select: [{ $fn: "count", $field: "*", $where: { estimate: 1 }, $as: "n" }],
    });
    expect([...queryReadColumns(sent(adapter), "aggregate")!]).toEqual(
      expect.arrayContaining(["status", "est_points"]),
    );
    const nested = levels();
    await agg(nested.table, {
      $from: { $groupBy: ["ticketId"], $select: [{ $fn: "sum", $field: "price", $as: "s" }] },
      $select: [{ $fn: "avg", $field: "s", $as: "a" }],
    });
    expect(new Set(queryReadColumns(sent(nested.adapter), "aggregate"))).toEqual(
      new Set(["ticketId", "price"]),
    );
  });
});
