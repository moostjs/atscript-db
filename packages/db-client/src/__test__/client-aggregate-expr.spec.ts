/**
 * Aggregate arithmetic and first / last on the client (since 0.1.148):
 * `aggregate()` types expression aliases as `number | null` and first / last as
 * their field's type, and serializes the object form to the `expr(...)`,
 * `sum(<arith>)`, `first(...)` and `$rowOrder` URL grammar.
 */
import { describe, it, expect, expectTypeOf, vi } from "vite-plus/test";

import { Client } from "../index";

declare class Issue {
  id: number;
  ticketId: number;
  price: number;
  qty: number;
  estimate?: number;
  raisedAt?: number;
  title: string;
  static __is_atscript_annotated_type: true;
  static type: { __dataType?: Issue };
  static __ownProps: {
    id: number;
    ticketId: number;
    price: number;
    qty: number;
    estimate?: number;
    raisedAt?: number;
    title: string;
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

describe("aggregate() arithmetic and first / last", () => {
  it("types expression aliases as number | null and first / last as the field's type", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Issue>("/api/issues");
      const rows = c.aggregate({
        controls: {
          $groupBy: ["ticketId"],
          $select: [
            "ticketId",
            { $fn: "count", $field: "*", $as: "n" },
            { $fn: "sum", $expr: { $op: "*", $args: ["price", "qty"] }, $as: "rev" },
            { $expr: { $op: "/", $args: ["rev", "n"] }, $as: "avg" },
            { $fn: "first", $field: "title", $as: "oldestTitle" },
            { $fn: "last", $field: "raisedAt", $as: "newestAt" },
          ],
          $rowOrder: { raisedAt: 1 },
        },
      });
      type Row = Awaited<typeof rows>[number];
      expectTypeOf<Row["ticketId"]>().toEqualTypeOf<number>();
      expectTypeOf<Row["n"]>().toEqualTypeOf<number>();
      expectTypeOf<Row["rev"]>().toEqualTypeOf<number | null>();
      expectTypeOf<Row["avg"]>().toEqualTypeOf<number | null>();
      expectTypeOf<Row["oldestTitle"]>().toEqualTypeOf<string>();
      expectTypeOf<Row["newestAt"]>().toEqualTypeOf<number | undefined>();
    }
  });

  it("serializes the object form to expr(...), sum(<arith>), first / last and $rowOrder", async () => {
    const fetchFn = mockFetch([]);
    const client = new Client<typeof Issue>("/api/issues", { fetch: fetchFn });
    await client.aggregate({
      controls: {
        $groupBy: ["ticketId"],
        $select: [
          "ticketId",
          { $fn: "count", $field: "*", $as: "n" },
          { $fn: "sum", $expr: { $op: "*", $args: ["price", "qty"] }, $as: "rev" },
          { $expr: { $op: "+", $args: [{ $op: "/", $args: ["rev", "n"] }, 1] }, $as: "score" },
          { $fn: "first", $field: "title", $as: "oldestTitle" },
        ],
        $rowOrder: { raisedAt: 1, id: -1 },
        $sort: { score: -1 },
      },
    });
    const raw = fetchFn.mock.calls[0]![0] as string;
    // `+` is percent-encoded so a framework decoding it to a space cannot corrupt the expression
    expect(raw).toContain("expr(rev/n%2B1):score");
    const url = decodeURIComponent(raw);
    expect(url).toContain(
      "$select=ticketId,count(*):n,sum(price*qty):rev,expr(rev/n+1):score,first(title):oldestTitle",
    );
    expect(url).toContain("$rowOrder=raisedAt,-id");
    expect(url).toContain("$sort=-score");
  });
});

/** Type-only assertions run under tsc; at runtime the block is skipped. */
function shouldRun(): true {
  return true;
}
