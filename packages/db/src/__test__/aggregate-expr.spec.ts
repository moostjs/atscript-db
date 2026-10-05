import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { evaluateExpr } from "../query/query-tree";
import { arithToExprNode, numericOperandProblem } from "../query/aggregate-expr";
import { numericTypeProblem } from "../shared/numeric-operand";
import { collectQueryPaths } from "../query/query-guards";
import { ALL_AGGREGATE_FNS, BASE_AGGREGATE_FNS } from "../query/aggregate-fns";
import { AtscriptDbTable } from "../table/db-table";
import { DbSpace } from "../table/db-space";
import { DbError } from "../db-error";
import type { DbQuery } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * Query-time arithmetic and first / last in `aggregate()` (since 0.1.148):
 * the shared evaluator, the core's schema-dependent rules (numeric operands,
 * numeric aliases, scalar first / last, strict mode, quantity refs), the
 * fail-closed capability, path collection and the mapper's physical hand-off.
 */

const KEYS = { k1: randomBytes(32) };

class ExprAdapter extends MockAdapter {
  override aggregateFns() {
    return ALL_AGGREGATE_FNS;
  }
  override supportsAggregateExpressions() {
    return true;
  }
}

let M: any;

beforeAll(async () => {
  await prepareFixtures();
  M = await import("./fixtures/agg-exprs.as");
});

function bind<A extends MockAdapter>(
  make: () => A,
  type: "ExprIssue" | "ExprStrict" = "ExprIssue",
) {
  const adapters: A[] = [];
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

const supported = (type: "ExprIssue" | "ExprStrict" = "ExprIssue") =>
  bind(() => new ExprAdapter(), type);

async function rejection(p: Promise<unknown>): Promise<DbError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(DbError);
    return error as DbError;
  }
  throw new Error("expected a rejection");
}

const sent = (adapter: MockAdapter): DbQuery =>
  adapter.calls.find((c) => c.method === "aggregate")!.args[0] as DbQuery;

const messages = (e: DbError) => e.errors.map((x) => x.message);

/** A grouped query by ticket with the given extra `$select` entries and controls. */
const grouped = (select: unknown[], extra: Record<string, unknown> = {}) => ({
  filter: {},
  controls: { $groupBy: ["ticketId"], $select: ["ticketId", ...select], ...extra } as any,
});

describe("evaluateExpr — the shared evaluator", () => {
  const f = { field: "a" };
  const g = { field: "b" };
  const leaf = (row: Record<string, unknown>) => (name: string) => row[name];

  it("computes + - * / and unary minus in double", () => {
    expect(evaluateExpr({ op: "/", args: [7, 2] }, leaf({}))).toBe(3.5);
    expect(
      evaluateExpr({ op: "+", args: [f, { op: "*", args: [g, 10] }] }, leaf({ a: 1, b: 2 })),
    ).toBe(21);
    expect(evaluateExpr({ op: "neg", args: [f] }, leaf({ a: 4 }))).toBe(-4);
    expect(evaluateExpr({ op: "-", args: [f, g] }, leaf({ a: 1, b: 3 }))).toBe(-2);
  });

  it("propagates null / undefined and divides by zero to null", () => {
    expect(evaluateExpr({ op: "+", args: [f, 1] }, leaf({ a: null }))).toBeNull();
    expect(evaluateExpr({ op: "*", args: [f, g] }, leaf({ a: 2 }))).toBeNull();
    expect(evaluateExpr({ op: "/", args: [1, 0] }, leaf({}))).toBeNull();
    expect(evaluateExpr({ op: "/", args: [f, g] }, leaf({ a: 1, b: 0 }))).toBeNull();
  });

  it("coalesce returns the first non-null operand", () => {
    expect(evaluateExpr({ op: "coalesce", args: [f, g, 9] }, leaf({ a: null, b: 5 }))).toBe(5);
    expect(evaluateExpr({ op: "coalesce", args: [f, 9] }, leaf({}))).toBe(9);
    expect(evaluateExpr({ op: "coalesce", args: [f, g] }, leaf({}))).toBeNull();
  });

  it("Number()s a numeric-looking leaf", () => {
    expect(evaluateExpr({ op: "+", args: [f, 1] }, leaf({ a: "2" }))).toBe(3);
  });
});

describe("arithToExprNode", () => {
  it("names become field leaves, unary - becomes neg, coalesce keeps all arguments", () => {
    expect(
      arithToExprNode({
        $op: "+",
        $args: [
          { $op: "-", $args: ["a"] },
          { $op: "coalesce", $args: ["b", "c", 0] },
        ],
      }),
    ).toEqual({
      op: "+",
      args: [
        { op: "neg", args: [{ field: "a" }] },
        { op: "coalesce", args: [{ field: "b" }, { field: "c" }, 0] },
      ],
    });
  });

  it("renames every leaf and keeps the shape", () => {
    expect(arithToExprNode({ $op: "*", $args: ["price", "qty"] }, (n) => `p_${n}`)).toEqual({
      op: "*",
      args: [{ field: "p_price" }, { field: "p_qty" }],
    });
  });
});

describe("numericOperandProblem — what may be an operand", () => {
  const fd = (name: string) => {
    const { table } = supported();
    return table.getMetadata().descriptorByPath.get(name)!;
  };

  it("accepts plain numbers, renamed columns and optional numbers", () => {
    for (const name of ["price", "qty", "estimate", "severity", "weight", "ticketId"]) {
      expect(numericOperandProblem(fd(name))).toBeUndefined();
    }
  });

  it.each([
    ["title", "is a string"],
    ["flag", "is a boolean"],
    ["cost", "is a decimal"],
    ["raisedAt", "is a timestamp"],
    ["secretScore", "is encrypted"],
  ])("rejects %s (%s)", (name, why) => {
    expect(numericOperandProblem(fd(name))).toBe(why);
  });
});

describe("numericTypeProblem — the rule @db.compute shares", () => {
  it("accepts number and integer, rejects the rest and timestamp-tagged numbers", () => {
    expect(numericTypeProblem({ base: "number" })).toBeUndefined();
    expect(numericTypeProblem({ base: "integer" })).toBeUndefined();
    expect(numericTypeProblem({ base: "decimal" })).toBe("is a decimal");
    expect(numericTypeProblem({ base: "string" })).toBe("is a string");
    for (const tag of ["timestamp", "created", "updated"]) {
      expect(numericTypeProblem({ base: "number", tags: new Set([tag]) })).toBe("is a timestamp");
    }
    expect(numericTypeProblem({ base: "number", tags: new Set(["int"]) })).toBeUndefined();
  });
});

describe("capability — fail-closed", () => {
  it("the base adapter has no aggregate arithmetic and renders no first / last", () => {
    const adapter = new MockAdapter();
    expect(adapter.supportsAggregateExpressions()).toBe(false);
    expect(BASE_AGGREGATE_FNS.has("first")).toBe(false);
    expect(BASE_AGGREGATE_FNS.has("last")).toBe(false);
    expect(ALL_AGGREGATE_FNS.has("first")).toBe(true);
    expect(ALL_AGGREGATE_FNS.has("last")).toBe(true);
  });

  it("an arithmetic entry on an adapter without support is AGG_EXPR_NOT_SUPPORTED", async () => {
    const { table, adapter } = bind(() => new MockAdapter());
    for (const entry of [
      { $fn: "sum", $expr: { $op: "*", $args: ["price", "qty"] }, $as: "rev" },
      { $expr: { $op: "+", $args: ["n", 1] }, $as: "n1" },
    ]) {
      const select = [{ $fn: "count", $field: "*", $as: "n" }, entry];
      const err = await rejection(table.aggregate(grouped(select)));
      expect(err.code).toBe("AGG_EXPR_NOT_SUPPORTED");
    }
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });

  it("first / last on an adapter whose aggregateFns() lacks them is AGG_FN_NOT_SUPPORTED", async () => {
    const { table } = bind(() => new MockAdapter());
    const err = await rejection(
      table.aggregate(
        grouped([{ $fn: "first", $field: "id", $as: "f" }], { $rowOrder: { raisedAt: 1 } }),
      ),
    );
    expect(err.code).toBe("AGG_FN_NOT_SUPPORTED");
  });

  it("arithmetic in a non-grouped read is rejected (declare a view for per-row values)", async () => {
    const { table } = supported();
    const err = await rejection(
      table.findMany({
        filter: {},
        controls: { $select: [{ $expr: { $op: "+", $args: ["price", 1] }, $as: "p1" }] } as any,
      }),
    );
    expect(err.code).toBe("INVALID_QUERY");
    expect(messages(err)).toContain(
      "Expressions and first()/last() are only valid in grouped queries",
    );
  });
});

describe("numeric operand rules (QX1 / QX2)", () => {
  const rowSum = (operand: string) => ({
    $fn: "sum",
    $expr: { $op: "*", $args: [operand, 2] },
    $as: "x",
  });

  it("accepts numeric operands and hands the query to the adapter", async () => {
    const { table, adapter } = supported();
    adapter.aggregateResult = [{ ticketId: 1, rev: 6 }];
    const rows = await table.aggregate(
      grouped([{ $fn: "sum", $expr: { $op: "*", $args: ["price", "qty"] }, $as: "rev" }]),
    );
    expect(rows).toEqual([{ ticketId: 1, rev: 6 }]);
  });

  it.each(["title", "flag", "cost", "raisedAt"])(
    "a row-level operand %s is rejected as not numeric",
    async (field) => {
      const { table } = supported();
      const err = await rejection(table.aggregate(grouped([rowSum(field)])));
      expect(err.code).toBe("INVALID_QUERY");
      expect(messages(err)).toEqual([
        `Field "${field}" is not numeric — arithmetic needs a number field (not decimal, timestamp or text)`,
      ]);
    },
  );

  it("a JSON descendant operand is rejected by the path guard", async () => {
    const { table } = supported();
    const err = await rejection(table.aggregate(grouped([rowSum("meta.weight")])));
    expect(err.code).toBe("INVALID_QUERY");
    expect(messages(err)[0]).toContain("meta.weight");
  });

  it("an encrypted operand is ENC_FIELD_AGG, not a type error", async () => {
    const { table } = supported();
    const err = await rejection(table.aggregate(grouped([rowSum("secretScore")])));
    expect(err.code).toBe("ENC_FIELD_AGG");
  });

  it("an unknown operand is the path guard's Unknown field", async () => {
    const { table } = supported();
    const err = await rejection(table.aggregate(grouped([rowSum("nope")])));
    expect(messages(err)).toEqual(['Unknown field "nope"']);
  });

  it("a group-level operand that is a $groupBy field must be numeric", async () => {
    const { table } = supported();
    const err = await rejection(
      table.aggregate({
        filter: {},
        controls: {
          $groupBy: ["status"],
          $select: ["status", { $expr: { $op: "+", $args: ["status", 1] }, $as: "x" }],
        } as any,
      }),
    );
    expect(messages(err)).toEqual([
      'Field "status" is not numeric — arithmetic needs a number field (not decimal, timestamp or text)',
    ]);
  });

  it("a group-level operand that is a non-numeric alias is rejected (QX2)", async () => {
    const { table } = supported();
    const err = await rejection(
      table.aggregate(
        grouped(
          [
            { $fn: "first", $field: "title", $as: "oldestTitle" },
            { $expr: { $op: "+", $args: ["oldestTitle", 1] }, $as: "x" },
          ],
          { $rowOrder: { raisedAt: 1 } },
        ),
      ),
    );
    expect(messages(err)).toEqual([
      '"oldestTitle" is not numeric and cannot be used in an expression',
    ]);
  });

  it("counts, numeric aggregates, first / last of numbers and other expressions are operands", async () => {
    const { table, adapter } = supported();
    await table.aggregate(
      grouped(
        [
          { $fn: "count", $field: "*", $as: "n" },
          { $fn: "sum", $field: "estimate", $as: "est" },
          { $fn: "min", $field: "severity", $as: "sevMin" },
          { $fn: "first", $field: "id", $as: "oldestId" },
          { $expr: { $op: "/", $args: ["est", "n"] }, $as: "avgEst" },
          {
            $expr: { $op: "+", $args: ["avgEst", { $op: "+", $args: ["sevMin", "oldestId"] }] },
            $as: "rank",
          },
        ],
        { $rowOrder: { raisedAt: 1 } },
      ),
    );
    expect(sent(adapter).controls.$select!.exprs!.map((e) => e.alias)).toEqual(["avgEst", "rank"]);
  });

  it("first / last over a JSON value is rejected", async () => {
    const { table } = supported();
    const err = await rejection(
      table.aggregate(
        grouped([{ $fn: "first", $field: "meta", $as: "m" }], { $rowOrder: { raisedAt: 1 } }),
      ),
    );
    expect(err.code).toBe("INVALID_QUERY");
  });

  it("an encrypted first / last field is ENC_FIELD_AGG and an encrypted $rowOrder key ENC_FIELD_SORT", async () => {
    const { table } = supported();
    const first = await rejection(
      table.aggregate(
        grouped([{ $fn: "first", $field: "secretScore", $as: "s" }], {
          $rowOrder: { raisedAt: 1 },
        }),
      ),
    );
    expect(first.code).toBe("ENC_FIELD_AGG");
    const order = await rejection(
      table.aggregate(
        grouped([{ $fn: "first", $field: "id", $as: "s" }], { $rowOrder: { secretScore: 1 } }),
      ),
    );
    expect(order.code).toBe("ENC_FIELD_SORT");
  });

  it("an unknown $rowOrder key is the path guard's Unknown field", async () => {
    const { table } = supported();
    const err = await rejection(
      table.aggregate(
        grouped([{ $fn: "first", $field: "id", $as: "s" }], { $rowOrder: { nope: 1 } }),
      ),
    );
    expect(messages(err)).toEqual(['Unknown field "nope"']);
  });

  it("$rowOrder without first / last, and first / last without $rowOrder, are normalizer errors", async () => {
    const { table } = supported();
    const orphan = await rejection(table.aggregate(grouped([], { $rowOrder: { raisedAt: 1 } })));
    expect(messages(orphan)).toEqual(["$rowOrder orders rows for first()/last() only"]);
    const missing = await rejection(
      table.aggregate(grouped([{ $fn: "first", $field: "id", $as: "s" }])),
    );
    expect(missing.code).toBe("INVALID_QUERY");
  });

  it("a quantity-ref operand needs its ref in $groupBy", async () => {
    const { table } = supported();
    const err = await rejection(table.aggregate(grouped([rowSum("weight")])));
    expect(messages(err)).toEqual([
      'Expression "x" requires "unit" in $groupBy — quantity-ref-tagged fields must be grouped by their dimension',
    ]);
    const ok = supported();
    await ok.table.aggregate({
      filter: {},
      controls: { $groupBy: ["unit"], $select: ["unit", rowSum("weight")] } as any,
    });
  });
});

describe("strict (dimension / measure) tables", () => {
  it("row-level operands must be measures", async () => {
    const { table } = supported("ExprStrict");
    const ok = supported("ExprStrict");
    await ok.table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: [
          "status",
          { $fn: "sum", $expr: { $op: "*", $args: ["price", "qty"] }, $as: "rev" },
        ],
      } as any,
    });
    const err = await rejection(
      table.aggregate({
        filter: {},
        controls: {
          $groupBy: ["status"],
          $select: [
            "status",
            { $fn: "sum", $expr: { $op: "*", $args: ["price", "note"] }, $as: "rev" },
          ],
        } as any,
      }),
    );
    expect(messages(err)).toEqual(['Expression operand "note" is not a measure']);
  });

  it("first / last fields and $rowOrder keys must be a dimension or a measure", async () => {
    const { table } = supported("ExprStrict");
    const base = (field: string, order: string) => ({
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "first", $field: field, $as: "f" }],
        $rowOrder: { [order]: 1 },
      } as any,
    });
    await table.aggregate(base("price", "qty"));
    const field = await rejection(table.aggregate(base("note", "qty")));
    expect(messages(field)).toEqual(['Aggregate field "note" is not a dimension or measure']);
    const order = await rejection(table.aggregate(base("price", "note")));
    expect(messages(order)).toEqual(['$rowOrder field "note" is not a dimension or measure']);
  });
});

describe("what the adapter receives", () => {
  it("hands over physical names, group-level expressions in dependency order, the order with the PK appended and no $rowOrder", async () => {
    const { table, adapter } = supported();
    await table.aggregate(
      grouped(
        [
          { $fn: "count", $field: "*", $as: "open" },
          { $fn: "sum", $field: "estimate", $as: "est" },
          {
            $fn: "sum",
            $expr: { $op: "*", $args: ["price", { $op: "-", $args: ["estimate"] }] },
            $as: "rev",
          },
          { $expr: { $op: "+", $args: ["avgEst", 1] }, $as: "rank" },
          { $expr: { $op: "/", $args: ["est", "open"] }, $as: "avgEst" },
          { $fn: "first", $field: "estimate", $as: "oldestEst" },
          { $fn: "last", $field: "raisedAt", $as: "newestAt" },
        ],
        { $rowOrder: { raisedAt: 1, severity: -1 }, $sort: { rank: -1 } },
      ),
    );
    const { controls } = sent(adapter);
    const select = controls.$select!;
    expect(controls.$rowOrder).toBeUndefined();
    // first / last never appear among plain aggregates
    expect(select.aggregates!.map((a) => a.$fn)).toEqual(["count", "sum"]);
    expect(select.firstLast).toEqual([
      { fn: "first", column: "est_points", alias: "oldestEst" },
      { fn: "last", column: "raisedAt", alias: "newestAt" },
    ]);
    expect(select.exprAggregates).toEqual([
      {
        fn: "sum",
        alias: "rev",
        expr: {
          op: "*",
          args: [{ field: "price" }, { op: "neg", args: [{ field: "est_points" }] }],
        },
        names: ["price", "est_points"],
      },
    ]);
    // dependency order: avgEst before rank; leaves are aliases (not renamed)
    expect(select.exprs).toEqual([
      {
        alias: "avgEst",
        expr: { op: "/", args: [{ field: "est" }, { field: "open" }] },
        names: ["est", "open"],
      },
      { alias: "rank", expr: { op: "+", args: [{ field: "avgEst" }, 1] }, names: ["avgEst"] },
    ]);
    expect(select.rowOrder).toEqual([
      { column: "raisedAt", desc: false },
      { column: "severity", desc: true },
      { column: "id", desc: false },
    ]);
    expect(controls.$sort).toEqual({ rank: -1 });
  });

  it("a group-level operand that is a $groupBy field becomes its physical name", async () => {
    const { table, adapter } = supported();
    await table.aggregate({
      filter: {},
      controls: {
        $groupBy: ["estimate"],
        $select: ["estimate", { $expr: { $op: "*", $args: ["estimate", 2] }, $as: "double" }],
      } as any,
    });
    expect(sent(adapter).controls.$select!.exprs).toEqual([
      {
        alias: "double",
        expr: { op: "*", args: [{ field: "est_points" }, 2] },
        names: ["est_points"],
      },
    ]);
  });

  it("a $rowOrder key that is the primary key is not appended twice", async () => {
    const { table, adapter } = supported();
    await table.aggregate(
      grouped([{ $fn: "first", $field: "title", $as: "t" }], { $rowOrder: { id: -1 } }),
    );
    expect(sent(adapter).controls.$select!.rowOrder).toEqual([{ column: "id", desc: true }]);
  });

  it("$having values on an expression alias are numbers; on first of a string, strings", async () => {
    const { table } = supported();
    const select = [
      { $fn: "count", $field: "*", $as: "n" },
      { $fn: "first", $field: "title", $as: "t" },
      { $expr: { $op: "+", $args: ["n", 1] }, $as: "n1" },
    ];
    const bad = await rejection(
      table.aggregate(grouped(select, { $rowOrder: { id: 1 }, $having: { n1: "x" } })),
    );
    expect(bad.code).toBe("INVALID_QUERY");
    const ok = supported();
    await ok.table.aggregate(
      grouped(select, { $rowOrder: { id: 1 }, $having: { n1: { $gt: 1 }, t: "a" } }),
    );
  });
});

describe("collectQueryPaths", () => {
  it("lists row-level operands and first / last fields as aggregate refs and $rowOrder keys as sort refs", () => {
    const refs = collectQueryPaths({
      controls: {
        $groupBy: ["ticketId"],
        $select: [
          "ticketId",
          { $fn: "sum", $expr: { $op: "*", $args: ["price", "qty"] }, $as: "rev" },
          { $expr: { $op: "/", $args: ["rev", "n"] }, $as: "avg" },
          { $fn: "count", $field: "*", $as: "n" },
          { $fn: "first", $field: "title", $as: "t" },
        ],
        $rowOrder: { raisedAt: 1 },
        $sort: { avg: -1, severity: 1 },
        $having: { avg: { $gt: 1 } },
      },
    });
    expect(refs.aggregate).toEqual(["price", "qty", "title"]);
    // aliases are exempt in $sort / $having; $rowOrder keys are columns
    expect(refs.sort).toEqual(["severity", "raisedAt"]);
    expect(refs.having).toEqual([]);
  });

  it("collects none of it outside aggregate mode", () => {
    const refs = collectQueryPaths({ controls: { $select: ["id"], $rowOrder: { raisedAt: 1 } } });
    expect(refs.aggregate).toEqual([]);
    expect(refs.sort).toEqual([]);
  });
});

/** x1 = n + n, x2 = x1 * x1, … — each level doubles what the alias stands for once inlined. */
const chain = (levels: number) => [
  { $fn: "count", $field: "*", $as: "n" },
  { $expr: { $op: "+", $args: ["n", "n"] }, $as: "x1" },
  ...Array.from({ length: levels - 1 }, (_, i) => ({
    $expr: { $op: "*", $args: [`x${i + 1}`, `x${i + 1}`] },
    $as: `x${i + 2}`,
  })),
];

describe("expanded expression size", () => {
  it("a short chain passes", async () => {
    const { table } = supported();
    await table.aggregate(grouped(chain(5)));
  });

  it("a chain whose inlined text blows up is INVALID_QUERY, however small each expression is", async () => {
    const { table, adapter } = supported();
    const err = await rejection(table.aggregate(grouped(chain(9))));
    expect(err.code).toBe("INVALID_QUERY");
    expect(messages(err)).toEqual([
      'Expression "x8" is too large once its aliases are expanded (more than 256 nodes)',
      'Expression "x9" is too large once its aliases are expanded (more than 256 nodes)',
    ]);
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });
});

describe("computed aliases of one source field read back like the column", () => {
  const select = [
    { $fn: "min", $field: "flag", $as: "flagMin" },
    { $fn: "max", $field: "flag", $as: "flagMax" },
    { $fn: "min", $field: "cost", $as: "costMin" },
    { $fn: "max", $field: "cost", $as: "costMax" },
    { $fn: "first", $field: "flag", $as: "flagFirst" },
    { $fn: "last", $field: "cost", $as: "costLast" },
    { $fn: "first", $field: "title", $as: "titleFirst" },
  ];

  it("coerces a boolean's 0 / 1 and a decimal's number, leaves other values alone", async () => {
    const { table, adapter } = supported();
    adapter.aggregateResult = [
      {
        ticketId: 1,
        flagMin: 0,
        flagMax: 1,
        costMin: 2.5,
        costMax: "7.50",
        flagFirst: 1,
        costLast: 10,
        titleFirst: "a",
      },
    ];
    const rows = await table.aggregate(grouped(select, { $rowOrder: { raisedAt: 1 } }));
    expect(rows).toEqual([
      {
        ticketId: 1,
        flagMin: false,
        flagMax: true,
        costMin: "2.5",
        costMax: "7.50",
        flagFirst: true,
        costLast: "10",
        titleFirst: "a",
      },
    ]);
  });

  it("keeps null and a row without the alias as they are", async () => {
    const { table, adapter } = supported();
    adapter.aggregateResult = [{ ticketId: 1, flagMin: null }, { ticketId: 2 }];
    const rows = await table.aggregate(grouped(select, { $rowOrder: { raisedAt: 1 } }));
    expect(rows).toEqual([{ ticketId: 1, flagMin: null }, { ticketId: 2 }]);
  });

  it("hands the adapter the source descriptors of min / max / first / last", async () => {
    const { table, adapter } = supported();
    await table.aggregate(grouped(select, { $rowOrder: { raisedAt: 1 } }));
    const { sources } = sent(adapter).controls.$select!;
    expect([...sources.keys()].toSorted()).toEqual(["cost", "flag", "title"]);
    expect(sources.get("flag")!.designType).toBe("boolean");
  });
});
