import { describe, it, expect } from "vite-plus/test";
import { current } from "@wooksjs/event-core";
import { prepareTestHttpContext } from "@wooksjs/event-http";
import { getMoostMate } from "moost";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { InputForm } from "../actions/db-action-input-form.decorator";
import {
  MOOST_ATSCRIPT_TYPE,
  MOOST_DB_ACTION_INPUT_FORM,
  type TDbActionInputFormMeta,
} from "../actions/keys";
import { scanParamLevel } from "../actions/param-level";

/**
 * Unit coverage for the `@InputForm()` parameter decorator. We don't need a
 * real compiled `.as` here — the decorator only consumes `formType.name` and
 * passes `formType` straight through as metadata. Two `class` stubs stand in
 * for compiled atscript types.
 */

class CommentForm {
  static __is_atscript_annotated_type = true as const;
}
class AmountForm {
  static __is_atscript_annotated_type = true as const;
}

function readParamMate(target: object, methodName: string, paramIndex: number) {
  const meta = getMoostMate().read(target, methodName) as
    | { params?: Record<string, unknown>[] }
    | undefined;
  return meta?.params?.[paramIndex] ?? {};
}

describe("@InputForm — param mate", () => {
  it("stamps MOOST_DB_ACTION_INPUT_FORM with `{ type, name }`", () => {
    class Ctrl {
      handler(_input: CommentForm) {
        void _input;
      }
    }
    InputForm(CommentForm as unknown as TAtscriptAnnotatedType & { name: string })(
      Ctrl.prototype,
      "handler",
      0,
    );

    const param = readParamMate(Ctrl.prototype, "handler", 0);
    const meta = param[MOOST_DB_ACTION_INPUT_FORM] as TDbActionInputFormMeta;
    expect(meta).toBeDefined();
    expect(meta.name).toBe("CommentForm");
    expect(meta.type).toBe(CommentForm);
  });

  it("also stamps the generic MOOST_ATSCRIPT_TYPE key for pipe consumers", () => {
    class Ctrl {
      handler(_input: AmountForm) {
        void _input;
      }
    }
    InputForm(AmountForm as unknown as TAtscriptAnnotatedType & { name: string })(
      Ctrl.prototype,
      "handler",
      0,
    );

    const param = readParamMate(Ctrl.prototype, "handler", 0);
    expect(param[MOOST_ATSCRIPT_TYPE]).toBe(AmountForm);
  });
});

describe("@InputForm — level inference", () => {
  it("does not change the action's level (form-only action stays 'table')", () => {
    class Ctrl {
      handler(_input: CommentForm) {
        void _input;
      }
    }
    InputForm(CommentForm as unknown as TAtscriptAnnotatedType & { name: string })(
      Ctrl.prototype,
      "handler",
      0,
    );

    const meta = getMoostMate().read(Ctrl.prototype, "handler") as {
      params?: Record<string, unknown>[];
    };
    const scan = scanParamLevel(meta.params ?? []);
    expect(scan.level).toBe("table");
    expect(scan.inputForm).toEqual({ type: CommentForm, name: "CommentForm" });
    expect(scan.hasRowParam).toBe(false);
  });
});

describe("@InputForm — resolver reads body.input", () => {
  it("returns the envelope's `input` field via the registered resolver", async () => {
    // The decorator's Resolve function name is "dbActionInputForm" and it
    // closes over `current().get(dbActionInputSlot)`, which is an indirect
    // way of saying: reading the resolver value is equivalent to reading
    // dbActionInputSlot. Exercise the slot end-to-end here so we catch any
    // change to the wiring path.
    const { dbActionInputSlot } = await import("../actions/input-form-cache");
    const result = await prepareTestHttpContext({
      url: "/c/act",
      method: "POST",
      headers: { "content-type": "application/json" },
      rawBody: '{"input":{"note":"hi","visibility":"public"}}',
    })(async () => {
      return current().get(dbActionInputSlot);
    });
    expect(result).toEqual({ note: "hi", visibility: "public" });
  });
});
