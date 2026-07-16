import { describe, it, expect, vi } from "vite-plus/test";
import type { TConsoleBase } from "moost";

import { AsDbController } from "../as-db.controller";
import { discoverActions, discoverRowLevelActions } from "../actions/discover";
import { fakeOverview, makeApp, makeTable } from "./actions-test-utils";

describe("Action discovery timing (lazy on first /meta)", () => {
  it("does not run action discovery during controller construction", () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "broken",
          httpMethod: "GET",
          path: "/c/broken",
          action: { name: "broken", opts: { label: "Broken" } },
          paramKinds: [],
        },
      ]),
    ]);
    new C(ctx.app, makeTable() as never);
    // Discovery is the only thing that emits the [moost-db actions] warning prefix,
    // so its absence at construction proves discovery hasn't run yet.
    const warned = ctx.logger.warn.mock.calls.some((args: unknown[]) =>
      typeof args[0] === "string" ? args[0].includes("[moost-db actions]") : false,
    );
    expect(warned).toBe(false);
  });

  it("emits warnings on first /meta call, not at construction", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "broken",
          httpMethod: "GET",
          path: "/c/broken",
          action: { name: "broken", opts: { label: "Broken" } },
          paramKinds: [],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    await ctrl.meta();
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("[moost-db actions]"));
  });

  it("discoverRowLevelActions returns the same array reference on repeat calls (memoized per ctor)", () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "ship",
          httpMethod: "POST",
          path: "/c/ship",
          action: {
            name: "ship",
            opts: { label: "Ship", requiredFields: ["state"], disabled: () => [false] },
          },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const first = discoverRowLevelActions(C, ctx.app, ctx.logger as unknown as TConsoleBase);
    const second = discoverRowLevelActions(C, ctx.app, ctx.logger as unknown as TConsoleBase);
    expect(first).toBe(second);
    // And it's the row-level subset of discoverActions, not the full list.
    const all = discoverActions(C, ctx.app, ctx.logger as unknown as TConsoleBase);
    expect(first.every((e) => e.info.level === "row" || e.info.level === "rows")).toBe(true);
    expect(first.length).toBeLessThanOrEqual(all.length);
  });

  it("caches /meta — second meta() reuses the cached envelope", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "noop",
          httpMethod: "POST",
          path: "/c/noop",
          action: { name: "noop", opts: { label: "Noop" } },
          paramKinds: [],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    // Replace getControllersOverview with a counter AFTER construction, so we
    // measure only the discovery-pass calls (construction also touches it for
    // db.http.path resolution).
    const overviewSpy = vi.fn().mockImplementation(() => [
      fakeOverview(C, [
        {
          method: "noop",
          httpMethod: "POST",
          path: "/c/noop",
          action: { name: "noop", opts: { label: "Noop" } },
          paramKinds: [],
        },
      ]),
    ]);
    ctx.app.getControllersOverview = overviewSpy;
    const first = await ctrl.meta();
    const second = await ctrl.meta();
    expect(first).toBe(second);
    expect(overviewSpy).toHaveBeenCalledTimes(1);
  });
});
