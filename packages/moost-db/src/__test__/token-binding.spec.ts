/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeEach, vi } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import { Moost, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import { assertExposed } from "../assert-exposed";
import { clearDbSpaces, provideDbSpace } from "../db-space-registry";
import { TableController, ReadableController, resolveBoundReadable } from "../decorators";
import { provideTestDbSpace, resetTestDbSpaces } from "../testing";

/**
 * Coverage for the three `@TableController` binding forms (model token, lazy
 * factory, instance), the ambient space registry, the
 * `super(app)` constructor fallback, `assertExposed`, and the
 * `@atscript/moost-db/testing` fixture. Uses the same mock-annotated-type +
 * full `app.init()` approach as as-db-http-path.spec.ts.
 */

type MockModel = {
  __is_atscript_annotated_type: true;
  id: string;
  type: { kind: string; props: Map<string, unknown> };
  metadata: Map<string, unknown>;
};

function makeModel(id: string, metadata: Record<string, unknown> = {}): MockModel {
  return {
    __is_atscript_annotated_type: true,
    id,
    type: { kind: "object", props: new Map() },
    metadata: new Map(Object.entries({ "db.table": id.toLowerCase(), ...metadata })),
  };
}

describe("token/lazy controller binding", () => {
  beforeEach(() => {
    getMoostInfact()._cleanup();
    clearDbSpaces();
  });

  it("token form: resolves the readable from the default space at init", async () => {
    const Role = makeModel("Role");
    provideDbSpace(createAdapter());

    @TableController(Role as never)
    class RolesController extends AsDbController {
      get boundReadable() {
        return this.readable;
      }
    }

    const app = new Moost({ globalPrefix: "api" });
    app.registerControllers(RolesController);
    await app.init();

    // The runtime prefix write proves the controller was instantiated with a
    // real table resolved from the space (derived prefix = @db.table name).
    expect(Role.metadata.get("db.http.path")).toBe("/api/role");
  });

  it("token form: prefix prefers @db.http.path over @db.table", async () => {
    const Role = makeModel("Role", { "db.http.path": "custom-roles" });
    provideDbSpace(createAdapter());

    @TableController(Role as never)
    class RolesController extends AsDbController {}

    const app = new Moost();
    app.registerControllers(RolesController);
    await app.init();

    expect(Role.metadata.get("db.http.path")).toBe("/custom-roles");
  });

  it("token form: fails init with a wiring hint when no space is registered", async () => {
    const Role = makeModel("Role");

    @TableController(Role as never)
    class RolesController extends AsDbController {}

    const app = new Moost();
    app.registerControllers(RolesController);
    await expect(app.init()).rejects.toThrow(/No DbSpace registered.*provideDbSpace/s);
  });

  it("token form: honors @db.space on the model and options.space override", async () => {
    const analytics = createAdapter();
    provideDbSpace(createAdapter());
    provideDbSpace(analytics, "analytics");

    const FeedRun = makeModel("FeedRun", { "db.space": "analytics" });

    @TableController(FeedRun as never)
    class FeedRunsController extends AsDbController {}

    const app = new Moost();
    app.registerControllers(FeedRunsController);
    await app.init();
    // Resolved through the analytics space — the readable is cached there.
    expect(analytics.getTable(FeedRun as never).tableName).toBe("feedrun");

    // options.space overrides the annotation.
    getMoostInfact()._cleanup();
    const reports = createAdapter();
    provideDbSpace(reports, "reports");
    const Report = makeModel("Report", { "db.space": "analytics" });

    @TableController(Report as never, { space: "reports" })
    class ReportsController extends AsDbController {}

    const app2 = new Moost();
    app2.registerControllers(ReportsController);
    await app2.init();
    expect(reports.getTable(Report as never).tableName).toBe("report");
  });

  it("lazy factory form: defers resolution until init", async () => {
    const Role = makeModel("Role");
    let table: unknown;
    const factory = vi.fn(() => table);

    @TableController(factory as never, "roles")
    class RolesController extends AsDbController {}

    // Not resolved at decoration/import time.
    expect(factory).not.toHaveBeenCalled();

    // The space (and table) come into existence AFTER the class is declared.
    const space = createAdapter();
    table = space.getTable(Role as never);

    const app = new Moost();
    app.registerControllers(RolesController);
    await app.init();

    expect(factory).toHaveBeenCalled();
    expect(Role.metadata.get("db.http.path")).toBe("/roles");
  });

  it("lazy factory form: requires an explicit prefix at decoration time", () => {
    expect(() => {
      @TableController((() => undefined) as never)
      class Broken extends AsDbController {}
      void Broken;
    }).toThrow(/lazy factory form needs an explicit route prefix/);
  });

  it("super(app) fallback: resolves via the decorator's class metadata", async () => {
    const Role = makeModel("Role");
    provideDbSpace(createAdapter());

    @TableController(Role as never)
    class RolesController extends AsDbController {
      constructor(app: Moost) {
        super(app);
      }
    }

    const app = new Moost();
    app.registerControllers(RolesController);
    await app.init();

    expect(Role.metadata.get("db.http.path")).toBe("/role");
  });

  it("resolveBoundReadable: throws a descriptive error without a binding", () => {
    class Unbound {}
    expect(() => resolveBoundReadable(Unbound)).toThrow(/no readable bound/);
  });

  it("instance form keeps working through ReadableController", async () => {
    const Task = makeModel("Task", { "db.view": "active_tasks" });
    Task.metadata.delete("db.table");
    const space = createAdapter();
    const view = space.get(Task as never);

    @ReadableController(view as never)
    class TasksController extends AsDbReadableController {}

    const app = new Moost();
    app.registerControllers(TasksController);
    await app.init();

    expect(Task.metadata.get("db.http.path")).toBe("/active_tasks");
  });
});

describe("assertExposed", () => {
  beforeEach(() => {
    getMoostInfact()._cleanup();
    clearDbSpaces();
  });

  it("warns for @db.http.path models without a bound controller", async () => {
    const Bound = makeModel("Bound", { "db.http.path": "bound" });
    const Unbound = makeModel("Unbound", { "db.http.path": "unbound" });
    const NoHttp = makeModel("NoHttp");
    provideDbSpace(createAdapter());

    @TableController(Bound as never)
    class BoundController extends AsDbController {}

    const app = new Moost();
    app.registerControllers(BoundController);
    await app.init();

    const warn = vi.fn();
    const missing = assertExposed(app, [Bound, Unbound, NoHttp] as never[], {
      logger: { warn },
    });

    expect(missing).toEqual([Unbound]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("Unbound");
  });

  it("all: true audits every model, honoring exclude (prefix-bound repos)", async () => {
    const Bound = makeModel("Bound");
    const Orphan = makeModel("Orphan");
    const Internal = makeModel("Internal");
    provideDbSpace(createAdapter());

    @TableController(Bound as never)
    class BoundController extends AsDbController {}

    const app = new Moost();
    app.registerControllers(BoundController);
    await app.init();

    const warn = vi.fn();
    const missing = assertExposed(app, [Bound, Orphan, Internal] as never[], {
      all: true,
      exclude: [Internal] as never[],
      logger: { warn },
    });

    expect(missing).toEqual([Orphan]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("Orphan");
    expect(String(warn.mock.calls[0][0])).toContain("exclude");
  });
});

describe("AsDbReadableController.table (writable accessor)", () => {
  beforeEach(() => {
    getMoostInfact()._cleanup();
    resetTestDbSpaces();
  });

  it("returns the bound readable when it is a real table", () => {
    const Role = makeModel("Role");
    const space = provideTestDbSpace([Role] as never[]);
    const table = space.getTable(Role as never);

    class Exposing extends AsDbReadableController {
      get writable() {
        return this.table;
      }
    }
    const ctrl = new Exposing(new Moost(), table as never);
    expect(ctrl.writable).toBe(table);
  });

  it("throws a clear error for non-table readables (views)", () => {
    const ctrl = Object.create(AsDbReadableController.prototype) as {
      readable: unknown;
      table: unknown;
    };
    ctrl.readable = { isView: true, tableName: "active_tasks" };
    expect(() => ctrl.table).toThrow(/bound to a view.*active_tasks.*table-bound/);
  });
});

describe("@atscript/moost-db/testing", () => {
  beforeEach(() => {
    getMoostInfact()._cleanup();
    resetTestDbSpaces();
  });

  it("provideTestDbSpace registers an in-memory space usable by token binding", async () => {
    const Role = makeModel("Role");
    const space = provideTestDbSpace([Role] as never[]);

    @TableController(Role as never)
    class RolesController extends AsDbController {}

    const app = new Moost();
    app.registerControllers(RolesController);
    await app.init();

    expect(Role.metadata.get("db.http.path")).toBe("/role");
    // Same space instance serves direct seeding.
    expect(space.getTable(Role as never).tableName).toBe("role");
  });
});
