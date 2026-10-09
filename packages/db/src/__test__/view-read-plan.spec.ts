import { beforeAll, describe, expect, it } from "vite-plus/test";

import { AtscriptDbView, DbSpace, queryReadColumns, UniquSelect } from "../index";
import { ResolvedRelationFilter } from "../query/relation-filter";
import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

// AtscriptDbView.readPlan (since 0.1.153): which LEFT joins a read may drop.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-read-plan.as");
});

const view = (type: unknown, nested = false) =>
  new DbSpace(() => (nested ? new NestedMockAdapter() : new MockAdapter())).getView(
    type as never,
  ) as AtscriptDbView;

/** The scopes a read of `needed` drops (`[]` when nothing). */
const dropped = (type: unknown, needed?: string[], nested = false) =>
  view(type, nested).readPlan(needed)?.dropped ?? [];

describe("readPlan — chained joins", () => {
  it("drops both joins when only entry columns are read", () => {
    expect(dropped(fx.RpChain, ["id"])).toEqual(["rp_b", "rp_c"]);
  });

  it("keeps the earlier join a needed later join's ON reads", () => {
    expect(dropped(fx.RpChain, ["cName"])).toEqual([]);
  });

  it("drops the later join only", () => {
    expect(dropped(fx.RpChain, ["bName"])).toEqual(["rp_c"]);
  });

  it("a computed column keeps its operands' joins", () => {
    expect(dropped(fx.RpChain, ["dbl"])).toEqual(["rp_c"]);
  });

  it("every column (undefined) drops nothing that a column reads", () => {
    expect(view(fx.RpChain).readPlan(undefined)).toBeUndefined();
  });

  it("names that are no column (aggregate aliases) are ignored", () => {
    expect(dropped(fx.RpChain, ["id", "n_alias"])).toEqual(["rp_b", "rp_c"]);
  });

  it("the variant lists its remaining and dropped columns; memoised per dropped set", () => {
    const v = view(fx.RpChain);
    const plan = v.readPlan(["id"])!;
    expect(plan.columns.map((c) => c.viewColumn)).toEqual(["id"]);
    expect(plan.droppedColumns).toEqual(["bName", "cName", "bScore", "dbl"]);
    expect(plan.plan.joins).toEqual([]);
    expect(plan.plan.entryTable).toBe("rp_a");
    expect(v.readPlan([])).toBe(plan);
    const partial = v.readPlan(["bName"])!;
    expect(partial.columns.map((c) => c.viewColumn)).toEqual(["id", "bName", "bScore", "dbl"]);
    expect(partial.key).not.toBe(plan.key);
  });
});

describe("readPlan — at most one match", () => {
  it("an equality on every column of a composite unique key", () => {
    expect(dropped(fx.RpComposite, ["id"])).toEqual(["rp_d"]);
  });

  it("part of a unique key (other conjuncts do not pin it)", () => {
    expect(dropped(fx.RpCompositePartial, ["id"])).toEqual([]);
  });

  it("a literal pins a key column; extra conjuncts only narrow", () => {
    expect(dropped(fx.RpCompositeLiteral, ["id"])).toEqual(["rp_d"]);
  });

  it("an $or condition proves nothing", () => {
    expect(dropped(fx.RpCompositeOr, ["id"])).toEqual([]);
  });

  it("a comparison across design types pins nothing", () => {
    expect(dropped(fx.RpCompositeTypes, ["id"])).toEqual([]);
  });

  it("a comparison across collations pins nothing", () => {
    expect(dropped(fx.RpCollate, ["id"])).toEqual([]);
  });

  it("a left first-row join is droppable, an inner one never", () => {
    expect(dropped(fx.RpFirst, ["id"])).toEqual(["rp_n"]);
    expect(dropped(fx.RpFirstInner, ["id"])).toEqual([]);
  });

  it("an optional unique key: droppable on SQL, not on a document store", () => {
    expect(dropped(fx.RpOptionalKey, ["id"])).toEqual(["rp_g"]);
    expect(dropped(fx.RpOptionalKey, ["id"], true)).toEqual([]);
  });

  it("a join to a view is never dropped", () => {
    expect(dropped(fx.RpViewTarget, ["id"])).toEqual([]);
  });
});

describe("readPlan — what is never pruned", () => {
  it("inner joins (the aliased left join beside one is)", () => {
    expect(dropped(fx.RpInner, ["id"])).toEqual(["RpB2"]);
  });

  it("a join the view filter reads", () => {
    expect(dropped(fx.RpFiltered, ["id"])).toEqual(["RpB2"]);
  });

  it("grouped views", () => {
    expect(view(fx.RpGrouped).readPlan(["name"])).toBeUndefined();
  });

  it("a view without a table resolver (uniqueness unknown)", () => {
    const v = new AtscriptDbView(fx.RpChain, new MockAdapter());
    expect(v.readPlan(["id"])).toBeUndefined();
  });
});

const q = (filter: object, controls: object = {}) => ({ filter, controls }) as never;

describe("queryReadColumns", () => {
  it("rows: filter, sort and projection; no projection = every column", () => {
    expect(
      queryReadColumns(
        q(
          { $or: [{ a: 1 }, { $not: { b: { $gt: 1 } } }] },
          { $select: new UniquSelect(["c"]), $sort: { d: 1 } },
        ),
        "rows",
      ),
    ).toEqual(new Set(["a", "b", "c", "d"]));
    expect(queryReadColumns(q({ a: 1 }), "rows")).toBeUndefined();
    expect(queryReadColumns(q({}, { $select: new UniquSelect([]) }), "rows")).toBeUndefined();
  });

  it("count: the filter only", () => {
    expect(queryReadColumns(q({ a: 1 }, { $sort: { d: 1 } }), "count")).toEqual(new Set(["a"]));
  });

  it("an unknown top-level operator reads everything", () => {
    expect(queryReadColumns(q({ $text: "x" }), "count")).toBeUndefined();
  });

  it("field-to-field operands and relational correlation columns", () => {
    const rel = new ResolvedRelationFilter({
      kind: "via",
      nav: "tags",
      source: { table: "v" } as never,
      target: { table: "t" } as never,
      pairs: [],
      junction: {
        table: "j",
        toSource: [{ junction: "vid", source: "vkey" }],
        toTarget: [{ junction: "tid", target: "id" }],
      } as never,
      filter: {},
    });
    expect(
      queryReadColumns(q({ a: { $eq: { $field: "b" } }, tags: { $some: rel } }), "count"),
    ).toEqual(new Set(["a", "b", "tags", "vkey"]));
  });

  it("aggregate: group keys, aggregate sources, having keys", () => {
    const select = new UniquSelect(["g", { $fn: "sum", $field: "amt", $as: "s" }]);
    expect(
      queryReadColumns(
        q({ f: 1 }, { $select: select, $groupBy: ["g"], $having: { s: { $gt: 1 } } }),
        "aggregate",
      ),
    ).toEqual(new Set(["f", "g", "amt", "s"]));
  });
});
