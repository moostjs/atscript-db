import { describe, it, expect, vi } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
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
    new C(makeTable() as never, ctx.app);
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
    const ctrl = new C(makeTable() as never, ctx.app);
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    await ctrl.meta();
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("[moost-db actions]"));
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
    const ctrl = new C(makeTable() as never, ctx.app);
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
