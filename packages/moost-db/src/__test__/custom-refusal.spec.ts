import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { DbError } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { clearGlobalWooks, getMoostInfact, setTranslator } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { dbErrorToHttp } from "../validation-interceptor";
import { bootHttp, prepareFixtures, type THttpSend } from "./test-utils";

/**
 * A refusal text an application chose (a `validateControls` /
 * `validateInsights` override) reaches the translator by that text, as it did
 * before the errors were coded (since 0.1.175): the entry is `custom`, the
 * envelope has no top-level `code`. The core's own `INVALID_QUERY` entries
 * without a code get their error's.
 */

let I18nItem: any;

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

async function boot(): Promise<THttpSend> {
  const db = createAdapter();
  const table = db.getTable(I18nItem) as any;
  await db.getAdapter(I18nItem).ensureTable();
  class Items extends AsDbController {
    protected override validateControls(controls: Record<string, unknown>, type: any) {
      if (typeof controls.$limit === "number" && controls.$limit > 5) return "At most 5 rows";
      return super.validateControls(controls, type);
    }

    protected override validateInsights(insights: Map<string, unknown>) {
      if (insights.has("code")) return "Searching by code is off";
      return super.validateInsights(insights);
    }
  }
  TableController(table, "items")(Items);
  return bootHttp(Items);
}

const de = { "accept-language": "de" };

describe("an override's refusal text is translated by its text", () => {
  it("validateControls", async () => {
    setTranslator({ en: {}, de: { "At most 5 rows": "Höchstens 5 Zeilen" } });
    const send = await boot();
    const res = await send("GET", "/items/query?$limit=9", undefined, de);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Höchstens 5 Zeilen");
    expect(res.body.code).toBeUndefined();
    expect(res.body.errors).toEqual([
      { path: "", message: "Höchstens 5 Zeilen", code: "INVALID_QUERY", custom: true },
    ]);
    // no translation for the locale: the English text
    const en = await send("GET", "/items/query?$limit=9");
    expect(en.body.message).toBe("At most 5 rows");
  });

  it("validateInsights", async () => {
    setTranslator({ en: {}, de: { "Searching by code is off": "Suche nach Code ist aus" } });
    const send = await boot();
    const res = await send("GET", "/items/query?code=x", undefined, de);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Suche nach Code ist aus");
    expect(res.body.code).toBeUndefined();
    expect(res.body.errors[0]).toMatchObject({ custom: true, code: "INVALID_QUERY" });
  });

  it("the controller's own refusals stay coded", async () => {
    setTranslator({ en: {}, de: { UNKNOWN_FIELD: 'Unbekanntes Feld "{field}"' } });
    const send = await boot();
    const res = await send("GET", "/items/query?nope=1", undefined, de);
    expect(res.body.code).toBe("UNKNOWN_FIELD");
    expect(res.body.message).toBe('Unbekanntes Feld "nope"');
    expect(res.body.errors[0].custom).toBeUndefined();
  });
});

describe("dbErrorToHttp", () => {
  it("gives an INVALID_QUERY entry without a code its error's", () => {
    const body = dbErrorToHttp(
      new DbError("INVALID_QUERY", [
        { path: "$rank", message: "No rank here" },
        { path: "x", message: "Unknown", code: "UNKNOWN_FIELD" },
      ]),
    ).body as any;
    expect(body.code).toBe("INVALID_QUERY");
    expect(body.errors.map((e: any) => e.code)).toEqual(["INVALID_QUERY", "UNKNOWN_FIELD"]);
  });

  it("leaves the entries of other errors as they are", () => {
    const body = dbErrorToHttp(new DbError("CONFLICT", [{ path: "id", message: "Dup" }]))
      .body as any;
    expect(body.errors[0].code).toBeUndefined();
  });
});
