import type { SemanticNode, Token } from "@atscript/core";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveAnnotationNames,
  validateExclusiveWith,
  validateIncompatible,
} from "../shared/annotation-utils";

// Plugins built against <= 0.1.161 call these helpers without the `doc`
// argument added in 0.1.162 — they must keep working on own annotations.

function fieldWith(...names: string[]) {
  return {
    annotations: names.map((name) => ({ name })),
    countAnnotations: (key: string) => names.filter((n) => n === key).length,
  } as unknown as SemanticNode;
}

function tokenOn(field: SemanticNode) {
  return { parentNode: field, range: {} } as unknown as Token;
}

describe("shared annotation helpers without a doc", () => {
  it("effectiveAnnotationNames falls back to own annotations", () => {
    expect([...effectiveAnnotationNames(fieldWith("a", "b"))]).toEqual(["a", "b"]);
  });

  it("validateExclusiveWith reports own conflicts", () => {
    const errors = validateExclusiveWith(tokenOn(fieldWith("x.self", "x.other")), "@x.self", [
      { key: "x.other" },
      { key: "x.absent" },
    ]);
    expect(errors.map((e) => e.message)).toEqual([
      "@x.self cannot coexist with @x.other on the same field — pick one form, not both",
    ]);
  });

  it("validateIncompatible reports own conflicts", () => {
    const errors = validateIncompatible(tokenOn(fieldWith("x.self", "x.other")), "@x.self", [
      ["x.other", "why"],
      ["x.absent", "why"],
    ]);
    expect(errors.map((e) => e.message)).toEqual(["@x.self cannot coexist with @x.other — why"]);
  });
});
