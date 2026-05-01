import { describe, it, expect } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
import { DbRowActions } from "../actions/db-actions.decorator";
import { fakeOverview, makeApp, makeTable } from "./actions-test-utils";

/**
 * Wire-shape coverage for additive `TDbActionInfo` fields:
 *   - `shortcut` (single-character UI hint)
 *   - tuple `promptText` ([singular, plural])
 *   - `'warning'` value on `intent`
 *
 * All three are pure passthrough; the discovery layer must forward them
 * unchanged on both the method-decorator and class-level-dict paths.
 */

describe("Action discovery — shortcut / tuple promptText / 'warning' intent", () => {
  it("forwards shortcut, tuple promptText, and 'warning' intent (method-decorator)", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    const promptTuple: [string, string] = ["Delete order $1?", "Delete $N orders?"];
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "del",
          httpMethod: "POST",
          path: "/orders/actions/del",
          action: {
            name: "del",
            opts: {
              label: "Delete",
              intent: "warning",
              shortcut: "K",
              promptText: promptTuple,
            },
          },
          paramKinds: ["pks"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toHaveLength(1);
    expect(meta.actions[0].intent).toBe("warning");
    expect(meta.actions[0].shortcut).toBe("K");
    expect(meta.actions[0].promptText).toEqual(promptTuple);
  });

  it("defensively clones the tuple promptText so the cached wire is independent of the source array", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    const promptTuple: [string, string] = ["Delete order $1?", "Delete $N orders?"];
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "del",
          httpMethod: "POST",
          path: "/orders/actions/del",
          action: { name: "del", opts: { label: "Delete", promptText: promptTuple } },
          paramKinds: ["pks"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions[0].promptText).not.toBe(promptTuple);
    expect(meta.actions[0].promptText).toEqual(promptTuple);
  });

  it("forwards a string promptText verbatim (no array wrapping)", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "del",
          httpMethod: "POST",
          path: "/orders/actions/del",
          action: { name: "del", opts: { label: "Delete", promptText: "Delete this row?" } },
          paramKinds: ["pk"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions[0].promptText).toBe("Delete this row?");
  });

  it("forwards shortcut, tuple promptText, and 'warning' intent (class-level dict)", async () => {
    @DbRowActions({
      retry: {
        label: "Retry payment",
        processor: "backend",
        value: "/payments/actions/retry",
        intent: "warning",
        shortcut: "R",
        promptText: ["Retry payment for $1?", "Retry $N payments?"],
      },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toHaveLength(1);
    expect(meta.actions[0].intent).toBe("warning");
    expect(meta.actions[0].shortcut).toBe("R");
    expect(meta.actions[0].promptText).toEqual(["Retry payment for $1?", "Retry $N payments?"]);
  });

  it("omits shortcut / promptText / intent when not declared (no leaked undefined keys)", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "del",
          httpMethod: "POST",
          path: "/orders/actions/del",
          action: { name: "del", opts: { label: "Delete" } },
          paramKinds: ["pks"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions[0]).not.toHaveProperty("shortcut");
    expect(meta.actions[0]).not.toHaveProperty("promptText");
    expect(meta.actions[0]).not.toHaveProperty("intent");
  });
});
