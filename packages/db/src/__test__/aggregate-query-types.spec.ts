import { describe, it, expectTypeOf } from "vite-plus/test";

import type {
  AggregateQuery,
  NestedAggregateQuery,
  NestedAggregateResult,
  StageRow,
} from "../index";
import type { AggregateStage, NestedAggregateControls, ValidNested } from "../agg";
import type { AtscriptDbTable } from "../table/db-table";
import type { AggOrders } from "./fixtures/agg-orders.as";

// Since 0.1.177 `aggregate()` accepts a two-level query (`controls.$from`) at
// the type level. The runtime has run them since 0.1.168, but the parameter
// was `AggregateQuery`, whose `$from?: never` rejected every nested literal —
// the documented call did not compile without a cast. The parameter is the
// union (not overloads: a value typed as the union must fit too). Rows stay
// untyped for both shapes. Calls sit behind `Math.random() > 2`: type-checked
// (by the type-aware lint), never run.

declare const orders: AtscriptDbTable<typeof AggOrders>;

type Rows = Array<Record<string, unknown>>;

/** A caller's own typed two-level signature — the one uniqu documents (the db-client's `aggregate()` uses it). */
declare function typed<const Q extends NestedAggregateQuery<AggOrders>>(
  query: Q & ValidNested<AggOrders, Q>,
): {
  rows: NestedAggregateResult<AggOrders, Q>[];
  inner: StageRow<AggOrders, Q["controls"]["$from"]>;
};

describe("aggregate() query typing", () => {
  it("accepts the documented two-level query without a cast", async () => {
    if (Math.random() > 2) {
      const spend = await orders.aggregate({
        filter: { status: "paid" },
        controls: {
          $from: {
            $groupBy: ["region", "customerId"],
            $select: [
              { $fn: "sum", $field: "amount", $as: "spent" },
              { $fn: "count", $field: "*", $as: "orders" },
            ],
          },
          $groupBy: ["region"],
          $select: [
            "region",
            { $fn: "count", $field: "*", $as: "customers" },
            { $fn: "avg", $field: "spent", $as: "avgSpent" },
            { $fn: "count", $field: "*", $where: { orders: { $gt: 1 } }, $as: "returning" },
          ],
          $sort: { avgSpent: -1 },
        },
      });
      expectTypeOf(spend).toEqualTypeOf<Rows>();
    }
  });

  it("accepts a two-level query without an outer $groupBy (one row over all inner rows)", () => {
    if (Math.random() > 2) {
      void orders.aggregate({
        filter: {},
        controls: {
          $from: { $groupBy: ["region"], $select: [{ $fn: "sum", $field: "amount", $as: "t" }] },
          $select: [{ $fn: "avg", $field: "t", $as: "avgTotal" }],
        },
      });
    }
  });

  it("still accepts a flat grouped query", async () => {
    if (Math.random() > 2) {
      const rows = await orders.aggregate({
        filter: { status: "paid" },
        controls: { $groupBy: ["region"], $select: ["region", { $fn: "sum", $field: "amount" }] },
      });
      expectTypeOf(rows).toEqualTypeOf<Rows>();
    }
  });

  it("accepts a value typed as the union, and the re-exported nested types", async () => {
    if (Math.random() > 2) {
      const dynamic = {} as AggregateQuery | NestedAggregateQuery;
      expectTypeOf(await orders.aggregate(dynamic)).toEqualTypeOf<Rows>();

      const stage = {
        $groupBy: ["region"],
        $select: [{ $fn: "sum", $field: "amount", $as: "t" }],
      } satisfies AggregateStage<AggOrders>;
      const controls: NestedAggregateControls = { $from: stage, $groupBy: [] };
      const nested = {
        controls: { $from: stage, $select: ["region"] },
      } satisfies NestedAggregateQuery;
      void orders.aggregate({ controls });
      expectTypeOf(await orders.aggregate(nested)).toEqualTypeOf<Rows>();
    }
  });

  it("re-exports the helpers a caller types its own two-level signature with", () => {
    if (Math.random() > 2) {
      const { rows, inner } = typed({
        controls: {
          $from: { $groupBy: ["region"], $select: [{ $fn: "sum", $field: "amount", $as: "t" }] },
          $select: ["region", { $fn: "avg", $field: "t", $as: "avgT" }],
        },
      });
      expectTypeOf(rows[0]!.region).toEqualTypeOf<string>();
      expectTypeOf(rows[0]!.avgT).toEqualTypeOf<number>();
      expectTypeOf(inner).toEqualTypeOf<{ t: number; region: string }>();
      typed({
        controls: {
          $from: { $groupBy: ["region"] },
          // @ts-expect-error "status" is a table field, not an inner column
          $select: ["status"],
        },
      });
    }
  });

  it("still rejects what a two-level query cannot hold", () => {
    if (Math.random() > 2) {
      const inner = { $groupBy: ["region"] };
      // @ts-expect-error depth is fixed at two: no $from inside $from
      void orders.aggregate({ controls: { $from: { ...inner, $from: inner } } });
      // @ts-expect-error the inner level has no $sort (sort the outer result)
      void orders.aggregate({ controls: { $from: { ...inner, $sort: { region: 1 } } } });
      // @ts-expect-error the inner level has no $limit (page the outer result)
      void orders.aggregate({ controls: { $from: { ...inner, $limit: 5 } } });
      // @ts-expect-error a two-level query loads no relations
      void orders.aggregate({ controls: { $from: inner, $with: [{ name: "x" }] } });
    }
  });
});
