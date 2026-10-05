import { describe, it, expect } from "vite-plus/test";

/**
 * The shared behaviour table of query-time arithmetic and `first` / `last` in
 * `aggregate()` (since 0.1.148): the same data and expectations run against
 * every adapter that renders them — memory, SQLite, MongoDB, and the PostgreSQL
 * / MySQL live suites. IEEE double, NULL propagation, `/` by zero is NULL, NULL
 * order keys smallest, ties to the lowest primary key; `sum` over no value is
 * NULL.
 *
 * Fixture: an `AeIssue` table (see each package's `fixtures/agg-expr.as`).
 */

/** Realistic instants: an epoch-near value is outside the calendar-bucket range. */
export const AE_T = Date.parse("2026-03-01T00:00:00Z");

/**
 * The rows of the table. `cost` values are chosen so numeric and text order
 * agree and no trailing zero is needed (`"3.5"`, never `"3.50"`).
 */
// Row 5 is listed BEFORE row 4 on purpose: they tie on `raisedAt`, so the primary-key
// tie-break of first / last is what picks id 4, never the insertion order.
export const AE_ROWS = [
  {
    id: 1,
    ticketId: 1,
    status: "open",
    price: 10,
    qty: 2,
    estimate: 3,
    severity: 1,
    raisedAt: AE_T + 1000,
    title: "a",
    flag: true,
    cost: "3.5",
  },
  {
    id: 2,
    ticketId: 1,
    status: "open",
    price: 5,
    qty: 4,
    estimate: 5,
    severity: 3,
    raisedAt: AE_T + 500,
    title: "b",
    flag: false,
    cost: "1.25",
  },
  { id: 3, ticketId: 1, status: "closed", price: 1, qty: 1, severity: 2, title: "c", flag: true },
  {
    id: 5,
    ticketId: 2,
    status: "open",
    price: 3,
    qty: 3,
    severity: 5,
    raisedAt: AE_T + 700,
    title: "e",
    flag: true,
    cost: "6.25",
  },
  {
    id: 4,
    ticketId: 2,
    status: "open",
    price: 7,
    qty: 0,
    estimate: 4,
    severity: 5,
    raisedAt: AE_T + 700,
    title: "d",
    flag: false,
    cost: "7.5",
  },
  {
    id: 6,
    ticketId: 3,
    status: "open",
    price: 2,
    qty: 2,
    severity: 1,
    title: "f",
    flag: false,
    cost: "9",
  },
];

const arith = (op: string, ...$args: unknown[]) => ({ $op: op, $args });

/** What the cases need of the table: `aggregate()`. */
export interface TAggregateExprTable {
  aggregate(query: any): Promise<Array<Record<string, any>>>;
}

/**
 * Registers the cases under `describe(name)`. `table` returns the table once
 * `AE_ROWS` are inserted (called per case, so a `beforeAll` may set it up).
 */
export function defineAggregateExprCases(name: string, table: () => TAggregateExprTable): void {
  const run = (controls: Record<string, unknown>, filter: Record<string, unknown> = {}) =>
    table().aggregate({ filter, controls });
  const byTicket = { $groupBy: ["ticketId"] };
  const open = { status: "open" };
  const count = { $fn: "count", $field: "*", $as: "n" };

  describe(`${name} aggregate arithmetic`, () => {
    it("row-level: sum over a per-row product, NULL operands skipped", async () => {
      const rows = await run(
        {
          ...byTicket,
          $select: ["ticketId", { $fn: "sum", $expr: arith("*", "price", "qty"), $as: "rev" }],
          $sort: { ticketId: 1 },
        },
        open,
      );
      expect(rows).toEqual([
        { ticketId: 1, rev: 40 },
        { ticketId: 2, rev: 9 },
        { ticketId: 3, rev: 4 },
      ]);
    });

    it("row-level: a renamed column, coalesce and unary minus", async () => {
      const rows = await run(
        {
          ...byTicket,
          $select: [
            "ticketId",
            {
              $fn: "sum",
              $expr: arith("*", { $op: "coalesce", $args: ["estimate", 0] }, 2),
              $as: "e2",
            },
            { $fn: "max", $expr: arith("-", "price"), $as: "negMax" },
          ],
          $sort: { ticketId: 1 },
        },
        open,
      );
      expect(rows).toEqual([
        { ticketId: 1, e2: 16, negMax: -5 },
        { ticketId: 2, e2: 8, negMax: -3 },
        { ticketId: 3, e2: 0, negMax: -2 },
      ]);
    });

    it("group-level: a ratio of aggregates (7/2 = 3.5; all-NULL sum → null)", async () => {
      const rows = await run(
        {
          ...byTicket,
          $select: [
            "ticketId",
            count,
            { $fn: "sum", $field: "estimate", $as: "est" },
            { $expr: arith("/", "est", "n"), $as: "avgEst" },
            { $expr: arith("/", "n", 2), $as: "half" },
          ],
          $sort: { ticketId: 1 },
        },
        open,
      );
      expect(rows).toEqual([
        { ticketId: 1, n: 2, est: 8, avgEst: 4, half: 1 },
        { ticketId: 2, n: 2, est: 4, avgEst: 2, half: 1 },
        { ticketId: 3, n: 1, est: null, avgEst: null, half: 0.5 },
      ]);
    });

    it("a sum over a group with no value is null — the plain sum and a sum over an expression", async () => {
      const rows = await run(
        {
          ...byTicket,
          $select: [
            "ticketId",
            { $fn: "sum", $field: "estimate", $as: "est" },
            { $fn: "sum", $expr: arith("*", "estimate", 2), $as: "est2" },
            { $fn: "avg", $field: "estimate", $as: "estAvg" },
          ],
          $sort: { ticketId: 1 },
        },
        open,
      );
      expect(rows).toEqual([
        { ticketId: 1, est: 8, est2: 16, estAvg: 4 },
        { ticketId: 2, est: 4, est2: 8, estAvg: 4 },
        { ticketId: 3, est: null, est2: null, estAvg: null },
      ]);
    });

    it("division by zero is null; coalesce rescues it", async () => {
      const rows = await run(
        {
          ...byTicket,
          $select: [
            "ticketId",
            count,
            { $fn: "sum", $field: "qty", $as: "q" },
            { $expr: arith("/", "n", "q"), $as: "ratio" },
            { $expr: { $op: "coalesce", $args: [arith("/", "n", "q"), -1] }, $as: "safe" },
          ],
        },
        { status: "open", qty: 0 },
      );
      expect(rows).toEqual([{ ticketId: 2, n: 1, q: 0, ratio: null, safe: -1 }]);
    });

    it("precedence, a group key as operand and an expression over an expression", async () => {
      const rows = await run(
        {
          ...byTicket,
          $select: [
            "ticketId",
            count,
            { $fn: "sum", $field: "estimate", $as: "est" },
            { $expr: arith("+", arith("*", "est", 2), "n"), $as: "a" },
            { $expr: arith("+", "a", "ticketId"), $as: "b" },
            { $expr: arith("-", arith("-", 10, "n"), arith("-", 1, 2)), $as: "c" },
          ],
          $sort: { ticketId: 1 },
        },
        open,
      );
      expect(rows).toEqual([
        { ticketId: 1, n: 2, est: 8, a: 18, b: 19, c: 9 },
        { ticketId: 2, n: 2, est: 4, a: 10, b: 12, c: 9 },
        { ticketId: 3, n: 1, est: null, a: null, b: null, c: 10 },
      ]);
    });

    it("$sort, $having, $skip / $limit and $count on an expression alias", async () => {
      const select = ["ticketId", { $fn: "sum", $expr: arith("*", "price", "qty"), $as: "rev" }];
      const sorted = await run({ ...byTicket, $select: select, $sort: { rev: -1 } }, open);
      expect(sorted.map((r) => r.ticketId)).toEqual([1, 2, 3]);
      const having = await run(
        { ...byTicket, $select: select, $having: { rev: { $gte: 5 } }, $sort: { rev: 1 } },
        open,
      );
      expect(having).toEqual([
        { ticketId: 2, rev: 9 },
        { ticketId: 1, rev: 40 },
      ]);
      const page = await run(
        { ...byTicket, $select: select, $sort: { rev: -1 }, $skip: 1, $limit: 1 },
        open,
      );
      expect(page).toEqual([{ ticketId: 2, rev: 9 }]);
      const total = await run(
        { ...byTicket, $select: select, $having: { rev: { $gte: 5 } }, $count: true },
        open,
      );
      expect(total).toEqual([{ count: 2 }]);
    });
  });

  describe(`${name} $sort on nullable computed aliases`, () => {
    // ticket 3 has no estimate: sum(estimate) and everything over it is NULL
    const select = [
      "ticketId",
      { $fn: "sum", $field: "estimate", $as: "est" },
      { $expr: arith("*", "est", 2), $as: "est2" },
      { $expr: arith("/", "est", { $op: "-", $args: ["est", "est"] }), $as: "ratio" },
    ];
    const order = async (sort: Record<string, 1 | -1>) =>
      (await run({ ...byTicket, $select: select, $sort: { ...sort, ticketId: 1 } })).map(
        (r) => r.ticketId,
      );

    it("NULL sorts smallest on every adapter: first ascending, last descending", async () => {
      expect(await order({ est: 1 })).toEqual([3, 2, 1]);
      expect(await order({ est: -1 })).toEqual([1, 2, 3]);
      expect(await order({ est2: 1 })).toEqual([3, 2, 1]);
      expect(await order({ est2: -1 })).toEqual([1, 2, 3]);
    });

    it("a ratio whose divisor is zero is NULL for every group and sorts as one tie", async () => {
      expect(await order({ ratio: -1 })).toEqual([1, 2, 3]);
      expect(await order({ ratio: 1 })).toEqual([1, 2, 3]);
    });
  });

  describe(`${name} malformed entries and reserved aliases`, () => {
    it("an entry carrying both $field and $expr is INVALID_QUERY", async () => {
      await expect(
        run({
          ...byTicket,
          $select: ["ticketId", { $fn: "sum", $field: "price", $expr: "qty", $as: "x" }],
        }),
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    });

    it("an alias in the engine's internal prefix is INVALID_QUERY", async () => {
      for (const alias of ["__as_n_total", "__as_rows", "__as_fl0"]) {
        await expect(
          run({
            ...byTicket,
            $select: ["ticketId", { $fn: "sum", $field: "price", $as: alias }],
          }),
        ).rejects.toMatchObject({ code: "INVALID_QUERY" });
        await expect(
          run({
            ...byTicket,
            $select: ["ticketId", count, { $expr: arith("+", "n", 1), $as: alias }],
          }),
        ).rejects.toMatchObject({ code: "INVALID_QUERY" });
      }
    });
  });

  describe(`${name} hostile expressions`, () => {
    const chain = (depth: number, leaf: unknown): unknown => {
      let e: unknown = leaf;
      for (let i = 0; i < depth; i++) e = { $op: "+", $args: [e, 1] };
      return e;
    };

    it("a 10k-deep row-level expression is INVALID_QUERY, not a stack overflow", async () => {
      await expect(
        run({
          ...byTicket,
          $select: ["ticketId", { $fn: "sum", $expr: chain(10_000, "price"), $as: "x" }],
        }),
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    });

    it("a 10k-deep group-level expression is INVALID_QUERY, not a stack overflow", async () => {
      await expect(
        run({ ...byTicket, $select: ["ticketId", count, { $expr: chain(10_000, "n"), $as: "y" }] }),
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    });

    it("a wide expression (10k terms) is INVALID_QUERY", async () => {
      const wide = {
        $op: "+",
        $args: [chain(1, "price"), ...Array.from({ length: 10_000 }, () => 1)],
      };
      await expect(
        run({ ...byTicket, $select: ["ticketId", { $fn: "sum", $expr: wide, $as: "x" }] }),
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    });

    it("the expanded size of ALL expression entries together is capped", async () => {
      // a balanced sum of 31 `n` (61 nodes): within every per-entry limit, 20 of them past the query cap
      const balanced = (leaves: number): unknown =>
        leaves === 1
          ? "n"
          : {
              $op: "+",
              $args: [balanced(Math.ceil(leaves / 2)), balanced(Math.floor(leaves / 2))],
            };
      const one = await run({
        ...byTicket,
        $select: ["ticketId", count, { $expr: balanced(31), $as: "e0" }],
        $sort: { ticketId: 1 },
      });
      expect(one[0]).toMatchObject({ ticketId: 1, e0: 93 });
      const select: unknown[] = ["ticketId", count];
      for (let i = 0; i < 20; i++) select.push({ $expr: balanced(31), $as: `e${i}` });
      await expect(run({ ...byTicket, $select: select })).rejects.toMatchObject({
        code: "INVALID_QUERY",
      });
    });
  });

  describe(`${name} first / last`, () => {
    const firstLast = [
      "ticketId",
      { $fn: "first", $field: "id", $as: "oldestId" },
      { $fn: "first", $field: "title", $as: "oldestTitle" },
      { $fn: "first", $field: "raisedAt", $as: "oldestAt" },
      { $fn: "last", $field: "id", $as: "newestId" },
    ];

    it("every first() reads the same row; NULL order keys sort smallest; ties go to the lowest id", async () => {
      const rows = await run({
        ...byTicket,
        $select: firstLast,
        $rowOrder: { raisedAt: 1 },
        $sort: { ticketId: 1 },
      });
      expect(rows).toEqual([
        // ticket 1: ids 1 (1000), 2 (500), 3 (NULL) — the NULL row is the smallest
        { ticketId: 1, oldestId: 3, oldestTitle: "c", oldestAt: null, newestId: 1 },
        // ticket 2: ids 4 and 5 tie on 700 — the primary key breaks it
        { ticketId: 2, oldestId: 4, oldestTitle: "d", oldestAt: AE_T + 700, newestId: 5 },
        { ticketId: 3, oldestId: 6, oldestTitle: "f", oldestAt: null, newestId: 6 },
      ]);
    });

    it("a descending $rowOrder flips first and last", async () => {
      const rows = await run(
        {
          ...byTicket,
          $select: firstLast.slice(0, 2).concat({ $fn: "last", $field: "id", $as: "newestId" }),
          $rowOrder: { severity: -1 },
          $sort: { ticketId: 1 },
        },
        {},
      );
      expect(rows).toEqual([
        // ticket 1 by severity desc: id 2 (3), id 3 (2), id 1 (1)
        { ticketId: 1, oldestId: 2, newestId: 1 },
        { ticketId: 2, oldestId: 4, newestId: 5 },
        { ticketId: 3, oldestId: 6, newestId: 6 },
      ]);
    });

    it("boolean and text values read back typed", async () => {
      const rows = await run({
        ...byTicket,
        $select: [
          "ticketId",
          { $fn: "first", $field: "flag", $as: "f" },
          { $fn: "last", $field: "title", $as: "t" },
        ],
        $rowOrder: { id: 1 },
        $sort: { ticketId: 1 },
      });
      expect(rows).toEqual([
        { ticketId: 1, f: true, t: "c" },
        { ticketId: 2, f: false, t: "e" },
        { ticketId: 3, f: false, t: "f" },
      ]);
    });

    it("the WHERE narrows the rows first / last pick from", async () => {
      const rows = await run(
        {
          ...byTicket,
          $select: firstLast.slice(0, 2),
          $rowOrder: { raisedAt: 1 },
          $sort: { ticketId: 1 },
        },
        open,
      );
      expect(rows).toEqual([
        { ticketId: 1, oldestId: 2 },
        { ticketId: 2, oldestId: 4 },
        { ticketId: 3, oldestId: 6 },
      ]);
    });

    it("works over a calendar-bucket group", async () => {
      const rows = await run({
        $groupBy: ["d"],
        $select: [
          { $bucket: "day", $field: "raisedAt", $as: "d" },
          count,
          { $fn: "first", $field: "id", $as: "fid" },
        ],
        $rowOrder: { severity: -1 },
        $sort: { fid: 1 },
      });
      expect(rows).toEqual([
        { d: null, n: 2, fid: 3 },
        { d: "2026-03-01", n: 4, fid: 4 },
      ]);
    });

    it("a first alias is an operand, then sorts and filters", async () => {
      const rows = await run({
        ...byTicket,
        $select: [
          "ticketId",
          { $fn: "first", $field: "severity", $as: "sev" },
          { $expr: arith("*", "sev", 10), $as: "score" },
        ],
        $rowOrder: { id: 1 },
        $having: { score: { $gte: 10 } },
        $sort: { score: -1, ticketId: 1 },
      });
      expect(rows).toEqual([
        { ticketId: 2, sev: 5, score: 50 },
        { ticketId: 1, sev: 1, score: 10 },
        { ticketId: 3, sev: 1, score: 10 },
      ]);
    });

    it("$having on an alias named like a renamed field is the alias, not the column", async () => {
      // `estimate` is stored as `est_points`
      const rows = await run({
        ...byTicket,
        $select: ["ticketId", { $fn: "first", $field: "estimate", $as: "estimate" }],
        $rowOrder: { id: 1 },
        $having: { estimate: { $gt: 0 } },
        $sort: { ticketId: 1 },
      });
      expect(rows).toEqual([
        { ticketId: 1, estimate: 3 },
        { ticketId: 2, estimate: 4 },
      ]);
    });

    it("$count counts the groups", async () => {
      const rows = await run({
        ...byTicket,
        $select: firstLast.slice(0, 2),
        $rowOrder: { id: 1 },
        $count: true,
      });
      expect(rows).toEqual([{ count: 3 }]);
    });

    it("$count with a $having that reads a first alias counts the surviving groups", async () => {
      const rows = await run({
        ...byTicket,
        $select: [{ $fn: "first", $field: "severity", $as: "sev" }],
        $rowOrder: { id: 1 },
        $having: { sev: { $gte: 2 } },
        $count: true,
      });
      expect(rows).toEqual([{ count: 1 }]);
    });

    it("ungrouped, over no rows: one row — counts 0, everything else null", async () => {
      const rows = await run(
        {
          $groupBy: [],
          $select: [
            count,
            { $fn: "sum", $field: "estimate", $as: "est" },
            { $fn: "first", $field: "id", $as: "f" },
            { $fn: "last", $field: "flag", $as: "l" },
            { $expr: arith("+", "n", 1), $as: "n1" },
          ],
          $rowOrder: { id: 1 },
        },
        { status: "nope" },
      );
      expect(rows).toEqual([{ n: 0, est: null, f: null, l: null, n1: 1 }]);
    });

    describe("ungrouped $count equals the number of rows the data query returns", () => {
      const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, number]> = [
        ["over rows", { $select: [count] }, {}, 1],
        ["over no rows", { $select: [count] }, { status: "nope" }, 1],
        ["a $having that holds", { $select: [count], $having: { n: { $gt: 0 } } }, {}, 1],
        ["a $having that fails", { $select: [count], $having: { n: { $gt: 100 } } }, {}, 0],
        [
          "a first() alias in $having",
          {
            $select: [{ $fn: "first", $field: "id", $as: "f" }],
            $rowOrder: { id: 1 },
            $having: { f: { $gte: 1 } },
          },
          {},
          1,
        ],
      ];
      for (const [label, controls, filter, expected] of cases) {
        it(label, async () => {
          const data = await run({ $groupBy: [], ...controls }, filter);
          const counted = await run({ $groupBy: [], ...controls, $count: true }, filter);
          expect(data).toHaveLength(expected);
          expect(counted).toEqual([{ count: expected }]);
        });
      }
    });

    it("ungrouped, over rows: one row of the whole table", async () => {
      const rows = await run({
        $groupBy: [],
        $select: [
          count,
          { $fn: "first", $field: "id", $as: "f" },
          { $fn: "last", $field: "id", $as: "l" },
        ],
        $rowOrder: { id: 1 },
      });
      expect(rows).toEqual([{ n: 6, f: 1, l: 6 }]);
    });
  });

  describe(`${name} min / max / first / last of one field read back like the column`, () => {
    it("a boolean and a decimal", async () => {
      const rows = await run({
        ...byTicket,
        $select: [
          "ticketId",
          { $fn: "min", $field: "flag", $as: "flagMin" },
          { $fn: "max", $field: "flag", $as: "flagMax" },
          { $fn: "min", $field: "cost", $as: "costMin" },
          { $fn: "max", $field: "cost", $as: "costMax" },
          { $fn: "first", $field: "flag", $as: "flagFirst" },
          { $fn: "last", $field: "cost", $as: "costLast" },
        ],
        $rowOrder: { id: 1 },
        $sort: { ticketId: 1 },
      });
      expect(rows).toEqual([
        {
          ticketId: 1,
          flagMin: false,
          flagMax: true,
          costMin: "1.25",
          costMax: "3.5",
          flagFirst: true,
          costLast: null,
        },
        {
          ticketId: 2,
          flagMin: false,
          flagMax: true,
          costMin: "6.25",
          costMax: "7.5",
          flagFirst: false,
          costLast: "6.25",
        },
        {
          ticketId: 3,
          flagMin: false,
          flagMax: false,
          costMin: "9",
          costMax: "9",
          flagFirst: false,
          costLast: "9",
        },
      ]);
    });
  });
}
