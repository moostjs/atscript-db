import { describe, it, expect } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
import { DbRowActions, DbTableActions } from "../actions/db-actions.decorator";
import { fakeOverview, makeApp, makeTable } from "./actions-test-utils";

const disabledWhenNotProcessing = (rows: unknown[]) =>
  rows.map((row) => (row as { status: string }).status !== "processing");

/**
 * Wire-shape coverage for the `disabled` field on `TDbActionInfo`. These
 * tests use the existing `fakeOverview` synthetic meta to exercise the
 * `discoverActions` emission path without needing a full Moost HTTP runtime.
 */

describe("Action discovery — disabled wire emission", () => {
  it("emits disabled as fn.toString() and no requiredFields on the wire", async () => {
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
              requiredFields: ["status"],
              disabled: disabledWhenNotProcessing,
            },
          },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toHaveLength(1);
    expect(meta.actions[0].disabled).toBe(disabledWhenNotProcessing.toString());
    expect(meta.actions[0]).not.toHaveProperty("requiredFields");
  });

  it("requiredFields decorator opt is NEVER emitted on the wire", async () => {
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
              disabled: (rows: unknown[]) =>
                rows.map((row) => (row as { status: string }).status !== "processing"),
              requiredFields: ["status", "address.locked"],
            },
          },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions[0]).not.toHaveProperty("requiredFields");
  });

  it("class-level dict requiredFields is NEVER emitted on the wire", async () => {
    @DbRowActions({
      block: {
        label: "Block",
        processor: "backend",
        value: "/users/actions/block",
        disabled: (rows: { blocked: boolean }[]) => rows.map((row) => row.blocked),
        requiredFields: ["blocked", "role"],
      },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toHaveLength(1);
    expect(typeof meta.actions[0].disabled).toBe("string");
    expect(meta.actions[0].disabled).toContain("blocked");
    expect(meta.actions[0]).not.toHaveProperty("requiredFields");
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
            opts: { label: "Refresh", disabled: () => [false] },
          },
          paramKinds: [],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not allowed at the 'table' level"),
    );
  });

  it("requiredFields without disabled is silently dropped (server-only opt; never on the wire)", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "ship",
          httpMethod: "POST",
          path: "/orders/actions/ship",
          action: { name: "ship", opts: { label: "Ship", requiredFields: ["status"] } },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toHaveLength(1);
    expect(meta.actions[0]).not.toHaveProperty("requiredFields");
    expect(meta.actions[0]).not.toHaveProperty("disabled");
    const warned = ctx.logger.warn.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes("`requiredFields` without `disabled`"),
    );
    expect(warned).toBe(false);
  });

  it("'table'-level class-level dict + disabled is dropped with a warning", async () => {
    @DbTableActions({
      refresh: {
        label: "Refresh",
        processor: "custom",
        disabled: () => [false],
      },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not allowed at the 'table' level"),
    );
  });

  it("capturing closure emits via fn.toString() — server does NOT validate cleanliness", async () => {
    const allowed = new Set(["processing"]);
    const captures = (rows: unknown[]) =>
      rows.map((row) => !allowed.has((row as { status: string }).status));
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
            opts: { label: "Ship", requiredFields: ["status"], disabled: captures },
          },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
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
    ["@DbActionID + @Body", ["id", "body"]],
    ["@DbActionIDs + @Body", ["ids", "body"]],
    ["@DbActionRow + @Body", ["row", "body"]],
    ["@DbActionRows + @Body", ["rows", "body"]],
  ] as const) {
    it(`rejects ${label}`, async () => {
      class C extends AsDbController {}
      const ctx = makeApp();
      const opts =
        kinds[0] === "row" || kinds[0] === "rows"
          ? { label: "Mix", requiredFields: ["state"], disabled: () => [false] }
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
      const ctrl = new C(ctx.app, makeTable() as never);
      const meta = await ctrl.meta();
      expect(meta.actions).toEqual([]);
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("cannot mix"));
    });
  }
});
