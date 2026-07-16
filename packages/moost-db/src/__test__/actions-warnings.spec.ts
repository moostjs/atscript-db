import { describe, it, expect } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
import { fakeOverview, makeApp, makeTable } from "./actions-test-utils";

const PREFIX = "[moost-db actions]";

describe("Action discovery — warning + drop scenarios", () => {
  it("drops a @DbAction method with no @Post (no POST verb registered)", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "foo",
          httpMethod: "GET",
          path: "/c/foo",
          action: { name: "foo", opts: { label: "Foo" } },
          paramKinds: [],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^\\${PREFIX}.*requires @Post`)),
    );
  });

  it("drops a @DbAction method whose only verb is @Get", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "peek",
          httpMethod: "GET",
          path: "/c/peek",
          action: { name: "peek", opts: { label: "Peek" } },
          paramKinds: [],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("first default wins; subsequent duplicate at same level is demoted with a warning", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "edit1",
          httpMethod: "POST",
          path: "/c/edit1",
          action: { name: "edit1", opts: { label: "Edit 1", default: true } },
          paramKinds: ["id"],
        },
        {
          method: "edit2",
          httpMethod: "POST",
          path: "/c/edit2",
          action: { name: "edit2", opts: { label: "Edit 2", default: true } },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    const defaults = meta.actions.filter((a) => a.default).map((a) => a.name);
    expect(defaults).toEqual(["edit1"]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("duplicate default action"),
    );
  });

  it("drops an action when its method is missing a label entirely", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "block",
          httpMethod: "POST",
          path: "/c/block",
          action: { name: "block", opts: {} },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("requires a label"));
  });

  it("falls back to @Label-decorator metadata when opts.label is absent", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "block",
          httpMethod: "POST",
          path: "/c/block",
          action: { name: "block", opts: {} },
          label: "Block User",
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([
      expect.objectContaining({ name: "block", label: "Block User", level: "row" }),
    ]);
  });

  it("opts.label wins over @Label", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "block",
          httpMethod: "POST",
          path: "/c/block",
          action: { name: "block", opts: { label: "Block User" } },
          label: "Block",
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions[0].label).toBe("Block User");
  });

  it("rejects @DbActionID + @Body co-occurrence", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "blockWithReason",
          httpMethod: "POST",
          path: "/c/block",
          action: { name: "blockWithReason", opts: { label: "Block w/ reason" } },
          paramKinds: ["id", "body"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("cannot mix"));
  });
});
