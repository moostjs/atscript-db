import { describe, it, expect } from "vite-plus/test";
import { isAnnotationSpec, type AnnotationSpec, type TAnnotationsTree } from "@atscript/core";

import { annotations } from "../plugin/annotations";

// Every prop-level @db.mysql.* annotation is structural (native types, charset,
// collation, ON UPDATE) and must not be inherited by fields referencing the
// annotated field — a new spec that forgets passedWhenReferred: false silently
// reintroduces the ref-inheritance leak for this adapter.
describe("mysql annotation tree ref scoping", () => {
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

  it("declares every prop-level annotation with passedWhenReferred: false", () => {
    const missing = collectPropSpecs(annotations, "mysql")
      .filter(
        ([, spec]) =>
          spec.config.nodeType?.includes("prop") && spec.config.passedWhenReferred !== false,
      )
      .map(([path]) => path);
    expect(missing).toEqual([]);
  });
});
