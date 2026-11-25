import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import type { SemanticStructureNode } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, it, expect } from "vite-plus/test";

import dbPlugin from "../plugin";
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

  it("with the declaring document, the dimensions a table inherits count", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "strict-aggregate-"));
    writeFileSync(
      join(rootDir, "fixture.as"),
      `
export interface SaBase {
    @meta.id
    id: string

    @db.column.dimension
    region: string
}

@db.table 'sa_sales'
export interface SaSale extends SaBase {
    amount: number
}
`,
    );
    const repo = await build({
      rootDir,
      entries: ["fixture.as"],
      plugins: [tsPlugin(), dbPlugin()],
    });
    const doc = repo.getDoc(`file://${join(rootDir, "fixture.as")}`)!;
    const sale = doc.getDeclarationOwnerNode("SaSale")!.node!;
    const struct = sale.getDefinition() as SemanticStructureNode;
    expect(isStrictAggregateStruct(struct, doc)).toBe(true);
    // without a document: the structure's own fields only, as before 0.1.192
    expect(isStrictAggregateStruct(struct)).toBe(false);
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
