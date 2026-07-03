import { describe, it, expect, beforeAll } from "vite-plus/test";
import { isAnnotationSpec, type AnnotationSpec, type TAnnotationsTree } from "@atscript/core";

import { AtscriptDbTable } from "../table/db-table";
import { dbAggAnnotations } from "../plugin/annotations/agg";
import { dbAmountAnnotations } from "../plugin/annotations/amount";
import { dbUnitAnnotations } from "../plugin/annotations/unit";
import { dbColumnAnnotations } from "../plugin/annotations/column";
import { dbIndexAnnotations } from "../plugin/annotations/index-ann";
import { dbRelAnnotations } from "../plugin/annotations/rel";
import { dbSearchAnnotations } from "../plugin/annotations/search";
import { prepareFixtures, MockAdapter } from "./test-utils";

// Populated by beforeAll after fixtures are compiled
let RefSource: any;
let RefOneHop: any;
let RefTwoHop: any;

// Regression for the ref-inherited annotation design gap: structural
// annotations (@db.index.*, @db.column.*, …) are declared with
// passedWhenReferred: false, so a field referencing another table's field
// (directly or through an intermediate dict/view interface) must NOT inherit
// them — while presentation annotations (@meta.label, …) must keep riding.
describe("ref-inherited annotation scoping", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/ref-scope.as");
    RefSource = fixtures.RefSource;
    RefOneHop = fixtures.RefOneHop;
    RefTwoHop = fixtures.RefTwoHop;
  });

  it("keeps declared indexes and preferredId on the declaring table", () => {
    const table = new AtscriptDbTable(RefSource, new MockAdapter());
    const names = [...table.indexes.values()].map((i) => i.name);
    expect(names).toContain("by_code");
    expect(table.preferredId).toEqual(["code"]);
  });

  it("does not materialize a phantom index from a one-hop FK ref", () => {
    const table = new AtscriptDbTable(RefOneHop, new MockAdapter());
    const names = [...table.indexes.values()].map((i) => i.name);
    expect(names).not.toContain("by_code");
    expect(table.uniqueProps.has("code")).toBe(false);
  });

  it("does not materialize a phantom index from a two-hop ref through a dict interface", () => {
    const table = new AtscriptDbTable(RefTwoHop, new MockAdapter());
    const names = [...table.indexes.values()].map((i) => i.name);
    // The incident shape: FK → dict field → source field carrying
    // @db.index.unique. The inherited entry used to create a unique index
    // ("at most one row per code") on the referring table.
    expect(names).not.toContain("by_code");
    // The locally declared index is untouched
    expect(names).toContain("by_local");
  });

  it("does not inherit @meta.id through refs", () => {
    const oneHop = new AtscriptDbTable(RefOneHop, new MockAdapter());
    const twoHop = new AtscriptDbTable(RefTwoHop, new MockAdapter());
    expect(oneHop.primaryKeys).toEqual(["_id"]);
    expect(twoHop.primaryKeys).toEqual(["_id"]);
  });

  it("does not inherit sibling-ref quantity bindings, but literal quantity tags ride", () => {
    // @db.amount.currency.ref names a sibling of the DECLARING interface;
    // RefOneHop has no "currency" field, so an inherited binding would make
    // "total" un-aggregatable (the guard demands a nonexistent $groupBy field).
    const total = RefOneHop.type.props.get("total");
    expect(total.metadata.has("db.amount.currency.ref")).toBe(false);
    // The literal form is value context and travels with the field
    const weight = RefOneHop.type.props.get("weight");
    expect(weight.metadata.get("db.unit")).toBe("kg");

    const table = new AtscriptDbTable(RefOneHop, new MockAdapter());
    expect(table.getMetadata().quantityRefByField.has("total")).toBe(false);
  });

  it("still inherits presentation annotations across refs at every depth", () => {
    const oneHopField = RefOneHop.type.props.get("code");
    const twoHopField = RefTwoHop.type.props.get("code");
    expect(oneHopField.metadata.get("meta.label")).toBe("Code");
    expect(twoHopField.metadata.get("meta.label")).toBe("Code");
    // And the structural annotation is absent from the compiled metadata itself
    expect(oneHopField.metadata.has("db.index.unique")).toBe(false);
    expect(twoHopField.metadata.get("db.index.unique")).toEqual(["by_local"]);
  });
});

// The scoping above only works if every structural spec opts out of ref
// inheritance individually — a new annotation that forgets the flag silently
// reintroduces the phantom-index bug. Enforce the invariant over the trees.
describe("structural annotation trees", () => {
  const structuralTrees: Record<string, TAnnotationsTree> = {
    agg: dbAggAnnotations,
    column: dbColumnAnnotations,
    index: dbIndexAnnotations,
    rel: dbRelAnnotations,
    search: dbSearchAnnotations,
  };

  function collectPropSpecs(tree: TAnnotationsTree, path: string): Array<[string, AnnotationSpec]> {
    const specs: Array<[string, AnnotationSpec]> = [];
    for (const [key, node] of Object.entries(tree)) {
      if (isAnnotationSpec(node)) {
        specs.push([`${path}.${key}`, node]);
      } else if (node) {
        specs.push(...collectPropSpecs(node, `${path}.${key}`));
      }
    }
    return specs;
  }

  it("declares every prop-level structural annotation with passedWhenReferred: false", () => {
    const missing = Object.entries(structuralTrees)
      .flatMap(([name, tree]) => collectPropSpecs(tree, name))
      .filter(
        ([, spec]) =>
          spec.config.nodeType?.includes("prop") && spec.config.passedWhenReferred !== false,
      )
      .map(([path]) => path);
    expect(missing).toEqual([]);
  });

  // The amount/unit trees are mixed by design — the literal forms
  // (@db.amount.currency, @db.unit) are value context and travel, while the
  // sibling-ref bindings name a field of the declaring interface and must not.
  it("declares the quantity sibling-ref bindings with passedWhenReferred: false, literals without", () => {
    const amount = (dbAmountAnnotations.amount as Record<string, any>).currency;
    const unit = dbUnitAnnotations.unit as Record<string, any>;
    expect(amount.ref.config.passedWhenReferred).toBe(false);
    expect(unit.ref.config.passedWhenReferred).toBe(false);
    expect(amount.$self.config.passedWhenReferred).toBeUndefined();
    expect(unit.$self.config.passedWhenReferred).toBeUndefined();
  });
});
