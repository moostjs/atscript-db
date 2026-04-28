import { describe, it, expect } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
import { fakeOverview, makeApp, makeTable } from "./actions-test-utils";

describe("Action level inference from PK-decorator usage", () => {
  it("infers level: 'row' from @DbActionPK", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "block",
          httpMethod: "POST",
          path: "/c/block",
          action: { name: "block", opts: { label: "Block" } },
          paramKinds: ["pk"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions[0].level).toBe("row");
  });

  it("infers level: 'rows' from @DbActionPKs", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "lockMany",
          httpMethod: "POST",
          path: "/c/lock",
          action: { name: "lock", opts: { label: "Lock" } },
          paramKinds: ["pks"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions[0].level).toBe("rows");
  });

  it("infers level: 'table' when no PK decorator is present", async () => {
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
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions[0].level).toBe("table");
  });

  it("drops the action when both @DbActionPK and @DbActionPKs are present", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "ambiguous",
          httpMethod: "POST",
          path: "/c/ambig",
          action: { name: "ambig", opts: { label: "Ambig" } },
          paramKinds: ["pk", "pks"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("[moost-db actions]"));
  });
});
