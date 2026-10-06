import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createAdapter as createMemory } from "@atscript/db-memory";
import { createAdapter as createSqlite } from "@atscript/db-sqlite";
import type { DbSpace } from "@atscript/db";

import { AsDbController } from "../as-db.controller";
import type { TDbDecorateContext } from "../as-db-readable.controller";
import { DbDecorations } from "../decorations/db-decorations.decorator";
import { createMockApp, prepareFixtures } from "./test-utils";

/**
 * `@DbDecorations` with parent-object `requires` on a flattening adapter
 * (since 0.1.148): on SQL a nested object is stored as leaf columns
 * (`secret.hash`, `secret.salt`), so `requires: ["secret"]` stands for them
 * all — the hook gets the whole object on every adapter. Run through the
 * controller on in-process SQLite and, as the parity baseline, memory.
 */

let DecoNested: any;
let DecoNestedDecorations: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ DecoNested, DecoNestedDecorations } = await import("./fixtures/decorations-nested.as"));
});

const NESTED = [
  {
    id: 1,
    title: "one",
    secret: { hash: "h1", salt: "s1" },
    contact: { phone: "p1", email: "e1" },
    items: [
      { sku: "a", qty: 1 },
      { sku: "b", qty: 2 },
    ],
  },
];

const row = (rows: unknown, i = 0) => (rows as Array<Record<string, unknown>>)[i];

describe.each([
  { name: "memory", create: () => createMemory(), sql: false },
  { name: "sqlite", create: () => createSqlite(":memory:"), sql: true },
])("@DbDecorations parent requires — $name", ({ create, sql }) => {
  const spaces: DbSpace[] = [];
  afterAll(async () => {
    for (const space of spaces) await space.close();
  });

  async function nested(requires: Record<string, string[]>) {
    const space = create();
    spaces.push(space);
    const table = space.getTable(DecoNested);
    if (sql) await space.getAdapter(DecoNested).ensureTable();
    await table.insertMany(structuredClone(NESTED) as never);
    const hookSaw: Array<Record<string, unknown>> = [];

    @DbDecorations(DecoNestedDecorations, { requires } as never)
    class Ctrl extends AsDbController {}
    (Ctrl.prototype as any).decorateRows = function (
      rows: Record<string, unknown>[],
      ctx: TDbDecorateContext,
    ) {
      for (const r of rows) {
        hookSaw.push(structuredClone(r));
        if (ctx.decorations.has("digest")) r.digest = "d";
      }
    };
    return { controller: new Ctrl(createMockApp(), table as any), hookSaw };
  }

  it("boots with a parent object in requires, and the hook gets the whole object", async () => {
    const { controller, hookSaw } = await nested({ digest: ["secret"] });
    const rows = await controller.query("?$select=title,digest");
    expect(row(rows).digest).toBe("d");
    expect(hookSaw[0].secret).toEqual({ hash: "h1", salt: "s1" });
    // hook-only: no husk of the parent in the response
    expect("secret" in row(rows)).toBe(false);
    expect(row(rows).title).toBe("one");
  });

  it("without $select the parent is served as a plain field", async () => {
    const { controller, hookSaw } = await nested({ digest: ["secret"] });
    const rows = await controller.query("");
    expect(row(rows).digest).toBe("d");
    expect(row(rows).secret).toEqual({ hash: "h1", salt: "s1" });
    expect(hookSaw[0].secret).toEqual({ hash: "h1", salt: "s1" });
  });

  it("NEW-4: excluding a descendant of a required parent still serves the decoration", async () => {
    const { controller, hookSaw } = await nested({ digest: ["secret"] });
    const rows = await controller.query("?$select=-secret.hash");
    expect(row(rows).digest).toBe("d");
    expect(hookSaw[0].secret).toEqual({ hash: "h1", salt: "s1" });
    expect(row(rows).secret).toEqual({ salt: "s1" });
    expect(row(rows).title).toBe("one");
  });

  it("excluding the whole required parent still feeds the hook and strips it", async () => {
    const { controller, hookSaw } = await nested({ digest: ["secret"] });
    const rows = await controller.query("?$select=-secret");
    expect(row(rows).digest).toBe("d");
    expect(hookSaw[0].secret).toEqual({ hash: "h1", salt: "s1" });
    expect("secret" in row(rows)).toBe(false);
  });

  it("a client-selected descendant of a required parent stays, the rest is stripped", async () => {
    const { controller, hookSaw } = await nested({ digest: ["secret"] });
    const rows = await controller.query("?$select=title,secret.salt,digest");
    expect(row(rows).digest).toBe("d");
    expect(hookSaw[0].secret).toEqual({ hash: "h1", salt: "s1" });
    expect(row(rows).secret).toEqual({ salt: "s1" });
  });

  it("NEW-6: a hook-only parent leaves no husk, a selected sibling keeps its parent", async () => {
    const { controller } = await nested({ digest: ["contact"] });
    const rows = await controller.query("?$select=title,digest");
    expect("contact" in row(rows)).toBe(false);
    const both = await controller.query("?$select=title,contact.email,digest");
    expect(row(both).contact).toEqual({ email: "e1" });
  });

  it("NEW-5: an array source is read whole for the hook and stripped from the response", async () => {
    const { controller, hookSaw } = await nested({ digest: ["items"] });
    const rows = await controller.query("?$select=title,digest");
    expect(row(rows).digest).toBe("d");
    expect(hookSaw[0].items).toEqual(NESTED[0].items);
    expect(Object.keys(row(rows)).toSorted()).toEqual(["digest", "id", "title"]);
  });

  it.skipIf(sql)(
    "NEW-5: arrays of objects are pruned to the client-selected items[].field",
    async () => {
      // SQL cannot select inside a @db.json column (400), so only memory prunes
      const { controller } = await nested({ digest: ["items"] });
      const rows = await controller.query("?$select=items.sku,digest");
      expect(row(rows).items).toEqual([{ sku: "a" }, { sku: "b" }]);
    },
  );

  it("a path that is neither a field nor a parent of one is still refused at boot", async () => {
    await expect(nested({ digest: ["nope"] })).rejects.toThrow(
      /requires "nope", which is not an own field/,
    );
    // a name that merely shares a prefix with a field is not its parent
    await expect(nested({ digest: ["sec"] })).rejects.toThrow(/requires "sec"/);
  });
});
