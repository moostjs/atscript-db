import { describe, it, expect } from "vite-plus/test";
import { current } from "@wooksjs/event-core";
import { prepareTestHttpContext } from "@wooksjs/event-http";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { InputForm } from "../actions/db-action-input-form.decorator";
import { scanParamLevel } from "../actions/param-level";
import { getAtscriptDbMate } from "../mate";

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
  return getAtscriptDbMate().read(target, methodName)?.params?.[paramIndex];
}

describe("@InputForm — param mate", () => {
  it("stamps atscript_db_action_input_form with `{ type, name }`", () => {
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

    const meta = readParamMate(Ctrl.prototype, "handler", 0)?.atscript_db_action_input_form;
    expect(meta).toBeDefined();
    expect(meta?.name).toBe("CommentForm");
    expect(meta?.type).toBe(CommentForm);
  });

  it("also stamps the generic atscript_type key for pipe consumers", () => {
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
    expect(param?.atscript_type).toBe(AmountForm);
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

    const meta = getAtscriptDbMate().read(Ctrl.prototype, "handler");
    const scan = scanParamLevel(meta?.params ?? []);
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
