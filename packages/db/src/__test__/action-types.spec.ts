import { describe, it, expect, expectTypeOf } from "vite-plus/test";

import type {
  TDbActionInfo,
  TDbActionLevel,
  TDbActionIntent,
  TDbActionProcessor,
  TMetaResponse,
} from "../index";

describe("@atscript/db action types — public surface", () => {
  it("TDbActionLevel is the union 'table' | 'row' | 'rows'", () => {
    expectTypeOf<TDbActionLevel>().toEqualTypeOf<"table" | "row" | "rows">();
  });

  it("TDbActionIntent is the union of the five UI-mappable semantics", () => {
    expectTypeOf<TDbActionIntent>().toEqualTypeOf<
      "positive" | "negative" | "warning" | "primary" | "secondary"
    >();
  });

  it("TDbActionProcessor is the union 'backend' | 'navigate' | 'custom'", () => {
    expectTypeOf<TDbActionProcessor>().toEqualTypeOf<"backend" | "navigate" | "custom">();
  });

  it("TDbActionInfo has flat shape with required name/label/level/processor/value", () => {
    const info: TDbActionInfo = {
      name: "block",
      label: "Block",
      level: "row",
      processor: "backend",
      value: "/users/actions/block",
    };
    expect(info).toBeDefined();
    expectTypeOf(info.name).toEqualTypeOf<string>();
    expectTypeOf(info.label).toEqualTypeOf<string>();
    expectTypeOf(info.level).toEqualTypeOf<TDbActionLevel>();
    expectTypeOf(info.processor).toEqualTypeOf<TDbActionProcessor>();
    expectTypeOf(info.value).toEqualTypeOf<string>();
  });

  it("TMetaResponse.actions is a TDbActionInfo[]", () => {
    expectTypeOf<TMetaResponse["actions"]>().toEqualTypeOf<TDbActionInfo[]>();
  });

  it("TDbActionInfo.shortcut is an optional string", () => {
    expectTypeOf<TDbActionInfo["shortcut"]>().toEqualTypeOf<string | undefined>();
  });

  it("TDbActionInfo.promptText accepts string | [string, string]", () => {
    expectTypeOf<TDbActionInfo["promptText"]>().toEqualTypeOf<
      string | [string, string] | undefined
    >();
  });
});
