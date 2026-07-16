import { describe, it, expect } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
import { fakeOverview, makeApp, makeTable } from "./actions-test-utils";

describe("Action level inference from ID-decorator usage", () => {
  it("infers level: 'row' from @DbActionID", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "block",
          httpMethod: "POST",
          path: "/c/block",
          action: { name: "block", opts: { label: "Block" } },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions[0].level).toBe("row");
  });

  it("infers level: 'rows' from @DbActionIDs", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "lockMany",
          httpMethod: "POST",
          path: "/c/lock",
          action: { name: "lock", opts: { label: "Lock" } },
          paramKinds: ["ids"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions[0].level).toBe("rows");
  });

  it("infers level: 'table' when no ID decorator is present", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "refresh",
          httpMethod: "POST",
          path: "/c/refresh",
          action: { name: "refresh-cache", opts: { label: "Refresh" } },
          paramKinds: [],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions[0].level).toBe("table");
  });

  it("drops the action when both @DbActionID and @DbActionIDs are present", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "ambiguous",
          httpMethod: "POST",
          path: "/c/ambig",
          action: { name: "ambig", opts: { label: "Ambig" } },
          paramKinds: ["id", "ids"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("[moost-db actions]"));
  });
});
