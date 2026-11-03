import { UniquSelect, type DbControls, type DbSpace } from "@atscript/db";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { AL_ROWS } from "../../../../db/test-kit/aggregate-levels-cases";
import { aggregateRows } from "../memory-aggregate";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Edge cases of the in-memory engine for countDistinct over a field list,
// conditional aggregates (`$where`) and two-level aggregates (`$from`), since
// 0.1.168. The shared behaviour table is aggregate-levels.spec.ts.

/** Adapter-level controls (a `UniquSelect` over physical paths) for {@link aggregateRows}. */
function controls(
  select: unknown[],
  groupBy: string[],
  extra: Record<string, unknown> = {},
  computed?: ConstructorParameters<typeof UniquSelect>[3],
): DbControls {
  return {
    $select: new UniquSelect(select as never, undefined, undefined, computed),
    $groupBy: groupBy,
    ...extra,
  } as DbControls;
}

const pairs = (where?: object) => ({
  $fn: "countDistinct",
  $field: ["a", "b"],
  $as: "d",
  ...(where && { $where: where }),
});

describe("aggregateRows — countDistinct over a field list", () => {
  it("tells combinations apart by type-tagged identity (1 vs '1', true vs 'true')", () => {
    const rows = [
      { a: 1, b: "x" },
      { a: "1", b: "x" },
      { a: 1, b: "x" },
      { a: 1n, b: "x" }, // a bigint of one value is the number's identity
      { a: true, b: 1 },
      { a: "true", b: 1 },
      { a: new Date(5), b: { k: 1, j: 2 } },
      { a: new Date(5), b: { j: 2, k: 1 } }, // one instant, one JSON value
    ];
    expect(aggregateRows(rows, controls([pairs()], []))).toEqual([{ d: 5 }]);
  });

  it("never lets one field's token forge a separator into the next field", () => {
    // without length prefixes "s1" + "s2:3" and "s1:2" + "s3" could read alike
    const rows = [
      { a: "1", b: "2:3" },
      { a: "1:2", b: "3" },
      { a: "1|2", b: "3" },
      { a: "1", b: "2|3" },
    ];
    expect(aggregateRows(rows, controls([pairs()], []))).toEqual([{ d: 4 }]);
  });

  it("skips a row where ANY listed field is null or missing", () => {
    const rows = [{ a: 1, b: 2 }, { a: 1, b: null }, { a: 1 }, { b: 2 }, { a: null, b: null }, {}];
    expect(aggregateRows(rows, controls([pairs()], []))).toEqual([{ d: 1 }]);
  });

  it("reads nested paths and counts per group", () => {
    const rows = [
      { g: "x", s: { c: "Oslo" }, p: 1 },
      { g: "x", s: { c: "Oslo" }, p: 1 },
      { g: "x", s: { c: "Oslo" }, p: 2 },
      { g: "y", s: {}, p: 2 },
    ];
    const select = ["g", { $fn: "countDistinct", $field: ["s.c", "p"], $as: "d" }];
    expect(aggregateRows(rows, controls(select, ["g"]))).toEqual([
      { g: "x", d: 2 },
      { g: "y", d: 0 },
    ]);
  });
});

describe("aggregateRows — conditional aggregates", () => {
  const rows = [
    { k: "a", v: 1, s: "paid" },
    { k: "a", v: null, s: "paid" },
    { k: "a", v: 5, s: "open" },
    { k: "a", v: 2, s: null },
    { k: "a", v: 2 },
  ];

  it("restricts every accumulator to the matching rows (SQL FILTER semantics)", () => {
    const paid = { s: "paid" };
    const select = [
      { $fn: "count", $field: "*", $where: paid, $as: "n" },
      { $fn: "count", $field: "v", $where: paid, $as: "nv" },
      { $fn: "sum", $field: "v", $where: paid, $as: "s" },
      { $fn: "avg", $field: "v", $where: paid, $as: "a" },
      { $fn: "min", $field: "v", $where: { s: "open" }, $as: "lo" },
      { $fn: "max", $field: "v", $where: { s: null }, $as: "hi" },
      { $fn: "countDistinct", $field: "v", $where: { s: null }, $as: "dv" },
      pairs({ s: "void" }),
      { $fn: "sum", $field: "v", $where: { s: "void" }, $as: "none" },
      { $fn: "count", $field: "*", $where: { v: { $gt: 1 } }, $as: "big" },
    ];
    expect(aggregateRows(rows, controls(select, []))).toEqual([
      { n: 2, nv: 1, s: 1, a: 1, lo: 5, hi: 2, dv: 1, d: 0, none: null, big: 3 },
    ]);
  });

  it("conditions a row-level expression aggregate", () => {
    const out = aggregateRows(
      rows,
      controls(
        [],
        [],
        {},
        {
          exprAggregates: [
            {
              fn: "sum",
              alias: "x",
              expr: { op: "*", args: [{ field: "v" }, 10] } as never,
              names: ["v"],
              where: { s: { $in: ["paid", "open"] } },
            },
            {
              fn: "sum",
              alias: "none",
              expr: { op: "*", args: [{ field: "v" }, 10] } as never,
              names: ["v"],
              where: { s: "void" },
            },
          ],
        },
      ),
    );
    expect(out).toEqual([{ x: 60, none: null }]);
  });

  it("an ungrouped conditional aggregate over no rows is one row: counts 0, others null", () => {
    const select = [
      { $fn: "count", $field: "*", $where: { s: "paid" }, $as: "n" },
      { $fn: "sum", $field: "v", $where: { s: "paid" }, $as: "s" },
      pairs({ s: "paid" }),
    ];
    expect(aggregateRows([], controls(select, []))).toEqual([{ n: 0, s: null, d: 0 }]);
  });
});

describe("aggregateRows — two-level aggregates ($from)", () => {
  const inner = controls(["g", "c", { $fn: "sum", $field: "v", $as: "t" }], ["g", "c"]);
  const rows = [
    { g: "x", c: 1, v: 1 },
    { g: "x", c: 1, v: 2 },
    { g: "x", c: 2, v: 10 },
    { g: "y", c: 3, v: 4 },
  ];

  it("aggregates the inner level's rows", () => {
    const outer = controls(
      ["g", { $fn: "count", $field: "*", $as: "n" }, { $fn: "max", $field: "t", $as: "top" }],
      ["g"],
      { $from: inner, $sort: { g: 1 } },
    );
    expect(aggregateRows(rows, outer)).toEqual([
      { g: "x", n: 2, top: 10 },
      { g: "y", n: 1, top: 4 },
    ]);
  });

  it("ungrouped over zero inner rows still yields one row (an inner $having removed them all)", () => {
    const outer = controls(
      [
        { $fn: "count", $field: "*", $as: "n" },
        { $fn: "sum", $field: "t", $as: "s" },
      ],
      [],
      { $from: { ...inner, $having: { t: { $gt: 100 } } } },
    );
    expect(aggregateRows(rows, outer)).toEqual([{ n: 0, s: null }]);
    expect(aggregateRows(rows, { ...outer, $count: true })).toEqual([{ count: 1 }]);
  });

  it("orders first() by $rowOrder, the inner $groupBy columns breaking ties", () => {
    const outer = controls(
      ["g", { $fn: "first", $field: "c", $as: "f" }],
      ["g"],
      {},
      {
        rowOrder: [
          { column: "t", desc: false },
          { column: "g", desc: false },
          { column: "c", desc: true },
        ],
      },
    );
    // inner t: c1 = 2, c2 = 2, c3 = 5 — c1 and c2 tie on t, the tie-breaker (c desc) picks 2
    const tied = [
      { g: "x", c: 1, v: 2 },
      { g: "x", c: 2, v: 1 },
      { g: "x", c: 2, v: 1 },
      { g: "x", c: 3, v: 5 },
    ];
    expect(aggregateRows(tied, { ...outer, $from: inner })).toEqual([{ g: "x", f: 2 }]);
  });
});

describe("memory — the NULL nested group key", () => {
  let space: DbSpace;
  let fx: Record<string, any>;

  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/agg-levels.as");
    space = createTestSpace();
    await space.getTable(fx.AlSale).insertMany(AL_ROWS as never);
  });

  // `nullNestedKey` of aggregate-levels.spec.ts: what single-level grouping returns
  it("single-level grouping by shipping.city returns { shipping: { city: null } }", async () => {
    const rows = await space.getTable(fx.AlSale).aggregate({
      filter: { id: { $in: [4, 9] } },
      controls: { $groupBy: ["shipping.city"], $select: ["shipping.city"] },
    } as never);
    expect(rows).toEqual([{ shipping: { city: null } }]);
  });
});
