import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import type { FilterExpr } from "@atscript/db";
import { Post } from "@moostjs/event-http";
import { clearGlobalWooks, getMoostInfact, setTranslator } from "moost";

import { AsDbController } from "../as-db.controller";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { TableController } from "../decorators";
import { MOOST_DB_MESSAGES, notFoundError } from "../http-errors";
import { bootHttp, prepareFixtures } from "./test-utils";

/**
 * Every 404 moost-db answers is one coded body (since 0.1.173):
 * `{ statusCode: 404, code: "NOT_FOUND", message: "Not found" }`. Before, most
 * answered an empty message — a translator received the id "" — and the row
 * action 404 had its own text. A missing row and a row outside the caller's
 * scope still answer the same bytes (no existence oracle), now translated
 * alike by the `NOT_FOUND` code.
 */

let I18nItem: any;

const NOT_FOUND = { statusCode: 404, code: "NOT_FOUND", message: "Not found", error: "Not Found" };

beforeAll(async () => {
  await prepareFixtures();
  ({ I18nItem } = await import("./fixtures/i18n.as"));
});

beforeEach(() => {
  clearGlobalWooks();
  getMoostInfact()._cleanup();
  setTranslator(undefined);
});

afterEach(() => {
  setTranslator(undefined);
});

async function boot() {
  const db = createAdapter();
  const table = db.getTable(I18nItem) as any;
  await db.getAdapter(I18nItem).ensureTable();
  await table.insertMany([
    { id: 1, name: "own" },
    { id: 2, name: "foreign" },
  ]);
  class Items extends AsDbController {
    // row 2 is outside the caller's scope
    protected override transformFilter(filter: FilterExpr): FilterExpr {
      return { $and: [filter, { id: { $ne: 2 } }] } as FilterExpr;
    }

    @Post("actions/ship")
    @DbAction("ship", { label: "Ship" })
    ship(@DbActionID() _id: unknown): unknown {
      return { ok: true };
    }
  }
  TableController(table, "items")(Items);
  const send = await bootHttp(Items);
  return (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    send(method, `/items/${path}`, body, headers);
}

describe("one coded 404", () => {
  it("/one/:id, DELETE, a row action and an unknown form answer NOT_FOUND", async () => {
    const send = await boot();
    for (const [method, path, body] of [
      ["GET", "one/99"],
      ["DELETE", "99"],
      ["POST", "actions/ship", { ids: { id: 99 } }],
      ["GET", "meta/form/Nope"],
    ] as const) {
      const res = await send(method, path, body);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toEqual(NOT_FOUND);
    }
  });

  it("a row outside the scope answers the missing row's bytes", async () => {
    const send = await boot();
    type TReq = [method: string, path: string, body?: unknown];
    const pairs: Array<[missing: TReq, foreign: TReq]> = [
      [
        ["GET", "one/99"],
        ["GET", "one/2"],
      ],
      [
        ["DELETE", "99"],
        ["DELETE", "2"],
      ],
      [
        ["POST", "actions/ship", { ids: { id: 99 } }],
        ["POST", "actions/ship", { ids: { id: 2 } }],
      ],
    ];
    for (const [missing, foreign] of pairs) {
      const a = await send(...missing);
      const b = await send(...foreign);
      expect(b, `${foreign[0]} ${foreign[1]}`).toEqual(a);
    }
  });

  it("is translated by its code — alike for a missing and an out-of-scope row", async () => {
    setTranslator({ en: {}, de: { NOT_FOUND: "Nicht gefunden" } });
    const send = await boot();
    const de = { "accept-language": "de" };
    const missing = await send("GET", "one/99", undefined, de);
    expect(missing.body).toEqual({ ...NOT_FOUND, message: "Nicht gefunden" });
    expect(await send("GET", "one/2", undefined, de)).toEqual(missing);
    expect((await send("POST", "actions/ship", { ids: { id: 2 } }, de)).body).toEqual(missing.body);
    // the template is served with the other catalogs
    const meta = await send("GET", "meta", undefined, de);
    expect(meta.body.type.$i18n.NOT_FOUND).toBe("Nicht gefunden");
  });

  it("notFoundError() is that body, for a permission layer that refuses a row", () => {
    expect(notFoundError().body).toEqual(NOT_FOUND);
    expect(MOOST_DB_MESSAGES.NOT_FOUND).toBe("Not found");
  });
});
