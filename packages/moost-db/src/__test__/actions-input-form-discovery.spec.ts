import { describe, it, expect } from "vite-plus/test";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { discoverActions, getControllerFormType } from "../actions/discover";
import { fakeOverview, idMate, inputFormMate, makeApp } from "./actions-test-utils";

/**
 * Coverage for `inputForm` flowing through `discoverActions` into both
 * `TDbActionInfo.inputForm` and the per-controller form registry that backs
 * `GET /meta/form/:name`.
 */

class CommentForm {
  static __is_atscript_annotated_type = true as const;
}
class AmountForm {
  static __is_atscript_annotated_type = true as const;
}

describe("discoverActions — inputForm propagation", () => {
  it("emits `inputForm: <name>` on the action info when an @InputForm param is present", () => {
    class Ctrl {
      approve() {}
    }
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(Ctrl, [
        {
          method: "approve",
          httpMethod: "POST",
          path: "/orders/actions/approve",
          action: { name: "approve", opts: { label: "Approve" } },
          paramMates: [
            idMate(),
            inputFormMate(CommentForm as unknown as TAtscriptAnnotatedType & { name: string }),
          ],
        },
      ]),
    ]);

    const actions = discoverActions(Ctrl, ctx.app, ctx.logger);
    expect(actions).toHaveLength(1);
    expect(actions[0].info.inputForm).toBe("CommentForm");
    expect(actions[0].info.level).toBe("row");
  });

  it("registers the form type so `getControllerFormType` can serve `/meta/form/:name`", () => {
    class Ctrl {
      transfer() {}
    }
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(Ctrl, [
        {
          method: "transfer",
          httpMethod: "POST",
          path: "/accounts/actions/transfer",
          action: { name: "transfer", opts: { label: "Transfer" } },
          paramMates: [
            inputFormMate(AmountForm as unknown as TAtscriptAnnotatedType & { name: string }),
          ],
        },
      ]),
    ]);

    discoverActions(Ctrl, ctx.app, ctx.logger);
    expect(getControllerFormType(Ctrl, "AmountForm")).toBe(AmountForm);
    expect(getControllerFormType(Ctrl, "Unknown")).toBeUndefined();
  });

  it("does NOT set `inputForm` when the action has no @InputForm param", () => {
    class Ctrl {
      block() {}
    }
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(Ctrl, [
        {
          method: "block",
          httpMethod: "POST",
          path: "/users/actions/block",
          action: { name: "block", opts: { label: "Block" } },
          paramMates: [idMate()],
        },
      ]),
    ]);

    const actions = discoverActions(Ctrl, ctx.app, ctx.logger);
    expect(actions[0].info.inputForm).toBeUndefined();
    expect(getControllerFormType(Ctrl, "anything")).toBeUndefined();
  });

  it("reusing the same FormType across multiple actions is allowed (no dropping)", () => {
    class Ctrl {
      one() {}
      two() {}
    }
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(Ctrl, [
        {
          method: "one",
          httpMethod: "POST",
          path: "/x/actions/one",
          action: { name: "one", opts: { label: "One" } },
          paramMates: [
            inputFormMate(CommentForm as unknown as TAtscriptAnnotatedType & { name: string }),
          ],
        },
        {
          method: "two",
          httpMethod: "POST",
          path: "/x/actions/two",
          action: { name: "two", opts: { label: "Two" } },
          paramMates: [
            inputFormMate(CommentForm as unknown as TAtscriptAnnotatedType & { name: string }),
          ],
        },
      ]),
    ]);

    const actions = discoverActions(Ctrl, ctx.app, ctx.logger);
    expect(actions.map((a) => a.info.name)).toEqual(["one", "two"]);
    expect(actions.every((a) => a.info.inputForm === "CommentForm")).toBe(true);
  });

  it("colliding form names with different type refs drops the second action with a warning", () => {
    class Ctrl {
      first() {}
      second() {}
    }
    // Two distinct anonymous classes with the same `name`.
    const FormA = class CollidingForm {
      static __is_atscript_annotated_type = true as const;
    };
    const FormB = class CollidingForm {
      static __is_atscript_annotated_type = true as const;
    };
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(Ctrl, [
        {
          method: "first",
          httpMethod: "POST",
          path: "/x/actions/first",
          action: { name: "first", opts: { label: "First" } },
          paramMates: [
            inputFormMate(FormA as unknown as TAtscriptAnnotatedType & { name: string }),
          ],
        },
        {
          method: "second",
          httpMethod: "POST",
          path: "/x/actions/second",
          action: { name: "second", opts: { label: "Second" } },
          paramMates: [
            inputFormMate(FormB as unknown as TAtscriptAnnotatedType & { name: string }),
          ],
        },
      ]),
    ]);

    const actions = discoverActions(Ctrl, ctx.app, ctx.logger);
    expect(actions.map((a) => a.info.name)).toEqual(["first"]);
    expect(ctx.logger.warn).toHaveBeenCalled();
    // The first wins: the registry maps "CollidingForm" → FormA.
    expect(getControllerFormType(Ctrl, "CollidingForm")).toBe(FormA);
  });
});
