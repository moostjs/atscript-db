import { describe, it, expect } from "vite-plus/test";
import { DbError } from "@atscript/db";

/**
 * The shared behaviour table of `countDistinct` over a field list,
 * conditional aggregates (`$where`) and two-level aggregates (`$from`) in
 * `aggregate()` (since 0.1.168): the same data and expectations run against
 * every adapter — memory, SQLite, MongoDB, and the PostgreSQL / MySQL live
 * suites. A row with any NULL field of a field list is not counted; a
 * conditional `sum` over no matching value is NULL; the outer level of a
 * two-level aggregate reads inner columns only.
 *
 * Fixture: an `AlSale` table (see each package's `fixtures/agg-levels.as`).
 */

const at = (iso: string) => Date.parse(iso);

/** The rows of the table (insert with `insertMany`). */
// prettier-ignore
export const AL_ROWS = [
  { id: 1, region: "N", customerId: 1, productId: 10, status: "paid", amount: 10, qty: 1, createdAt: at("2026-01-05T10:00:00Z"), paid: true, shipping: { city: "Oslo" }, tags: ["a", "b"] },
  { id: 2, region: "N", customerId: 1, productId: 10, status: "paid", amount: 20, qty: 2, createdAt: at("2026-02-03T10:00:00Z"), paid: true, shipping: { city: "Oslo" }, tags: ["b"] },
  { id: 3, region: "N", customerId: 1, productId: 11, status: "open", amount: 5, qty: 1, createdAt: at("2026-02-10T10:00:00Z"), paid: false, shipping: { city: "Bergen" }, tags: [] },
  { id: 4, region: "N", customerId: 2, productId: 10, status: "open", amount: null, qty: 1, createdAt: at("2026-03-01T10:00:00Z"), paid: false, shipping: {} },
  { id: 5, region: "N", customerId: 2, productId: null, status: "open", amount: 7, qty: 3, createdAt: at("2026-03-02T10:00:00Z"), paid: false, shipping: { city: "Oslo" }, tags: ["a"] },
  { id: 6, region: "N", customerId: null, productId: 12, status: "paid", amount: null, qty: 1, createdAt: at("2026-03-03T10:00:00Z"), paid: true, shipping: { city: "Oslo" } },
  { id: 7, region: "S", customerId: 3, productId: 12, status: "open", amount: 4, qty: 1, createdAt: at("2026-01-07T10:00:00Z"), paid: false, shipping: { city: "Rome" }, tags: ["c"] },
  { id: 8, region: "S", customerId: 3, productId: 12, status: "paid", amount: 30, qty: 2, createdAt: at("2026-01-09T10:00:00Z"), paid: true, shipping: { city: "Rome" } },
  { id: 9, region: "S", customerId: 4, productId: 13, status: "paid", amount: 1, qty: 5, createdAt: at("2026-02-01T10:00:00Z"), paid: true, shipping: {} },
];

type TAggregateTable = {
  aggregate(query: never): Promise<unknown>;
  findMany(query: never): Promise<unknown>;
};

/** Rejects with a `DbError` of `code` (and an `errors` JSON matching `message`); returns it. */
export async function expectDbError(
  promise: Promise<unknown>,
  code: string,
  message?: RegExp,
): Promise<DbError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe(code);
  if (message) expect(JSON.stringify((error as DbError).errors)).toMatch(message);
  return error as DbError;
}

/** The inner level most two-level cases aggregate over: one row per (region, customer). */
export const PER_CUSTOMER = {
  $groupBy: ["region", "customerId"],
  $select: [
    { $fn: "sum", $field: "amount", $as: "spent" },
    { $fn: "count", $field: "*", $as: "orders" },
    { $fn: "max", $field: "createdAt", $as: "lastAt" },
  ],
};

/** `$where: { status: "paid" }`. */
export const PAID = { status: "paid" };

/**
 * Registers the shared cases. `opts.nullNestedKey` is the `shipping` value
 * the adapter returns for a grouped nested leaf that is NULL — what its
 * single-level grouping by `shipping.city` already returns (`{}` on the
 * relational adapters).
 */
/**
 * Conditions whose answer depends on how the adapter's filter reads NULL /
 * missing values, `$not`, `$nin`, `$in` with `null` and comparisons with
 * `null` — the invariant `aggregate(f, x | w) ≡ aggregate(f ∧ w, x)` must
 * hold for each on every adapter.
 */
export const NULL_SENSITIVE_WHERES: readonly object[] = [
  { customerId: { $ne: 1 } },
  { customerId: { $nin: [1, 3] } },
  { $not: { amount: { $gt: 9 } } },
  { amount: { $lte: 10 } },
  { "shipping.city": { $ne: "Oslo" } },
  { productId: { $in: [10, null] } },
  { productId: { $nin: [10, null] } },
  { amount: { $gt: null } },
  { amount: { $lt: null } },
  { customerId: null },
  { customerId: { $exists: false } },
  { status: { $regex: "^p" } },
  { $not: { status: { $regex: "^p" } } },
  { $or: [{ customerId: 1 }, { amount: null }] },
  { $and: [{ customerId: { $ne: 2 } }, { $not: { productId: 12 } }] },
];

/** Conditions on an array field (`tags`) — for adapters that filter arrays (memory, MongoDB). */
export const ARRAY_WHERES: readonly object[] = [
  { tags: "a" },
  { tags: { $ne: "a" } },
  { tags: { $in: ["a", "c"] } },
  { tags: { $nin: ["a"] } },
  { tags: { $regex: "^b" } },
  { $not: { tags: "b" } },
];

/**
 * Registers the shared cases. `opts.nullNestedKey` is the `shipping` value
 * the adapter returns for a grouped nested leaf that is NULL — what its
 * single-level grouping by `shipping.city` already returns (`{}` on the
 * relational adapters). `opts.arrayFilters`: the adapter filters array
 * fields (runs the {@link ARRAY_WHERES} invariant).
 */
export function defineAggregateLevelCases(
  label: string,
  table: () => TAggregateTable,
  opts: { nullNestedKey?: unknown; arrayFilters?: boolean } = {},
): void {
  const agg = (filter: object, controls: object) =>
    table().aggregate({ filter, controls } as never) as Promise<Array<Record<string, unknown>>>;

  /** `count(*)` and `sum(qty)` per region under condition `w`, and under the same filter. */
  const sameAsFilter = async (w: object) => {
    const conditional = await agg(
      {},
      {
        $groupBy: ["region"],
        $select: [
          "region",
          { $fn: "count", $field: "*", $where: w, $as: "n" },
          { $fn: "sum", $field: "qty", $where: w, $as: "q" },
          { $fn: "countDistinct", $field: ["customerId", "status"], $where: w, $as: "d" },
        ],
        $sort: { region: 1 },
      },
    );
    const filtered = await agg(w, {
      $groupBy: ["region"],
      $select: [
        "region",
        { $fn: "count", $field: "*", $as: "n" },
        { $fn: "sum", $field: "qty", $as: "q" },
        { $fn: "countDistinct", $field: ["customerId", "status"], $as: "d" },
      ],
    });
    const byRegion = new Map(filtered.map((r) => [r.region, r]));
    // a region the filter leaves no row in: count 0, sum null
    const expected = conditional.map((r) => ({
      region: r.region,
      n: byRegion.get(r.region)?.n ?? 0,
      q: byRegion.get(r.region)?.q ?? null,
      d: byRegion.get(r.region)?.d ?? 0,
    }));
    expect(conditional, JSON.stringify(w)).toEqual(expected);
  };

  describe(`[${label}] a condition aggregates exactly the rows the same filter returns`, () => {
    it.each(NULL_SENSITIVE_WHERES.map((w) => [JSON.stringify(w), w]))("%s", async (_, w) => {
      await sameAsFilter(w as object);
    });

    it.runIf(opts.arrayFilters).each(ARRAY_WHERES.map((w) => [JSON.stringify(w), w]))(
      "array field: %s",
      async (_, w) => {
        await sameAsFilter(w as object);
      },
    );

    it("a condition that is always false aggregates no row", async () => {
      const rows = await agg(
        {},
        {
          $groupBy: ["region"],
          $select: [
            "region",
            { $fn: "count", $field: "*", $where: { customerId: { $in: [] } }, $as: "inEmpty" },
            { $fn: "sum", $field: "amount", $where: { amount: { $in: [] } }, $as: "sumInEmpty" },
            {
              $fn: "countDistinct",
              $field: ["customerId", "productId"],
              $where: { $or: [] },
              $as: "cdOrEmpty",
            },
            {
              $fn: "sum",
              $expr: { $op: "*", $args: ["amount", "qty"] },
              $where: { $or: [] },
              $as: "exprOrEmpty",
            },
            { $fn: "max", $field: "amount", $where: { status: { $in: [] } }, $as: "maxInEmpty" },
          ],
          $sort: { region: 1 },
        },
      );
      expect(rows).toEqual(
        ["N", "S"].map((region) => ({
          region,
          inEmpty: 0,
          sumInEmpty: null,
          cdOrEmpty: 0,
          exprOrEmpty: null,
          maxInEmpty: null,
        })),
      );
    });

    it("a comparison with null aggregates what the same filter returns", async () => {
      for (const w of [{ amount: { $gt: null } }, { amount: { $lt: null } }]) {
        const [cond] = await agg(
          {},
          { $select: [{ $fn: "count", $field: "*", $where: w, $as: "n" }] },
        );
        const [filt] = await agg(w, { $select: [{ $fn: "count", $field: "*", $as: "n" }] });
        expect(cond, JSON.stringify(w)).toEqual(filt);
      }
    });
  });

  describe(`[${label}] countDistinct over several fields`, () => {
    it("counts distinct combinations per group; a row with any NULL field is not counted", async () => {
      const rows = await agg(
        {},
        {
          $groupBy: ["region"],
          $select: [
            "region",
            { $fn: "countDistinct", $field: ["customerId", "productId"], $as: "pairs" },
            { $fn: "countDistinct", $field: "customerId", $as: "buyers" },
          ],
          $sort: { region: 1 },
        },
      );
      expect(rows).toEqual([
        { region: "N", pairs: 3, buyers: 2 },
        { region: "S", pairs: 2, buyers: 2 },
      ]);
    });

    it("names the default alias after the fields and works ungrouped", async () => {
      expect(
        await agg({}, { $select: [{ $fn: "countDistinct", $field: ["customerId", "productId"] }] }),
      ).toEqual([{ countDistinct_customerId_productId: 5 }]);
    });

    it("filters ($having) and counts ($count) on the alias", async () => {
      const controls = {
        $groupBy: ["region"],
        $select: [
          "region",
          { $fn: "countDistinct", $field: ["customerId", "productId"], $as: "pairs" },
        ],
        $having: { pairs: { $gt: 2 } },
      };
      expect(await agg({}, controls)).toEqual([{ region: "N", pairs: 3 }]);
      expect(await agg({}, { ...controls, $count: true })).toEqual([{ count: 1 }]);
    });

    it("reports an unknown field of the list by its own name", async () => {
      await expectDbError(
        agg(
          {},
          {
            $groupBy: ["region"],
            $select: [{ $fn: "countDistinct", $field: ["status", "nope"], $as: "x" }],
          },
        ),
        "INVALID_QUERY",
        /Unknown field \\"nope\\"/,
      );
    });
  });

  describe(`[${label}] conditional aggregates ($where)`, () => {
    it("aggregates only the rows matching the condition", async () => {
      const rows = await agg(
        {},
        {
          $groupBy: ["region"],
          $select: [
            "region",
            { $fn: "sum", $field: "amount", $where: PAID, $as: "paidTotal" },
            { $fn: "count", $field: "*", $where: PAID, $as: "paidCount" },
            { $fn: "count", $field: "amount", $where: PAID, $as: "paidAmounts" },
            { $fn: "countDistinct", $field: "customerId", $where: PAID, $as: "paidBuyers" },
            {
              $fn: "countDistinct",
              $field: ["customerId", "productId"],
              $where: PAID,
              $as: "paidPairs",
            },
            {
              $fn: "sum",
              $expr: { $op: "*", $args: ["amount", "qty"] },
              $where: PAID,
              $as: "paidValue",
            },
            { $fn: "count", $field: "*", $as: "all" },
          ],
          $sort: { region: 1 },
        },
      );
      expect(rows).toEqual([
        {
          region: "N",
          paidTotal: 30,
          paidCount: 3,
          paidAmounts: 2,
          paidBuyers: 1,
          paidPairs: 1,
          paidValue: 50,
          all: 6,
        },
        {
          region: "S",
          paidTotal: 31,
          paidCount: 2,
          paidAmounts: 2,
          paidBuyers: 2,
          paidPairs: 2,
          paidValue: 65,
          all: 3,
        },
      ]);
    });

    it("reads renamed and nested fields and boolean values in the condition", async () => {
      const rows = await agg(
        {},
        {
          $groupBy: ["region"],
          $select: [
            "region",
            { $fn: "sum", $field: "qty", $where: { amount: { $gt: 9 } }, $as: "bigQty" },
            { $fn: "count", $field: "*", $where: { "shipping.city": "Oslo" }, $as: "oslo" },
            { $fn: "count", $field: "*", $where: { paid: true }, $as: "paidFlag" },
            { $fn: "sum", $field: "amount", $where: { status: "void" }, $as: "none" },
            {
              $fn: "count",
              $field: "*",
              $where: { $or: [{ customerId: null }, { productId: null }] },
              $as: "gaps",
            },
            {
              $fn: "max",
              $field: "amount",
              $where: { status: { $in: ["open"] }, qty: { $lte: 1 } },
              $as: "maxOpenSingle",
            },
          ],
          $sort: { region: 1 },
        },
      );
      expect(rows).toEqual([
        { region: "N", bigQty: 3, oslo: 4, paidFlag: 3, none: null, gaps: 2, maxOpenSingle: 5 },
        { region: "S", bigQty: 2, oslo: 0, paidFlag: 2, none: null, gaps: 0, maxOpenSingle: 4 },
      ]);
    });

    it("filters, sorts and counts on a conditional alias, with the query filter alongside", async () => {
      const controls = {
        $groupBy: ["region"],
        $select: [
          "region",
          {
            $fn: "sum",
            $field: "amount",
            $where: { status: "paid", qty: { $gte: 1 } },
            $as: "paidTotal",
          },
        ],
        $having: { paidTotal: { $gt: 30 } },
        $sort: { paidTotal: -1 },
      };
      expect(await agg({ qty: { $lt: 100 } }, controls)).toEqual([{ region: "S", paidTotal: 31 }]);
      expect(await agg({ qty: { $lt: 100 } }, { ...controls, $count: true })).toEqual([
        { count: 1 },
      ]);
      expect(
        await agg({}, { $select: [{ $fn: "count", $field: "*", $where: PAID, $as: "n" }] }),
      ).toEqual([{ n: 5 }]);
    });

    it("rejects a condition on first() / last() and a relational predicate", async () => {
      await expectDbError(
        agg(
          {},
          {
            $groupBy: ["region"],
            $select: [{ $fn: "first", $field: "amount", $where: PAID, $as: "f" }],
            $rowOrder: { id: 1 },
          },
        ),
        "INVALID_QUERY",
        /takes no \$where/,
      );
      await expectDbError(
        agg(
          {},
          {
            $groupBy: ["region"],
            $select: [
              { $fn: "count", $field: "*", $where: { customer: { $some: { id: 1 } } }, $as: "n" },
            ],
          },
        ),
        "INVALID_QUERY",
        /relational predicates/,
      );
    });

    it("gates condition fields like filter fields (unknown field)", async () => {
      await expectDbError(
        agg(
          {},
          {
            $groupBy: ["region"],
            $select: [{ $fn: "count", $field: "*", $where: { secret: 1 }, $as: "n" }],
          },
        ),
        "INVALID_QUERY",
        /Unknown field \\"secret\\"/,
      );
    });
  });

  describe(`[${label}] two-level aggregates ($from)`, () => {
    it("aggregates the inner groups per outer key", async () => {
      const rows = await agg(
        {},
        {
          $from: PER_CUSTOMER,
          $groupBy: ["region"],
          $select: [
            "region",
            { $fn: "count", $field: "*", $as: "customers" },
            { $fn: "avg", $field: "spent", $as: "avgSpent" },
            { $fn: "sum", $field: "orders", $as: "orders" },
            { $fn: "count", $field: "*", $where: { spent: { $gt: 10 } }, $as: "big" },
          ],
          $sort: { region: 1 },
        },
      );
      expect(rows).toEqual([
        { region: "N", customers: 3, avgSpent: 21, orders: 6, big: 1 },
        { region: "S", customers: 2, avgSpent: 17.5, orders: 3, big: 1 },
      ]);
    });

    it("applies the filter to the inner rows, and $having / $sort / $limit / $count to the outer", async () => {
      const controls = {
        $from: PER_CUSTOMER,
        $groupBy: ["region"],
        $select: ["region", { $fn: "count", $field: "*", $as: "customers" }],
        $having: { customers: { $gt: 1 } },
        $sort: { customers: -1, region: 1 },
      };
      expect(await agg({ status: "paid" }, controls)).toEqual([
        { region: "N", customers: 2 },
        { region: "S", customers: 2 },
      ]);
      expect(await agg({}, { ...controls, $having: { customers: { $gt: 2 } } })).toEqual([
        { region: "N", customers: 3 },
      ]);
      expect(await agg({}, { ...controls, $limit: 1 })).toEqual([{ region: "N", customers: 3 }]);
      expect(await agg({}, { ...controls, $skip: 1 })).toEqual([{ region: "S", customers: 2 }]);
      expect(await agg({}, { ...controls, $count: true })).toEqual([{ count: 2 }]);
    });

    it("aggregates every inner row into one outer row without an outer $groupBy", async () => {
      expect(
        await agg(
          {},
          {
            $from: PER_CUSTOMER,
            $select: [
              { $fn: "avg", $field: "spent", $as: "avgSpent" },
              { $fn: "count", $field: "*", $as: "groups" },
            ],
          },
        ),
      ).toEqual([{ avgSpent: 19.25, groups: 5 }]);
    });

    it("groups by an inner alias", async () => {
      const rows = await agg(
        {},
        {
          $from: PER_CUSTOMER,
          $groupBy: ["orders"],
          $select: ["orders", { $fn: "count", $field: "*", $as: "customers" }],
          $sort: { orders: 1 },
        },
      );
      expect(rows).toEqual([
        { orders: 1, customers: 2 },
        { orders: 2, customers: 2 },
        { orders: 3, customers: 1 },
      ]);
    });

    it("buckets an inner timestamp column", async () => {
      const rows = await agg(
        {},
        {
          $from: PER_CUSTOMER,
          $groupBy: ["lastMonth"],
          $select: [
            { $bucket: "month", $field: "lastAt", $as: "lastMonth" },
            { $fn: "count", $field: "*", $as: "customers" },
          ],
          $sort: { lastMonth: 1 },
        },
      );
      expect(rows).toEqual([
        { lastMonth: "2026-01-01", customers: 1 },
        { lastMonth: "2026-02-01", customers: 2 },
        { lastMonth: "2026-03-01", customers: 2 },
      ]);
    });

    it("reads first() of inner rows by $rowOrder, and honours an inner $having", async () => {
      expect(
        await agg(
          {},
          {
            $from: PER_CUSTOMER,
            $groupBy: ["region"],
            $select: ["region", { $fn: "first", $field: "customerId", $as: "top" }],
            $rowOrder: { spent: -1 },
            $sort: { region: 1 },
          },
        ),
      ).toEqual([
        { region: "N", top: 1 },
        { region: "S", top: 3 },
      ]);
      expect(
        await agg(
          {},
          {
            $from: { ...PER_CUSTOMER, $having: { orders: { $gt: 1 } } },
            $groupBy: ["region"],
            $select: ["region", { $fn: "count", $field: "*", $as: "customers" }],
            $sort: { region: 1 },
          },
        ),
      ).toEqual([
        { region: "N", customers: 2 },
        { region: "S", customers: 1 },
      ]);
    });

    it("computes over inner columns at both levels", async () => {
      const rows = await agg(
        {},
        {
          $from: {
            $groupBy: ["region", "customerId"],
            $select: [
              { $fn: "sum", $expr: { $op: "*", $args: ["amount", "qty"] }, $as: "value" },
              { $fn: "count", $field: "*", $as: "orders" },
            ],
          },
          $groupBy: ["region"],
          $select: [
            "region",
            { $fn: "sum", $field: "value", $as: "value" },
            { $fn: "sum", $field: "orders", $as: "orders" },
            { $expr: { $op: "/", $args: ["value", "orders"] }, $as: "perOrder" },
          ],
          $sort: { region: 1 },
        },
      );
      // N: 10 + 40 + 5 (customer 1) + 21 (customer 2) = 76 over 6 orders; S: 4 + 60 + 5 = 69 over 3
      expect(rows).toEqual([
        { region: "N", value: 76, orders: 6, perOrder: 76 / 6 },
        { region: "S", value: 69, orders: 3, perOrder: 23 },
      ]);
    });

    it("buckets in a time zone at both levels", async () => {
      // inner: the local day in UTC+14 (every row moves to the next day); outer: the
      // local month in UTC-11 of each day's latest row (Feb 1 10:00Z is Jan 31 there)
      const rows = await agg(
        {},
        {
          $from: {
            $groupBy: ["day"],
            $select: [
              { $bucket: "day", $field: "createdAt", $tz: "Pacific/Kiritimati", $as: "day" },
              { $fn: "max", $field: "createdAt", $as: "lastAt" },
            ],
          },
          $groupBy: ["m"],
          $select: [
            { $bucket: "month", $field: "lastAt", $tz: "Pacific/Pago_Pago", $as: "m" },
            { $fn: "count", $field: "*", $as: "n" },
            { $fn: "count", $field: "*", $where: { day: { $gte: "2026-03-03" } }, $as: "late" },
          ],
          $sort: { m: 1 },
        },
      );
      expect(rows).toEqual([
        { m: "2026-01-01", n: 4, late: 0 },
        { m: "2026-02-01", n: 3, late: 0 },
        { m: "2026-03-01", n: 2, late: 2 },
      ]);
    });

    it("answers a blank $search with no rows, and $count 0", async () => {
      const controls = {
        $from: PER_CUSTOMER,
        $groupBy: ["region"],
        $select: ["region", { $fn: "count", $field: "*", $as: "c" }],
        $search: " ",
      };
      const searchable = await agg({}, controls).then(
        (rows) => ({ rows }),
        (error: unknown) => ({ error }),
      );
      // a source without text search rejects any $search; one with it answers no rows
      if ("error" in searchable) return;
      expect(searchable.rows).toEqual([]);
      expect(await agg({}, { ...controls, $count: true })).toEqual([{ count: 0 }]);
    });

    it("returns an alias named like a column as the alias's value, at both levels", async () => {
      expect(
        await agg(
          {},
          {
            $groupBy: ["region"],
            $select: ["region", { $fn: "count", $field: "*", $as: "paid" }],
            $sort: { region: 1 },
          },
        ),
      ).toEqual([
        { region: "N", paid: 6 },
        { region: "S", paid: 3 },
      ]);
      expect(
        await agg(
          {},
          {
            $from: { $groupBy: ["region"], $select: [{ $fn: "count", $field: "*", $as: "paid" }] },
            $groupBy: ["paid"],
            $select: ["paid", { $fn: "count", $field: "*", $as: "regions" }],
            $sort: { paid: 1 },
          },
        ),
      ).toEqual([
        { paid: 3, regions: 1 },
        { paid: 6, regions: 1 },
      ]);
    });

    it("groups by a nested inner key and returns it nested", async () => {
      const rows = await agg(
        {},
        {
          $from: {
            $groupBy: ["shipping.city", "region"],
            $select: [{ $fn: "count", $field: "*", $as: "n" }],
          },
          $groupBy: ["shipping.city"],
          $select: ["shipping.city", { $fn: "sum", $field: "n", $as: "total" }],
          $sort: { total: -1, "shipping.city": 1 },
        },
      );
      expect(rows).toEqual([
        { shipping: { city: "Oslo" }, total: 4 },
        { shipping: opts.nullNestedKey ?? {}, total: 2 },
        { shipping: { city: "Rome" }, total: 2 },
        { shipping: { city: "Bergen" }, total: 1 },
      ]);
    });

    it("rejects an outer name that is not an inner column — a table field included", async () => {
      const error = await expectDbError(
        agg(
          {},
          {
            $from: PER_CUSTOMER,
            $groupBy: ["region"],
            $select: ["region", { $fn: "sum", $field: "amount", $as: "x" }],
          },
        ),
        "INVALID_QUERY",
      );
      expect(error.errors[0]).toMatchObject({ code: "AGG_NESTED_UNKNOWN_COLUMN" });
    });

    it("rejects a bucket over an inner column that is no timestamp", async () => {
      await expectDbError(
        agg(
          {},
          {
            $from: PER_CUSTOMER,
            $groupBy: ["m"],
            $select: [
              { $bucket: "month", $field: "spent", $as: "m" },
              { $fn: "count", $field: "*", $as: "c" },
            ],
          },
        ),
        "INVALID_QUERY",
        /not a timestamp column of \$from/,
      );
    });

    it("gates the inner level like a standalone query (unknown field)", async () => {
      await expectDbError(
        agg(
          {},
          {
            $from: { $groupBy: ["secret"], $select: [{ $fn: "count", $field: "*", $as: "n" }] },
            $select: [{ $fn: "sum", $field: "n", $as: "t" }],
          },
        ),
        "INVALID_QUERY",
        /Unknown field \\"secret\\"/,
      );
    });

    it("rejects $from outside an aggregate, and unknown aggregate controls", async () => {
      await expectDbError(
        table().findMany({ filter: {}, controls: { $from: PER_CUSTOMER } } as never),
        "INVALID_QUERY",
        /only valid in an aggregate query/,
      );
      await expectDbError(
        agg({}, { $groupBy: ["region"], $fuzzy: "1" }),
        "INVALID_QUERY",
        /Unknown aggregate control/,
      );
      await expectDbError(
        agg({}, { $groupBy: ["region"], $with: [{ name: "x" }] }),
        "INVALID_QUERY",
        /\$with is not valid in an aggregate query/,
      );
    });
  });
}
