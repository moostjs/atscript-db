import { describe, it, expect } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
import { DbRowActions, DbTableActions } from "../actions/db-actions.decorator";
import { fakeOverview, makeApp, makeTable } from "./actions-test-utils";

const PREFIX = "[moost-db actions]";

/**
 * Wire-shape coverage for the new `disabled` and `requiredFields` fields on
 * `TDbActionInfo`. These tests use the existing `fakeOverview` synthetic
 * meta to exercise the `discoverActions` emission path without needing a
 * full Moost HTTP runtime.
 */

describe("Action discovery — disabled + requiredFields wire emission", () => {
  it("emits disabled as fn.toString() and no requiredFields when not declared", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    const fn = (row: unknown) => (row as { status: string }).status !== "processing";
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "ship",
          httpMethod: "POST",
          path: "/orders/actions/ship",
          action: { name: "ship", opts: { label: "Ship", disabled: fn } },
          paramKinds: ["pk"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toHaveLength(1);
    expect(meta.actions[0].disabled).toBe(fn.toString());
    expect(meta.actions[0]).not.toHaveProperty("requiredFields");
  });

  it("forwards requiredFields verbatim (no merge, no auto-derivation)", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "ship",
          httpMethod: "POST",
          path: "/orders/actions/ship",
          action: {
            name: "ship",
            opts: {
              label: "Ship",
              disabled: (row: unknown) => (row as { status: string }).status !== "processing",
              requiredFields: ["status", "address.locked"],
            },
          },
          paramKinds: ["pk"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions[0].requiredFields).toEqual(["status", "address.locked"]);
  });

  it("emits a class-level dict entry's disabled.toString() and requiredFields", async () => {
    @DbRowActions({
      block: {
        label: "Block",
        processor: "backend",
        value: "/users/actions/block",
        disabled: (row: { blocked: boolean }) => row.blocked,
        requiredFields: ["blocked", "role"],
      },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toHaveLength(1);
    expect(typeof meta.actions[0].disabled).toBe("string");
    expect(meta.actions[0].disabled).toContain("blocked");
    expect(meta.actions[0].requiredFields).toEqual(["blocked", "role"]);
  });

  it("'table'-level + disabled emits a warning and DROPS the action", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "refresh",
          httpMethod: "POST",
          path: "/c/refresh",
          action: {
            name: "refresh",
            opts: { label: "Refresh", disabled: () => false },
          },
          paramKinds: [],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not allowed at the 'table' level"),
    );
  });

  it("requiredFields without disabled (method-decorator) warns and strips the field", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "ship",
          httpMethod: "POST",
          path: "/orders/actions/ship",
          action: { name: "ship", opts: { label: "Ship", requiredFields: ["status"] } },
          paramKinds: ["pk"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toHaveLength(1);
    expect(meta.actions[0]).not.toHaveProperty("requiredFields");
    expect(meta.actions[0]).not.toHaveProperty("disabled");
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("`requiredFields` without `disabled`"),
    );
  });

  it("requiredFields without disabled (class-level dict) warns and strips the field", async () => {
    @DbRowActions({
      block: {
        label: "Block",
        processor: "backend",
        value: "/users/actions/block",
        requiredFields: ["blocked"],
      },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toHaveLength(1);
    expect(meta.actions[0]).not.toHaveProperty("requiredFields");
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`\\${PREFIX}.*requiredFields.*disabled`)),
    );
  });

  it("'table'-level class-level dict + disabled is dropped with a warning", async () => {
    @DbTableActions({
      refresh: {
        label: "Refresh",
        processor: "custom",
        disabled: () => false,
      },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not allowed at the 'table' level"),
    );
  });

  it("capturing closure emits via fn.toString() — server does NOT validate cleanliness", async () => {
    const allowed = new Set(["processing"]);
    const captures = (row: unknown) => !allowed.has((row as { status: string }).status);
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "ship",
          httpMethod: "POST",
          path: "/orders/actions/ship",
          action: { name: "ship", opts: { label: "Ship", disabled: captures } },
          paramKinds: ["pk"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions[0].disabled).toBe(captures.toString());
    // server emits the closure as-is — no validation that closure-cleanliness
    // is an UI-side concern (UI behaviour with captures is documented as undefined).
    const tableLevelWarn = ctx.logger.warn.mock.calls.some(
      (args: unknown[]) => typeof args[0] === "string" && args[0].includes("captur"),
    );
    expect(tableLevelWarn).toBe(false);
  });
});

describe("Action discovery — body conflict with row decorators", () => {
  for (const [label, kinds] of [
    ["@DbActionPK + @Body", ["pk", "body"]],
    ["@DbActionPKs + @Body", ["pks", "body"]],
    ["@DbActionRow + @Body", ["row", "body"]],
    ["@DbActionRows + @Body", ["rows", "body"]],
  ] as const) {
    it(`rejects ${label}`, async () => {
      class C extends AsDbController {}
      const ctx = makeApp();
      const opts =
        kinds[0] === "row" || kinds[0] === "rows"
          ? { label: "Mix", disabled: () => false }
          : { label: "Mix" };
      ctx.setOverview([
        fakeOverview(C, [
          {
            method: "mix",
            httpMethod: "POST",
            path: "/c/mix",
            action: { name: "mix", opts },
            paramKinds: [...kinds],
          },
        ]),
      ]);
      const ctrl = new C(makeTable() as never, ctx.app);
      const meta = await ctrl.meta();
      expect(meta.actions).toEqual([]);
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("cannot mix"));
    });
  }
});
