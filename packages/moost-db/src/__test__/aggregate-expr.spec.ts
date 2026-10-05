import { describe, it, expect, beforeAll } from "vite-plus/test";
import { ALL_AGGREGATE_FNS, DbSpace } from "@atscript/db";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp, errorsOf, prepareFixtures, transformed } from "./test-utils";

/**
 * Query-time arithmetic and first / last over HTTP (since 0.1.148): the URL
 * forms reach the table, every operand passes the field gate (a hidden or
 * write-only field answers 400 like any other aggregate source), and `/meta`
 * advertises `aggregateExpressions` and `fields[P].numeric` from the same index.
 */

class ExprAdapter extends MockAdapter {
  override aggregateFns() {
    return ALL_AGGREGATE_FNS;
  }
  override supportsAggregateExpressions() {
    return true;
  }
}

let ExprTicket: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ ExprTicket } = await import("./fixtures/agg-exprs.as"));
});

class HidingController extends AsDbController<any> {
  protected override hasField(path: string): boolean {
    return path !== "estimate" && super.hasField(path);
  }
}

function bind(adapter: MockAdapter, Controller: typeof AsDbController = AsDbController) {
  const table = new DbSpace(() => adapter).getTable(ExprTicket);
  return new Controller(createMockApp(), table as any);
}

const sentSelect = (adapter: MockAdapter) =>
  adapter.calls.find((c) => c.method === "aggregate")!.args[0].controls.$select;

async function rejected(result: Promise<unknown>): Promise<HttpError> {
  const res = await result;
  expect(res).toBeInstanceOf(HttpError);
  return res as HttpError;
}

describe("URL forms reach the adapter", () => {
  it("expr(), fn(<arith>) with a raw + or %2B, first / last and $rowOrder", async () => {
    const adapter = new ExprAdapter();
    const ctrl = bind(adapter);
    for (const plus of ["+", "%2B"]) {
      adapter.calls.length = 0;
      const res = await ctrl.query(
        "?$groupBy=ticketId&$select=ticketId,count(*):n,sum(price*qty):rev," +
          `expr(rev/n${plus}1):score,first(title):oldest,last(raisedAt):newest&$rowOrder=raisedAt,-id&$sort=-score`,
      );
      expect(res).not.toBeInstanceOf(HttpError);
      const select = sentSelect(adapter);
      expect(select.exprAggregates).toEqual([
        {
          fn: "sum",
          alias: "rev",
          expr: { op: "*", args: [{ field: "price" }, { field: "qty" }] },
          names: ["price", "qty"],
        },
      ]);
      expect(select.exprs[0].alias).toBe("score");
      expect(select.firstLast.map((x: any) => [x.fn, x.column])).toEqual([
        ["first", "title"],
        ["last", "raisedAt"],
      ]);
      expect(select.rowOrder).toEqual([
        { column: "raisedAt", desc: false },
        { column: "id", desc: true },
      ]);
    }
  });
});

describe("the field gate covers every operand", () => {
  it("a hasField-hidden row-level operand is Unknown field", async () => {
    const adapter = new ExprAdapter();
    const res = await rejected(
      bind(adapter, HidingController as never).query(
        "?$groupBy=ticketId&$select=ticketId,sum(estimate*2):x",
      ),
    );
    expect(errorsOf(res)).toEqual([{ path: "estimate", message: 'Unknown field "estimate"' }]);
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });

  it("a hidden first() field and a hidden $rowOrder key are Unknown field", async () => {
    const adapter = new ExprAdapter();
    const ctrl = bind(adapter, HidingController as never);
    const first = await rejected(
      ctrl.query("?$groupBy=ticketId&$select=ticketId,first(estimate):e&$rowOrder=id"),
    );
    expect(errorsOf(first)[0]).toEqual({ path: "estimate", message: 'Unknown field "estimate"' });
    const order = await rejected(
      ctrl.query("?$groupBy=ticketId&$select=ticketId,first(price):p&$rowOrder=estimate"),
    );
    expect(errorsOf(order)[0]).toEqual({ path: "estimate", message: 'Unknown field "estimate"' });
  });

  it("a write-only operand, first() field or $rowOrder key cannot be aggregated", async () => {
    const ctrl = bind(new ExprAdapter());
    for (const url of [
      "?$groupBy=ticketId&$select=ticketId,sum(secretRank*2):x",
      "?$groupBy=ticketId&$select=ticketId,first(secretRank):x&$rowOrder=id",
      "?$groupBy=ticketId&$select=ticketId,first(price):x&$rowOrder=secretRank",
    ]) {
      const res = await rejected(ctrl.query(url));
      expect(res.body.statusCode).toBe(400);
      expect(res.message).toContain("secretRank");
    }
  });

  it("the veto reads every path of the grouped query: $sort key, plain $select field, bucket source", async () => {
    const ctrl = bind(new ExprAdapter());
    for (const url of [
      "?$groupBy=ticketId&$select=ticketId,count(*):n&$sort=secretRank",
      "?$groupBy=ticketId,secretRank&$select=ticketId,secretRank",
      "?$groupBy=d&$select=bucket(secretRank,day):d",
    ]) {
      const res = await rejected(ctrl.query(url));
      expect(res.body.statusCode).toBe(400);
      expect(res.message).toContain("secretRank");
    }
  });

  it("an unknown operand is Unknown field, not a write-only or encrypted answer", async () => {
    const res = await rejected(
      bind(new ExprAdapter()).query("?$groupBy=ticketId&$select=ticketId,sum(nope*2):x"),
    );
    expect(errorsOf(res)).toEqual([{ path: "nope", message: 'Unknown field "nope"' }]);
  });

  it("non-numeric operands are 400 from the core's type rule", async () => {
    for (const field of ["title", "cost", "raisedAt"]) {
      const res = await transformed(
        bind(new ExprAdapter()).query(
          `?$groupBy=ticketId&$select=ticketId,sum(${field}*2):x`,
        ) as Promise<never>,
      );
      expect(res.body.statusCode).toBe(400);
      expect(errorsOf(res)).toEqual([
        {
          path: "$select",
          message: `Field "${field}" is not numeric — arithmetic needs a number field (not decimal, timestamp or text)`,
        },
      ]);
    }
  });

  it("arithmetic on an adapter without support is HTTP 400 AGG_EXPR_NOT_SUPPORTED", async () => {
    const res = await transformed(
      bind(new MockAdapter()).query(
        "?$groupBy=ticketId&$select=ticketId,count(*):n,expr(n%2B1):m",
      ) as Promise<never>,
    );
    expect(res.body.statusCode).toBe(400);
    expect(errorsOf(res)).toEqual([
      { path: "$select", message: "Aggregate expressions are not supported by this adapter" },
    ]);
  });

  it("$rowOrder without first / last and in a non-grouped query is 400", async () => {
    const ctrl = bind(new ExprAdapter());
    const grouped = await rejected(ctrl.query("?$groupBy=ticketId&$select=ticketId&$rowOrder=id"));
    expect(errorsOf(grouped)).toEqual([
      { path: "$rowOrder", message: "$rowOrder orders rows for first()/last() only" },
    ]);
    const plain = await rejected(ctrl.query("?$rowOrder=id"));
    expect(plain.body.statusCode).toBe(400);
  });

  it("arithmetic in a non-grouped read is 400", async () => {
    const res = await rejected(bind(new ExprAdapter()).query("?$select=expr(price*2):x"));
    expect(errorsOf(res)).toEqual([
      {
        path: "$select",
        message: "Expressions and first()/last() are only valid in grouped queries",
      },
    ]);
  });
});

describe("/meta", () => {
  it("advertises aggregateExpressions, first / last and the numeric fields", async () => {
    const meta = await bind(new ExprAdapter()).meta();
    expect(meta.aggregateExpressions).toBe(true);
    expect(meta.aggregateFns).toEqual(
      expect.arrayContaining([
        "sum",
        "count",
        "avg",
        "min",
        "max",
        "countDistinct",
        "first",
        "last",
      ]),
    );
    const numeric = Object.entries(meta.fields)
      .filter(([, f]) => f.numeric)
      .map(([path]) => path);
    // ¬decimal, ¬timestamp, ¬text, ¬writeOnly
    expect(numeric.toSorted()).toEqual(["estimate", "id", "price", "qty", "ticketId"]);
    expect(meta.crud.query).toContain("rowOrder");
  });

  it("omits the numeric flag where the adapter has no aggregate arithmetic", async () => {
    const meta = await bind(new MockAdapter()).meta();
    expect(meta.aggregateExpressions).toBe(false);
    expect(Object.values(meta.fields).some((f) => f.numeric)).toBe(false);
    expect(meta.aggregateFns).toEqual(["sum", "count", "avg", "min", "max"]);
  });
});
