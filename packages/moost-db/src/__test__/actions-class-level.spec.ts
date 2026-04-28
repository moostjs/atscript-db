import { describe, it, expect } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
import {
  DbActions,
  DbRowActions,
  DbRowsActions,
  DbTableActions,
} from "../actions/db-actions.decorator";
import { fakeOverview, makeApp, makeTable } from "./actions-test-utils";

describe("Class-level action decorators — @DbActions / @DbTableActions / @DbRowActions / @DbRowsActions", () => {
  it("@DbRowActions emits a navigate row entry with the supplied URL", async () => {
    @DbRowActions({
      edit: { label: "Edit", processor: "navigate", value: "/users/$1/edit" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([
      {
        name: "edit",
        label: "Edit",
        level: "row",
        processor: "navigate",
        value: "/users/$1/edit",
      },
    ]);
  });

  it("@DbTableActions emits a custom entry with value === <action key>", async () => {
    @DbTableActions({
      exportCsv: { label: "Export CSV", processor: "custom" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([
      {
        name: "exportCsv",
        label: "Export CSV",
        level: "table",
        processor: "custom",
        value: "exportCsv",
      },
    ]);
  });

  it("@DbRowActions emits a backend entry with the dict-supplied path verbatim (no handler validation)", async () => {
    @DbRowActions({
      block: { label: "Block", processor: "backend", value: "/admin/users/block" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    // Empty overview: meta builder must NOT validate that the path is bound.
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([
      {
        name: "block",
        label: "Block",
        level: "row",
        processor: "backend",
        value: "/admin/users/block",
      },
    ]);
  });

  it("rejects navigate entries with missing/null/empty value", async () => {
    @DbRowActions({
      a: { label: "A", processor: "navigate" } as never,
      b: { label: "B", processor: "navigate", value: null as unknown as string },
      c: { label: "C", processor: "navigate", value: "" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    // One warning per dropped entry.
    expect(ctx.logger.warn.mock.calls.length).toBe(3);
  });

  it("rejects backend entries with missing value", async () => {
    @DbTableActions({
      syncAll: { label: "Sync All", processor: "backend" } as never,
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('processor "backend"'));
  });

  it("rejects custom entries that supply value (forbidden)", async () => {
    @DbTableActions({
      exportCsv: {
        label: "Export CSV",
        processor: "custom",
        value: "should-not-be-here",
      } as never,
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('processor "custom" forbids'),
    );
  });

  it("@DbActions requires explicit level on each entry; entries lacking it are dropped", async () => {
    @DbActions({
      foo: { label: "Foo", processor: "navigate", value: "/foo" } as never,
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("requires a level"));
  });

  it("@DbRowsActions injects level: 'rows' into each entry", async () => {
    @DbRowsActions({
      lockMany: { label: "Lock", processor: "custom" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions[0].level).toBe("rows");
  });

  it("class-level backend row entry surfaces alongside method-decorator backend (positive coexistence)", async () => {
    @DbRowActions({
      block: { label: "Block", processor: "backend", value: "/admin/users/block" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "approve",
          httpMethod: "POST",
          path: "/c/approve",
          action: { name: "approve", opts: { label: "Approve" } },
          paramKinds: ["pk"],
        },
      ]),
    ]);
    const ctrl = new C(makeTable() as never, ctx.app);
    const meta = await ctrl.meta();
    const names = meta.actions.map((a) => a.name).toSorted();
    expect(names).toEqual(["approve", "block"]);
  });
});
