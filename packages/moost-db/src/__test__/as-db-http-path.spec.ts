/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated parent containers */
import { describe, it, expect, beforeEach } from "vite-plus/test";
import { Moost, Controller, ImportController, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";

/**
 * Integration coverage for the `db.http.path` metadata write done by
 * `AsDbReadableController._resolveHttpPath()`. These tests drive the full
 * Moost `bindController` flow so we actually exercise:
 *   - `createEventContext` + `setControllerContext({ prefix })`
 *   - SINGLETON instance creation via `infact.get()`
 *   - Nested `@ImportController` prefix composition
 * No HTTP adapter is needed: the metadata write happens during `app.init()`,
 * not per-request.
 */

type MockTable = {
  tableName: string;
  isView: boolean;
  type: {
    __is_atscript_annotated_type: true;
    type: { kind: string; props: Map<string, unknown> };
    metadata: Map<string, unknown>;
  };
};

function makeTable(tableName: string): MockTable {
  return {
    tableName,
    isView: false,
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map() },
      metadata: new Map(),
    },
  };
}

describe("db.http.path runtime resolution (Moost integration)", () => {
  beforeEach(() => {
    // Infact's DI cache keys SINGLETON instances by Symbol.for(classConstructor),
    // which stringifies to the class source — so two tests that each declare
    // `class X extends AsDbController {}` collide in the shared cache. Reset
    // between tests so each test gets a fresh instance.
    getMoostInfact()._cleanup();
  });

  it("sets computed prefix with leading slash from globalPrefix + tableName", async () => {
    const rolesTable = makeTable("roles");

    @TableController(rolesTable as never)
    class RolesController extends AsDbController {}

    const app = new Moost({ globalPrefix: "api" });
    app.registerControllers(RolesController);
    await app.init();

    expect(rolesTable.type.metadata.get("db.http.path")).toBe("/api/roles");
  });

  it("falls back to tableName when no design-time @db.http.path and no globalPrefix", async () => {
    const rolesTable = makeTable("roles");

    @TableController(rolesTable as never)
    class RolesController extends AsDbController {}

    const app = new Moost();
    app.registerControllers(RolesController);
    await app.init();

    expect(rolesTable.type.metadata.get("db.http.path")).toBe("/roles");
  });

  it("overwrites design-time @db.http.path with the runtime-computed path", async () => {
    // When the user sets @db.http.path at design-time, TableController uses it
    // as the Controller's ownPrefix; at runtime the full normalized path must
    // overwrite it so FK references resolve against the real URL.
    const rolesTable = makeTable("roles");
    rolesTable.type.metadata.set("db.http.path", "custom");

    @TableController(rolesTable as never)
    class RolesController extends AsDbController {}

    const app = new Moost({ globalPrefix: "api" });
    app.registerControllers(RolesController);
    await app.init();

    expect(rolesTable.type.metadata.get("db.http.path")).toBe("/api/custom");
  });

  it("respects explicit prefix argument to TableController", async () => {
    const rolesTable = makeTable("roles");

    @TableController(rolesTable as never, "explicit-prefix")
    class RolesController extends AsDbController {}

    const app = new Moost({ globalPrefix: "api" });
    app.registerControllers(RolesController);
    await app.init();

    expect(rolesTable.type.metadata.get("db.http.path")).toBe("/api/explicit-prefix");
  });

  it("captures parent route nesting via @ImportController", async () => {
    const rolesTable = makeTable("roles");

    @TableController(rolesTable as never)
    class RolesController extends AsDbController {}

    @Controller("db")
    @ImportController(RolesController)
    class DbGroup {}

    const app = new Moost({ globalPrefix: "api" });
    app.registerControllers(DbGroup);
    await app.init();

    expect(rolesTable.type.metadata.get("db.http.path")).toBe("/api/db/roles");
  });

  it("respects @ImportController prefix override of the child's own prefix", async () => {
    const rolesTable = makeTable("roles");

    @TableController(rolesTable as never)
    class RolesController extends AsDbController {}

    @Controller("db")
    @ImportController("my-roles", RolesController)
    class DbGroup {}

    const app = new Moost({ globalPrefix: "api" });
    app.registerControllers(DbGroup);
    await app.init();

    expect(rolesTable.type.metadata.get("db.http.path")).toBe("/api/db/my-roles");
  });

  it("resolves paths for multiple sibling tables under the same parent", async () => {
    const rolesTable = makeTable("roles");
    const tagsTable = makeTable("tags");

    @TableController(rolesTable as never)
    class RolesController extends AsDbController {}

    @TableController(tagsTable as never)
    class TagsController extends AsDbController {}

    @Controller("db/tables")
    @ImportController(RolesController)
    @ImportController(TagsController)
    class TablesGroup {}

    const app = new Moost({ globalPrefix: "api" });
    app.registerControllers(TablesGroup);
    await app.init();

    expect(rolesTable.type.metadata.get("db.http.path")).toBe("/api/db/tables/roles");
    expect(tagsTable.type.metadata.get("db.http.path")).toBe("/api/db/tables/tags");
  });
});
