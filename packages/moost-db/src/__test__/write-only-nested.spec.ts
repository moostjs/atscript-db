import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createAdapter as createMemory } from "@atscript/db-memory";
import { createAdapter as createSqlite } from "@atscript/db-sqlite";
import type { DbSpace } from "@atscript/db";

import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { DbDecorations } from "../decorations/db-decorations.decorator";
import { createMockApp, prepareFixtures } from "./test-utils";

/**
 * A `@db.writeOnly` leaf of a nested object stays sealed when the client
 * selects the PARENT (`$select=secret`): the parent stands for its unsealed
 * leaves — on `/query`, `/pages`, `/one` and every `$with` level — and a
 * `@DbDecorations` `requires` naming a parent with a write-only leaf is
 * refused at boot, on every adapter.
 */

let WoNestedOwner: any;
let WoNestedChild: any;
let WoNestedDecorations: any;
let WoNestedGrandchild: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ WoNestedOwner, WoNestedChild, WoNestedDecorations, WoNestedGrandchild } =
    await import("./fixtures/write-only-nested.as"));
});

const SECRET = { hash: "H", salt: "S" };
const rowsOf = (res: unknown) => res as Array<Record<string, any>>;

describe.each([
  { name: "memory", create: () => createMemory(), sql: false },
  { name: "sqlite", create: () => createSqlite(":memory:"), sql: true },
])("write-only nested leaf seal — $name", ({ create, sql }) => {
  const spaces: DbSpace[] = [];
  afterAll(async () => {
    for (const space of spaces) await space.close();
  });

  async function boot() {
    const space = create();
    spaces.push(space);
    const owners = space.getTable(WoNestedOwner);
    const children = space.getTable(WoNestedChild);
    const grandchildren = space.getTable(WoNestedGrandchild);
    if (sql) {
      await space.getAdapter(WoNestedOwner).ensureTable();
      await space.getAdapter(WoNestedChild).ensureTable();
      await space.getAdapter(WoNestedGrandchild).ensureTable();
    }
    await owners.insertMany([{ id: 1, title: "t", secret: { ...SECRET } }] as never);
    await children.insertMany([{ id: 1, ownerId: 1 }] as never);
    await grandchildren.insertMany([{ id: 1, childId: 1 }] as never);
    return {
      owners: new AsDbController(createMockApp(), owners as any),
      children: new AsDbController(createMockApp(), children as any),
      grandchildren: new AsDbController(createMockApp(), grandchildren as any),
    };
  }

  it("/query: selecting the parent returns only its unsealed leaves", async () => {
    const { owners } = await boot();
    expect(rowsOf(await owners.query("?$select=secret"))[0].secret).toEqual({ salt: "S" });
    const mixed = rowsOf(await owners.query("?$select=title,secret"))[0];
    expect(mixed.secret).toEqual({ salt: "S" });
    expect(mixed.title).toBe("t");
    // the unsealed leaf alone, and no selection, were already correct
    expect(rowsOf(await owners.query("?$select=secret.salt"))[0].secret).toEqual({ salt: "S" });
    expect(rowsOf(await owners.query(""))[0].secret).toEqual({ salt: "S" });
  });

  it("/pages: selecting the parent returns only its unsealed leaves", async () => {
    const { owners } = await boot();
    const page: any = await owners.pages("?$select=secret&$page=1&$size=10");
    expect(page.data[0].secret).toEqual({ salt: "S" });
  });

  it("/one: selecting the parent returns only its unsealed leaves", async () => {
    const { owners } = await boot();
    const one: any = await owners.getOne("1", "?$select=secret");
    expect(one.secret).toEqual({ salt: "S" });
  });

  it("$with: selecting the parent in the sub-select keeps the leaf sealed", async () => {
    const { children } = await boot();
    const rows = rowsOf(await children.query("?$with=owner($select=secret)"));
    expect(rows[0].owner.secret).toEqual({ salt: "S" });
    const all = rowsOf(await children.query("?$with=owner"));
    expect(all[0].owner.secret).toEqual({ salt: "S" });
  });

  // Since 0.1.165 a dotted `$with` loads (as its nested form) — and is sealed
  // and vetoed per level exactly like the nested form.
  it("dotted $with: the leaf two hops away stays sealed; filtering on it is refused", async () => {
    const { grandchildren } = await boot();
    const rows = rowsOf(await grandchildren.query("?$with=child.owner"));
    expect(rows[0].child.owner.secret).toEqual({ salt: "S" });
    const sub = rowsOf(await grandchildren.query("?$with=child.owner($select=secret)"));
    expect(sub[0].child.owner.secret).toEqual({ salt: "S" });
    const probe = await grandchildren.query("?$with=child.owner(secret.hash=H)").catch((e) => e);
    expect(probe).toBeInstanceOf(HttpError);
    expect((probe as HttpError).body.statusCode).toBe(400);
  });

  it("dotted $with reaches the controller's overlays already nested (one level per relation)", async () => {
    const space = create();
    spaces.push(space);
    const seen: unknown[] = [];
    class Ctrl extends AsDbController {
      protected override validateControls(controls: Record<string, unknown>, type: any) {
        seen.push(JSON.parse(JSON.stringify(controls.$with ?? null)));
        return super.validateControls(controls, type);
      }
    }
    const ctrl = new Ctrl(createMockApp(), space.getTable(WoNestedGrandchild) as any);
    await ctrl.query("?$with=child.owner($select=title)").catch(() => undefined);
    expect(seen[0]).toEqual([
      {
        name: "child",
        controls: {
          $with: [{ name: "owner", filter: {}, controls: { $select: ["title"] }, insights: {} }],
        },
      },
    ]);
  });

  it("a parent `requires` naming a write-only descendant is refused at boot", async () => {
    const space = create();
    spaces.push(space);
    const owners = space.getTable(WoNestedOwner);
    @DbDecorations(WoNestedDecorations, { requires: { digest: ["secret"] } } as never)
    class Ctrl extends AsDbController {}
    expect(() => new Ctrl(createMockApp(), owners as any)).toThrow(/write-?only/i);
  });

  it("a `requires` naming only the unsealed leaf still boots", async () => {
    const space = create();
    spaces.push(space);
    const owners = space.getTable(WoNestedOwner);
    @DbDecorations(WoNestedDecorations, { requires: { digest: ["secret.salt"] } } as never)
    class Ctrl extends AsDbController {}
    expect(() => new Ctrl(createMockApp(), owners as any)).not.toThrow();
  });
});
