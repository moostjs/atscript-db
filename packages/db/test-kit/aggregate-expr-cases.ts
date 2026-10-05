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
