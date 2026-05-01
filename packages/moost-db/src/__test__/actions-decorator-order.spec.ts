import { describe, it, expect } from "vite-plus/test";
import { getMoostMate } from "moost";

import { DbAction } from "../actions/db-action.decorator";
import { DbActionDefault } from "../actions/db-action-default.decorator";
import { MOOST_DB_ACTION, type TDbActionMeta } from "../actions/keys";
import { AsDbController } from "../as-db.controller";
import { fakeOverview, makeApp, makeTable } from "./actions-test-utils";

/**
 * Decorator order between `@DbAction` and `@DbActionDefault` MUST be
 * irrelevant. TS evaluates decorators bottom-up, so a naive value-set
 * `mate.decorate(KEY, value)` inside `@DbAction` would clobber an entry
 * seeded by a later-positioned `@DbActionDefault()`. The implementation
 * therefore uses the functional decorator form and merges with whatever
 * exists on the same key.
 */

function readActionMeta(target: object, propKey: string): TDbActionMeta | undefined {
  const meta = getMoostMate().read(target, propKey) as
    | { [MOOST_DB_ACTION]?: TDbActionMeta }
    | undefined;
  return meta?.[MOOST_DB_ACTION];
}

describe("@DbAction + @DbActionDefault — decorator order independence", () => {
  it("preserves opts.label when @DbActionDefault is below @DbAction (DbActionDefault evaluates first)", () => {
    class Ctrl {
      @DbAction("edit", { label: "Edit" })
      @DbActionDefault()
      edit() {}
    }
    const meta = readActionMeta(Ctrl.prototype, "edit");
    expect(meta).toEqual({ name: "edit", opts: { label: "Edit", default: true } });
  });

  it("preserves opts.label when @DbActionDefault is above @DbAction (DbAction evaluates first)", () => {
    class Ctrl {
      @DbActionDefault()
      @DbAction("edit", { label: "Edit" })
      edit() {}
    }
    const meta = readActionMeta(Ctrl.prototype, "edit");
    expect(meta).toEqual({ name: "edit", opts: { label: "Edit", default: true } });
  });

  it("opts.default = true on @DbAction matches @DbActionDefault output regardless of order", () => {
    class Inline {
      @DbAction("edit", { label: "Edit", default: true })
      edit() {}
    }
    class WithDefault {
      @DbAction("edit", { label: "Edit" })
      @DbActionDefault()
      edit() {}
    }
    expect(readActionMeta(Inline.prototype, "edit")).toEqual(
      readActionMeta(WithDefault.prototype, "edit"),
    );
  });

  it("merges all opts fields across both decorator orders", () => {
    class Above {
      @DbActionDefault()
      @DbAction("edit", { label: "Edit", icon: "i-as-edit", intent: "primary", order: 5 })
      edit() {}
    }
    class Below {
      @DbAction("edit", { label: "Edit", icon: "i-as-edit", intent: "primary", order: 5 })
      @DbActionDefault()
      edit() {}
    }
    const expected: TDbActionMeta = {
      name: "edit",
      opts: { label: "Edit", icon: "i-as-edit", intent: "primary", order: 5, default: true },
    };
    expect(readActionMeta(Above.prototype, "edit")).toEqual(expected);
    expect(readActionMeta(Below.prototype, "edit")).toEqual(expected);
  });

  it("surfaces default: true through /meta in both decorator orders", async () => {
    class A extends AsDbController {}
    class B extends AsDbController {}
    const ctxA = makeApp();
    const ctxB = makeApp();
    ctxA.setOverview([
      fakeOverview(A, [
        {
          method: "edit",
          httpMethod: "POST",
          path: "/a/edit",
          action: { name: "edit", opts: { label: "Edit", default: true } },
          paramKinds: ["id"],
        },
      ]),
    ]);
    ctxB.setOverview([
      fakeOverview(B, [
        {
          method: "edit",
          httpMethod: "POST",
          path: "/b/edit",
          action: { name: "edit", opts: { label: "Edit", default: true } },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const a = await new A(makeTable() as never, ctxA.app).meta();
    const b = await new B(makeTable() as never, ctxB.app).meta();
    expect(a.actions[0].default).toBe(true);
    expect(b.actions[0].default).toBe(true);
  });
});

describe("@DbActionDefault without @DbAction — drops with warning", () => {
  it("drops a method that has @DbActionDefault but no @DbAction(name)", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    // Mimic the metadata @DbActionDefault would seed alone: name: "", opts.default: true
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "stranded",
          httpMethod: "POST",
          path: "/c/stranded",
          action: { name: "", opts: { default: true } },
          paramKinds: [],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("@DbActionDefault() but no @DbAction"),
    );
  });
});
