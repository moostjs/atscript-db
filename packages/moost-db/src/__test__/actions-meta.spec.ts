import { describe, it, expect } from "vite-plus/test";

import { AsDbController } from "../as-db.controller";
import { DbRowActions, DbTableActions } from "../actions/db-actions.decorator";
import { fakeOverview, makeApp, makeTable } from "./actions-test-utils";

/**
 * Round-trip checks for the `actions` field in `/meta`. Covers the empty
 * default + each processor branch (backend, navigate, custom).
 */

describe("AsDbController — actions in /meta", () => {
  it("emits actions: [] when no actions are declared", async () => {
    class NoActionsCtrl extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new NoActionsCtrl(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
  });

  it("emits a backend action from a method-decorated handler", async () => {
    class BackendCtrl extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(BackendCtrl, [
        {
          method: "blockUser",
          httpMethod: "POST",
          path: "/users/actions/block",
          action: { name: "block", opts: { label: "Block", icon: "i-as-block" } },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new BackendCtrl(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([
      {
        name: "block",
        label: "Block",
        level: "row",
        processor: "backend",
        value: "/users/actions/block",
        icon: "i-as-block",
      },
    ]);
  });

  @DbRowActions({
    edit: { label: "Edit", processor: "navigate", value: "/users/$1/edit" },
  })
  class NavigateCtrl extends AsDbController {}

  it("emits a navigate action passing the dict-supplied URL through unchanged", async () => {
    const ctx = makeApp();
    const ctrl = new NavigateCtrl(ctx.app, makeTable() as never);
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

  @DbTableActions({
    exportCsv: { label: "Export CSV", processor: "custom" },
  })
  class CustomCtrl extends AsDbController {}

  it("emits a custom action with value === <action key>", async () => {
    const ctx = makeApp();
    const ctrl = new CustomCtrl(ctx.app, makeTable() as never);
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
});
