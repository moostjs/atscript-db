import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createAdapter as createSqlite } from "@atscript/db-sqlite";
import type { DbSpace, FilterExpr } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import { HttpError } from "@moostjs/event-http";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import { TableController } from "../decorators";
import { bootHttp, createMockApp, errorsOf, prepareFixtures, transformed } from "./test-utils";

/**
 * Ungrouped aggregates over HTTP (since 0.1.155): an aggregate `$select`
 * without `$groupBy` — `GET /query?$select=sum(amount):total,count(*):n` —
 * is the core's ungrouped aggregate (`$groupBy: []`), one row over the
 * filtered set. It passes every gate a grouped aggregate does: `hasField`,
 * `@db.writeOnly`, the row overlay (`transformFilter`), `validateControls`
 * overrides keyed on `$groupBy`; `/pages` rejects it like a grouped one.
 */

let UgOrder: any;
let UgOpenOrder: any;
let space: DbSpace;

const ORDERS = [
  { id: 1, status: "open", amount: 10, cost: 4, pin: "a" },
  { id: 2, status: "open", amount: 20, cost: 5, pin: "b" },
  { id: 3, status: "paid", amount: 30, cost: 6, pin: "c" },
  { id: 4, status: "paid", amount: 40, cost: 7, pin: "d" },
];

beforeAll(async () => {
  await prepareFixtures();
  ({ UgOrder, UgOpenOrder } = await import("./fixtures/aggregate-ungrouped.as"));
  space = createSqlite(":memory:");
  const result = await new SchemaSync(space).run([UgOrder, UgOpenOrder], { force: true });
  expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
  await space.getTable(UgOrder).insertMany(structuredClone(ORDERS) as never);
});

afterAll(async () => {
  await space?.close();
});

const orders = () => space.getTable(UgOrder) as any;
const bind = <C extends AsDbReadableController>(
  Ctrl: new (...args: any[]) => C = AsDbController as never,
): C => new Ctrl(createMockApp(), orders());

/** The 400 the request answers — returned, or a thrown core `DbError` mapped as the HTTP interceptor does. */
async function rejected(res: Promise<unknown>): Promise<HttpError> {
  const settled = await res.catch(() => undefined);
  const err = settled instanceof HttpError ? settled : await transformed(res);
  expect(err.body.statusCode).toBe(400);
  return err;
}

describe("GET /query with an aggregate $select and no $groupBy", () => {
  it("returns the one aggregate row over the whole table", async () => {
    expect(await bind().query("/query?$select=sum(amount):total,count(*):n")).toEqual([
      { total: 100, n: 4 },
    ]);
  });

  it("aggregates the filtered set only", async () => {
    expect(
      await bind().query("/query?status=paid&$select=sum(amount):total,avg(cost):avgCost"),
    ).toEqual([{ total: 70, avgCost: 6.5 }]);
  });

  it("is one row over no matching row: counts 0, other aggregates null", async () => {
    expect(await bind().query("/query?status=none&$select=count(*):n,sum(amount):total")).toEqual([
      { n: 0, total: null },
    ]);
  });

  it("$having filters the one row; $count counts the rows the data query returns", async () => {
    const ctrl = bind();
    expect(await ctrl.query("/query?$select=sum(amount):total&$having=total>500")).toEqual([]);
    expect(await ctrl.query("/query?$select=sum(amount):total&$count")).toEqual([{ count: 1 }]);
    expect(await ctrl.query("/query?$select=sum(amount):total&$having=total>500&$count")).toEqual([
      { count: 0 },
    ]);
  });

  it("an explicit $groupBy still groups", async () => {
    const rows = await bind().query(
      "/query?$groupBy=status&$select=status,sum(amount):total&$sort=status",
    );
    expect(rows).toEqual([
      { status: "open", total: 30 },
      { status: "paid", total: 70 },
    ]);
  });

  it("a plain field next to the aggregates must be grouped (400)", async () => {
    const err = await rejected(bind().query("/query?$select=status,count(*):n"));
    expect(errorsOf(err)).toEqual([
      { path: "$select", message: 'Plain field "status" in $select must also appear in $groupBy' },
    ]);
  });

  it("cannot be combined with $with or $vector", async () => {
    for (const qs of ["$with=owner", "$vector=embedding&$search=x"]) {
      const res = await bind().query(`/query?$select=count(*):n&${qs}`);
      expect(res, qs).toBeInstanceOf(HttpError);
      expect((res as HttpError).body.statusCode, qs).toBe(400);
    }
  });

  it("works on a view", async () => {
    const view = space.getView(UgOpenOrder) as any;
    const ctrl = new AsDbReadableController(createMockApp(), view);
    expect(await ctrl.query("/query?$select=sum(amount):total,count(*):n")).toEqual([
      { total: 30, n: 2 },
    ]);
  });
});

describe("ungrouped aggregates pass the grouped aggregates' gates", () => {
  it("a field hidden by hasField is an unknown field", async () => {
    class Scoped extends AsDbController {
      protected override hasField(path: string): boolean {
        return super.hasField(path) && path !== "cost";
      }
    }
    const err = await rejected(bind(Scoped).query("/query?$select=sum(cost):c"));
    expect(errorsOf(err)).toEqual([{ path: "cost", message: 'Unknown field "cost"' }]);
  });

  it("a @db.writeOnly field cannot be aggregated", async () => {
    const res = await bind().query("/query?$select=count(pin):n");
    expect(res).toBeInstanceOf(HttpError);
    expect((res as HttpError).body.message).toBe(
      'Field "pin" is @db.writeOnly and cannot be aggregated',
    );
  });

  it("the row overlay (transformFilter) narrows the aggregated rows", async () => {
    class RowScoped extends AsDbController {
      protected override transformFilter(filter: FilterExpr): FilterExpr {
        return { $and: [filter, { status: "open" }] } as FilterExpr;
      }
    }
    expect(await bind(RowScoped).query("/query?$select=sum(amount):total,count(*):n")).toEqual([
      { total: 30, n: 2 },
    ]);
  });

  it("a validateControls override keyed on $groupBy sees it ($groupBy: [])", async () => {
    const seen: unknown[] = [];
    class NoAggregates extends AsDbController {
      protected override validateControls(controls: Record<string, unknown>, type: any) {
        seen.push(controls.$groupBy);
        if (controls.$groupBy) return "Aggregates are not allowed";
        return super.validateControls(controls, type);
      }
    }
    const res = await bind(NoAggregates).query("/query?$select=sum(amount):total");
    expect(res).toBeInstanceOf(HttpError);
    expect((res as HttpError).body.message).toBe("Aggregates are not allowed");
    expect(seen).toEqual([[]]);
  });

  it("/pages rejects an aggregate, grouped or not", async () => {
    const ctrl = bind();
    for (const [qs, path] of [
      ["$select=sum(amount):total", "$select"],
      ["$groupBy=status&$select=status,count(*):n", "$groupBy"],
    ]) {
      const res = await ctrl.pages(`/pages?${qs}`);
      expect(res, qs).toBeInstanceOf(HttpError);
      expect(errorsOf(res), qs).toEqual([
        { path, message: "Aggregate queries are only valid on /query" },
      ]);
    }
  });
});

describe("over a real HTTP app", () => {
  it("GET /query?$select=sum(amount):total,count(*):n → 200 with the one row", async () => {
    getMoostInfact()._cleanup();
    @TableController(orders(), "ug-orders")
    @Inherit()
    class OrdersCtrl extends AsDbController {}
    const http = await bootHttp(OrdersCtrl);
    expect(await http("GET", "/ug-orders/query?$select=sum(amount):total,count(*):n")).toEqual({
      status: 200,
      body: [{ total: 100, n: 4 }],
    });
    const bad = await http("GET", "/ug-orders/query?$select=status,count(*):n");
    expect(bad.status).toBe(400);
  });
});
