import { beforeAll, describe, expect, it } from "vite-plus/test";

import { DbSpace, walkViewExpr } from "../index";
import { computedOperands } from "../query/query-tree";
import { computeTableHash, computeViewSnapshot } from "../schema/schema-hash";
import { MockAdapter, prepareFixtures } from "./test-utils";

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-expr.as");
});

function space(): DbSpace {
  return new DbSpace(() => new MockAdapter());
}

describe("first-row joins — TViewJoin.first", () => {
  it("qualifies order keys with the target and appends the primary key", () => {
    const plan = space().getView(fx.VeQueue).viewPlan;
    expect(plan.joins[0].first).toBeUndefined();
    const first = plan.joins[1].first!;
    expect(plan.joins[1].scope).toBe("VeOldest");
    expect(first.key).toBe("id");
    expect(first.order.map((o) => [o.ref.type?.().id, o.ref.field, o.desc])).toEqual([
      ["VeOldest", "raisedAt", false],
      ["VeOldest", "id", false],
    ]);
  });

  it("does not append the primary key twice; keeps desc", () => {
    const first = space().getView(fx.VeLatest).viewPlan.joins[0].first!;
    expect(first.order.map((o) => [o.ref.field, o.desc])).toEqual([
      ["raisedAt", true],
      ["id", false],
    ]);
  });

  it("resolves order keys to the target's physical columns under the alias scope", () => {
    const view = space().getView(fx.VeQueue);
    const first = view.viewPlan.joins[1].first!;
    expect(first.order.map((o) => view.resolveFieldRef(o.ref, (n) => n))).toEqual([
      "VeOldest.raised_at",
      "VeOldest.id",
    ]);
  });
});

describe("computed columns — TViewColumnMapping.expr", () => {
  it("maps a computed field to an expression over view paths, without a source column", () => {
    const mappings = space().getView(fx.VeQueue).getViewColumnMappings();
    const rank = mappings.find((m) => m.viewPath === "rank")!;
    expect(rank).toEqual({
      viewColumn: "rank",
      viewPath: "rank",
      sourceTable: "ve_tickets",
      sourceColumn: "",
      expr: {
        op: "+",
        args: [{ op: "*", args: [{ field: "openCount" }, 10] }, { field: "overdueCount" }],
      },
    });
    const leaves: string[] = [];
    walkViewExpr(mappings.find((m) => m.viewPath === "priority")!.expr!, (p) => leaves.push(p));
    expect(leaves).toEqual(["oldestSeverity", "rank"]);
  });

  it("sets nullable for division and nullable operands, not for coalesce", () => {
    const byPath = new Map(
      space()
        .getView(fx.VeQueue)
        .getViewColumnMappings()
        .map((m) => [m.viewPath, m]),
    );
    expect(byPath.get("rank")!.nullable).toBeUndefined();
    expect(byPath.get("avgEstimate")!.nullable).toBe(true);
    expect(byPath.get("priority")!.nullable).toBeUndefined();
    const cost = new Map(
      space()
        .getView(fx.VeIssueCost)
        .getViewColumnMappings()
        .map((m) => [m.viewPath, m]),
    );
    expect(cost.get("weight")!.nullable).toBeUndefined();
    expect(cost.get("doubleCost")!.nullable).toBe(true);
    expect(cost.get("total")!.nullable).toBe(true);
  });

  it("lists transitive operands in TDbFieldMeta.computed", () => {
    expect(computedOperands(fx.VeQueue, "priority")?.operands).toEqual([
      "oldestSeverity",
      "openCount",
      "overdueCount",
    ]);
    expect(computedOperands(fx.VeQueue, "title")).toBeUndefined();
    const view = space().getView(fx.VeIssueCost);
    const fd = view.fieldDescriptors.find((f) => f.path === "total")!;
    expect(fd.computed).toEqual({
      operands: ["cost", "estimate", "severity"],
      via: ["doubleCost", "weight"],
    });
    expect(view.fieldDescriptors.find((f) => f.path === "severity")!.computed).toBeUndefined();
  });
});

describe("computed columns — seals", () => {
  it("makes a computed field write-only when an operand is (transitively)", () => {
    const view = space().getView(fx.VeIssueCost);
    view.getViewColumnMappings();
    const props = fx.VeIssueCost.type.props;
    expect(props.get("cost").metadata.get("db.writeOnly")).toBe(true);
    expect(props.get("doubleCost").metadata.get("db.writeOnly")).toBe(true);
    expect(props.get("total").metadata.get("db.writeOnly")).toBe(true);
    expect(props.get("weight").metadata.has("db.writeOnly")).toBe(false);
  });

  it("rejects a write-only or encrypted first-row order key at first use (VJ6's runtime twin)", () => {
    expect(space().getView(fx.VeOrderGuard).viewPlan.joins[0].first).toBeDefined();
    const metadata = fx.VeGuardItem.type.props.get("rankKey").metadata as Map<string, unknown>;
    try {
      metadata.set("db.writeOnly", true);
      expect(() => space().getView(fx.VeOrderGuard).viewPlan).toThrow(
        'View "ve_order_guard": the first-row join on "ve_guard_items" cannot order by the @db.writeOnly field "rankKey"',
      );
      metadata.delete("db.writeOnly");
      metadata.set("db.encrypted", true);
      expect(() => space().getView(fx.VeOrderGuard).viewPlan).toThrow(
        'View "ve_order_guard": the first-row join on "ve_guard_items" cannot order by the @db.encrypted field "rankKey"',
      );
    } finally {
      metadata.delete("db.writeOnly");
      metadata.delete("db.encrypted");
    }
  });

  it("rejects an encrypted operand at first use", () => {
    expect(() => space().getView(fx.VeSecret).getViewColumnMappings()).toThrow(
      'View "ve_secret": @db.compute over the @db.encrypted field "secretScore" — ciphertext cannot be computed',
    );
  });
});

describe("view snapshot — order / expr keys", () => {
  it("emits the join ordering and the canonical expression", () => {
    const snap = computeViewSnapshot(space().getView(fx.VeQueue));
    expect(snap.joinTables![1]).toEqual({
      targetTable: "VeOldest",
      table: "ve_issues",
      condition: expect.any(String),
      kind: "left",
      order: '[["VeOldest.raised_at",1],["VeOldest.id",1]]',
    });
    expect(Object.keys(snap.joinTables![1])).toEqual([
      "targetTable",
      "table",
      "condition",
      "kind",
      "order",
    ]);
    expect(snap.joinTables![0].order).toBeUndefined();
    const rank = snap.columns!.find((c) => c.column === "rank")!;
    expect(rank).toEqual({
      column: "rank",
      sourceTable: "ve_tickets",
      sourceColumn: "",
      expr: '{"op":"+","a":[{"op":"*","a":[{"c":"openCount"},{"n":10}]},{"c":"overdueCount"}]}',
    });
    expect(snap.columns!.find((c) => c.column === "title")!.expr).toBeUndefined();
  });
});

describe("view hash — first-row ordering and expressions", () => {
  const hash = (type: unknown) =>
    computeTableHash({ ...computeViewSnapshot(space().getView(type as any)), tableName: "x" });

  it("equal models hash equal; order, direction, key, expression and operand changes alter it", () => {
    const base = hash(fx.VeHBase);
    expect(hash(fx.VeHSame)).toBe(base);
    for (const variant of [fx.VeHDesc, fx.VeHKey, fx.VeHExpr, fx.VeHOperand]) {
      expect(hash(variant)).not.toBe(base);
    }
  });
});
