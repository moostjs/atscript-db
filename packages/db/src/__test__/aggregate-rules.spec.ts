import { describe, it, expect } from "vite-plus/test";

import { NOT_DIMENSION_REASON, isStrictAggregateStruct } from "../shared";
import { groupSourceVerdict } from "../query/query-guards";

function struct(...props: Array<string[]>) {
  return {
    props: new Map(
      props.map((annotations, i) => [
        `f${i}`,
        { countAnnotations: (name: string) => annotations.filter((a) => a === name).length },
      ]),
    ),
  } as never;
}

describe("editor-time strict aggregate rule", () => {
  it("a structure with a dimension or a measure is strict", () => {
    expect(isStrictAggregateStruct(struct([], ["db.column.dimension"]))).toBe(true);
    expect(isStrictAggregateStruct(struct(["db.column.measure"]))).toBe(true);
  });

  it("a structure without dimensions or measures is not strict", () => {
    expect(isStrictAggregateStruct(struct([], ["db.column.filterable"]))).toBe(false);
    expect(isStrictAggregateStruct(struct())).toBe(false);
  });

  it("the runtime verdict words its rejection with the shared reason", () => {
    const verdict = groupSourceVerdict(
      { path: "note" } as never,
      { dimensions: ["id"], measures: [] },
      { canFilterField: () => true },
    );
    expect(verdict).toEqual({ ok: false, code: "notDimension", reason: NOT_DIMENSION_REASON });
  });
});
