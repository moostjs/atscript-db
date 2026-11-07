/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import type { TDbWriteGuardContext } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { bootHttp, prepareFixtures, type THttpSend } from "./test-utils";

/**
 * The docs recipe "Unique index over a custom-normalised value": a stored
 * `identity` column with a unique index, filled by `guardWrite` from the
 * fields it derives from (a patch is merged onto the stored row first). A
 * twin collides on the index → 409 `CONFLICT`.
 */

let NiItem: any;
let send: THttpSend;
let table: any;

/** The app's normaliser: case, ё/е and punctuation folded, per catalog. */
function identityOf(row: { name: string; catalog: string }): string {
  const name = row.name
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return `${row.catalog}:${name}`;
}

beforeAll(async () => {
  await prepareFixtures();
  ({ NiItem } = await import("./fixtures/normalized-identity.as"));
  getMoostInfact()._cleanup();
  const db = createAdapter();
  table = db.getTable(NiItem);
  await db.getAdapter(NiItem).ensureTable();
  await db.getAdapter(NiItem).syncIndexes(); // what schema sync does: the unique index

  @TableController(table, "ni-items")
  @Inherit()
  class Items extends AsDbController {
    protected override async guardWrite(ctx: TDbWriteGuardContext<any>) {
      for (let i = 0; i < ctx.rows.length; i++) {
        const row = ctx.rows[i]!;
        let full = row;
        if (ctx.action.startsWith("update")) {
          // A patch carries only what changed: merge it onto the stored row.
          const current = await ctx.current(i);
          if (!current) continue; // no such row: the update matches nothing
          full = { ...current, ...row };
        }
        row.identity = identityOf(full);
      }
    }
  }

  send = await bootHttp(Items);
});

describe("unique index over a custom-normalised value", () => {
  it("insert fills the identity; a patch of a source field recomputes it", async () => {
    expect((await send("POST", "/ni-items", { id: 1, name: "Ёлка-1", catalog: "a" })).status).toBe(
      201,
    );
    expect(((await table.findById(1)) as any).identity).toBe("a:елка1");

    expect((await send("PATCH", "/ni-items", { id: 1, name: "Ёлка 2" })).status).toBe(200);
    expect(((await table.findById(1)) as any).identity).toBe("a:елка2");

    // Patching the other source field keeps the stored name.
    expect((await send("PATCH", "/ni-items", { id: 1, catalog: "b" })).status).toBe(200);
    expect(((await table.findById(1)) as any).identity).toBe("b:елка2");
    expect((await send("PATCH", "/ni-items", { id: 1, catalog: "a" })).status).toBe(200);
  });

  it("a twin is a 409 CONFLICT on the identity index; another catalog is not a twin", async () => {
    const twin = await send("POST", "/ni-items", { id: 2, name: "елка, 2!", catalog: "a" });
    expect(twin.status).toBe(409);
    expect(twin.body.code).toBe("CONFLICT");
    expect(twin.body.errors[0]).toMatchObject({
      code: "UNIQUE",
      params: { index: "item_identity" },
    });

    const other = await send("POST", "/ni-items", { id: 3, name: "елка 2", catalog: "b" });
    expect(other.status).toBe(201);

    // A patch that turns a row into a twin collides too.
    const patched = await send("PATCH", "/ni-items", { id: 3, catalog: "a" });
    expect(patched.status).toBe(409);
    expect(((await table.findById(3)) as any).identity).toBe("b:елка2");
  });

  it("a patch of a row that does not exist is not a 500 (current() is null)", async () => {
    const res = await send("PATCH", "/ni-items", { id: 999, catalog: "z" });
    expect(res.status).toBeLessThan(500);
    expect(await table.findById(999)).toBeNull();
  });

  it("a client-sent identity is overwritten", async () => {
    expect(
      (await send("POST", "/ni-items", { id: 4, name: "Pine", catalog: "a", identity: "x" }))
        .status,
    ).toBe(201);
    expect(((await table.findById(4)) as any).identity).toBe("a:pine");
  });
});
