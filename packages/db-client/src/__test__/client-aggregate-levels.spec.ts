/**
 * countDistinct over a field list, conditional aggregates (`$where`) and
 * two-level aggregates (`$from`) on the client (since 0.1.168): `aggregate()`
 * types each shape — the nested result from the inner columns, a name that is
 * no inner column a compile error — and serializes them to the URL grammar
 * moost-db parses.
 */
import { describe, it, expect, expectTypeOf, vi } from "vite-plus/test";

import { Client, type NestedAggregateQuery, type ValidNested } from "../index";

declare class Sale {
  id: number;
  region: string;
  customerId?: number;
  status: string;
  amount: number;
  createdAt: number;
  static __is_atscript_annotated_type: true;
  static type: { __dataType?: Sale };
  static __ownProps: {
    id: number;
    region: string;
    customerId?: number;
    status: string;
    amount: number;
    createdAt: number;
  };
  static __navProps: {};
  static __pk: number;
}

function mockFetch(body: unknown) {
  return vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(body),
    }),
  );
}

const urlOf = (fetchFn: ReturnType<typeof mockFetch>) =>
  decodeURIComponent(fetchFn.mock.calls[0]![0] as string);

describe("aggregate() — field lists and conditions", () => {
  it("types a field-list countDistinct and a conditional sum", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Sale>("/api/sales");
      const rows = c.aggregate({
        controls: {
          $groupBy: ["region"],
          $select: [
            "region",
            { $fn: "countDistinct", $field: ["customerId", "status"] },
            { $fn: "sum", $field: "amount", $where: { status: "paid" }, $as: "paid" },
          ],
        },
      });
      type Row = Awaited<typeof rows>[number];
      expectTypeOf<Row["region"]>().toEqualTypeOf<string>();
      expectTypeOf<Row["countDistinct_customerId_status"]>().toEqualTypeOf<number>();
      expectTypeOf<Row["paid"]>().toEqualTypeOf<number>();
    }
  });

  it("serializes them to countDistinct(a,b) and fn(field|filter):alias", async () => {
    const fetchFn = mockFetch([]);
    await new Client<typeof Sale>("/api/sales", { fetch: fetchFn }).aggregate({
      controls: {
        $groupBy: ["region"],
        $select: [
          "region",
          { $fn: "countDistinct", $field: ["customerId", "status"], $as: "pairs" },
          { $fn: "sum", $field: "amount", $where: { status: "paid" }, $as: "paid" },
        ],
      },
    });
    const url = urlOf(fetchFn);
    expect(url).toContain("countDistinct(customerId,status):pairs");
    expect(url).toContain("sum(amount|status=paid):paid");
  });
});

describe("aggregate() — two-level aggregates", () => {
  it("types the outer rows from the inner columns and rejects other names", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Sale>("/api/sales");
      const rows = c.aggregate({
        controls: {
          $from: {
            $groupBy: ["region", "customerId"],
            $select: [{ $fn: "sum", $field: "amount", $as: "spent" }],
          },
          $groupBy: ["region"],
          $select: ["region", { $fn: "avg", $field: "spent", $as: "avgSpent" }],
        },
      });
      type Row = Awaited<typeof rows>[number];
      expectTypeOf<Row["region"]>().toEqualTypeOf<string>();
      expectTypeOf<Row["avgSpent"]>().toEqualTypeOf<number>();

      // `ValidNested` is the check `aggregate()` applies: `amount` is a table field, no inner column
      type Bad = {
        controls: {
          $from: { $groupBy: ["region"]; $select: [{ $fn: "count"; $field: "*"; $as: "n" }] };
          $select: [{ $fn: "sum"; $field: "amount"; $as: "t" }];
        };
      };
      expectTypeOf<ValidNested<Sale, Bad>["controls"]["$select"][0]>().toEqualTypeOf<never>();
      expectTypeOf<Bad>().toMatchTypeOf<NestedAggregateQuery<Sale>>();
    }
  });

  it("serializes $from=( … ) first", async () => {
    const fetchFn = mockFetch([{ region: "N", avgSpent: 30 }]);
    const rows = await new Client<typeof Sale>("/api/sales", { fetch: fetchFn }).aggregate({
      filter: { status: "paid" },
      controls: {
        $from: {
          $groupBy: ["region", "customerId"],
          $select: [{ $fn: "sum", $field: "amount", $as: "spent" }],
        },
        $groupBy: ["region"],
        $select: ["region", { $fn: "avg", $field: "spent", $as: "avgSpent" }],
      },
    });
    const url = urlOf(fetchFn);
    expect(url).toContain("$from=($select=sum(amount):spent&$groupBy=region,customerId)");
    expect(url).toContain("$groupBy=region");
    expect(url).toContain("status=paid");
    expect(rows).toEqual([{ region: "N", avgSpent: 30 }]);
  });
});

function shouldRun(): true {
  return true;
}
