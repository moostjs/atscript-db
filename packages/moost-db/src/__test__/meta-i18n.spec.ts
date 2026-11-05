import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import type { AtscriptDbTable, TMetaResponse } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { MoostHttp, Post } from "@moostjs/event-http";
import { useHeaders } from "@wooksjs/event-http";
import { Moost, clearGlobalWooks, getMoostInfact, setTranslator } from "moost";

import { AsDbController } from "../as-db.controller";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbActionIDs } from "../actions/db-action-ids.decorator";
import { useDbActionTarget } from "../actions/target";
import { DbTableActions } from "../actions/db-actions.decorator";
import { InputForm } from "../actions/db-action-input-form.decorator";
import { TableController } from "../decorators";
import { stableMeta } from "../meta/meta-cache";
import { prepareFixtures } from "./test-utils";

/**
 * `/meta` and `/meta/form/:name` in the request's language (since 0.1.170):
 * with moost's translator registered, the served texts are translated per
 * locale, the type root carries `$i18n` (the translated registered templates),
 * each language gets its own ETag, and no translator means the same bytes
 * as before.
 */

let I18nItem: any;
let I18nReason: any;

const DE: Record<string, string> = {
  Name: "Bezeichnung",
  "Name is too short": "Die Bezeichnung ist zu kurz",
  Reason: "Grund",
  Archive: "Archivieren",
  "Archive every item": "Alle Einträge archivieren",
  "Archive $1?": "$1 archivieren?",
  "Archive $N items?": "$N Einträge archivieren?",
  Suspend: "Sperren",
  MIN_LENGTH: "Mindestens {min} Zeichen",
  MAX_LENGTH: "Höchstens {max} Zeichen",
  REQUIRED: "Darf nicht leer sein",
  GEO_LONGITUDE_RANGE: "Längengrad {value} außerhalb [-180, 180]",
  UNIQUE: "{fields} ist bereits vergeben",
  CONFLICT: "Konflikt",
  "Already shipped": "Bereits versandt",
};

async function itemsTable(): Promise<AtscriptDbTable<any>> {
  const db = createAdapter();
  const table = db.getTable(I18nItem) as any;
  const adapter = db.getAdapter(I18nItem);
  await adapter.ensureTable();
  await adapter.syncIndexes();
  return table;
}

async function boot(opts: { metaTranslation?: boolean; overlay?: boolean } = {}) {
  const variants = new WeakMap<object, Map<string, TMetaResponse>>();
  @DbTableActions({
    archive: {
      label: "Archive",
      processor: "custom",
      description: "Archive every item",
      promptText: ["Archive $1?", "Archive $N items?"],
    },
  })
  class Items extends AsDbController {
    protected override metaTranslation(): boolean {
      return opts.metaTranslation ?? super.metaTranslation();
    }

    // Per-role variants (x-role: b loses `archive`), memoized → stable.
    protected override applyMetaOverlay(
      meta: TMetaResponse,
    ): TMetaResponse | Promise<TMetaResponse> {
      if (!opts.overlay) return super.applyMetaOverlay(meta);
      const role = String(useHeaders()["x-role"] ?? "a");
      let byRole = variants.get(meta);
      if (!byRole) variants.set(meta, (byRole = new Map()));
      let v = byRole.get(role);
      if (!v) {
        const actions = meta.actions.filter((a) => role !== "b" || a.name !== "archive");
        byRole.set(role, (v = stableMeta({ ...meta, actions })));
      }
      return v;
    }

    @Post("actions/suspend")
    @DbAction("suspend", { label: "Suspend" })
    async suspend(
      @DbActionIDs() _ids: Array<Record<string, unknown>>,
      @InputForm(I18nReason) _input: unknown,
    ): Promise<unknown> {
      return { ok: true };
    }

    @Post("actions/ship")
    @DbAction("ship", {
      label: "Ship",
      requiredFields: ["name"],
      disabled: (rows: Array<{ name: string }>) =>
        rows.map((r) => (r.name.startsWith("done") ? "Already shipped" : false)),
    })
    ship(@DbActionID() _id: unknown): unknown {
      return { ok: true };
    }

    @Post("actions/ship-many")
    @DbAction("shipMany", {
      label: "Ship selected",
      requiredFields: ["name"],
      onDisabledRows: "skip",
      disabled: (rows: Array<{ name: string }>) =>
        rows.map((r) => (r.name.startsWith("done") ? "Already shipped" : false)),
    })
    shipMany(@DbActionIDs() _ids: unknown): unknown {
      return useDbActionTarget().summary();
    }
  }
  TableController((await itemsTable()) as never, "items")(Items);
  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(Items);
  await app.init();
  const send = async (
    path: string,
    headers: Record<string, string> = {},
    init: { method?: string; body?: unknown } = {},
  ) => {
    const res = (await http.request(`/items${path}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }))!;
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: text ? JSON.parse(text) : undefined,
      headers: res.headers,
    };
  };
  return send;
}

const de = { "accept-language": "de" };
const en = { "accept-language": "en" };

beforeAll(async () => {
  await prepareFixtures();
  ({ I18nItem, I18nReason } = await import("./fixtures/i18n.as"));
});

beforeEach(() => {
  clearGlobalWooks();
  getMoostInfact()._cleanup();
  setTranslator(undefined);
});

afterAll(() => {
  setTranslator(undefined);
});

describe("/meta translation", () => {
  it("translates labels, constraint messages and actions; $i18n holds the registered templates", async () => {
    setTranslator({ en: {}, de: DE });
    const send = await boot();
    const { status, body } = await send("/meta", de);
    expect(status).toBe(200);
    const name = body.type.type.props.name.metadata;
    expect(name["meta.label"]).toBe("Bezeichnung");
    expect(name["expect.minLength"]).toMatchObject({ message: "Die Bezeichnung ist zu kurz" });
    expect(body.type.$i18n).toMatchObject({
      MIN_LENGTH: "Mindestens {min} Zeichen",
      REQUIRED: "Darf nicht leer sein",
      GEO_LONGITUDE_RANGE: "Längengrad {value} außerhalb [-180, 180]",
    });
    const archive = body.actions.find((a: any) => a.name === "archive");
    expect(archive).toMatchObject({
      label: "Archivieren",
      description: "Alle Einträge archivieren",
      promptText: ["$1 archivieren?", "$N Einträge archivieren?"],
    });
    expect(body.actions.find((a: any) => a.name === "suspend").label).toBe("Sperren");
  });

  it("the default locale (no Accept-Language, or the source language) serves the source bytes", async () => {
    const send = await boot();
    const before = await send("/meta");
    expect(before.headers.get("vary")).toBe("Authorization, Cookie");

    clearGlobalWooks();
    getMoostInfact()._cleanup();
    setTranslator({ en: {}, de: DE });
    const sendT = await boot();
    const none = await sendT("/meta");
    const english = await sendT("/meta", en);
    expect(none.text).toBe(before.text);
    expect(english.text).toBe(before.text);
    expect(none.body.type.$i18n).toBeUndefined();
    expect(none.headers.get("vary")).toContain("Accept-Language");
    expect(none.headers.get("etag")).toBe(english.headers.get("etag"));
  });

  it("one ETag per language: 304 for the same language, 200 when the language changes", async () => {
    setTranslator({ en: {}, de: DE });
    const send = await boot();
    const english = await send("/meta", en);
    const german = await send("/meta", de);
    const etagEn = english.headers.get("etag")!;
    const etagDe = german.headers.get("etag")!;
    expect(etagEn).toMatch(/^W\//);
    expect(etagDe).toMatch(/^W\//);
    expect(etagDe).not.toBe(etagEn);
    expect(german.headers.get("vary")).toContain("Accept-Language");

    const again = await send("/meta", { ...de, "if-none-match": etagDe });
    expect(again.status).toBe(304);
    const switched = await send("/meta", { ...en, "if-none-match": etagDe });
    expect(switched.status).toBe(200);
    expect(switched.text).toBe(english.text);
    expect((await send("/meta", de)).text).toBe(german.text);
  });

  it("metaTranslation() false serves the source texts", async () => {
    setTranslator({ en: {}, de: DE });
    const send = await boot({ metaTranslation: false });
    const { body, headers } = await send("/meta", de);
    expect(body.type.type.props.name.metadata["meta.label"]).toBe("Name");
    expect(body.type.$i18n).toBeUndefined();
    expect(headers.get("vary")).toBe("Authorization, Cookie");
  });

  it("translates /meta/form/:name with its own $i18n and ETag per language", async () => {
    setTranslator({ en: {}, de: DE });
    const send = await boot();
    const english = await send("/meta/form/I18nReason", en);
    const german = await send("/meta/form/I18nReason", de);
    expect(english.body.type.props.reason.metadata["meta.label"]).toBe("Reason");
    expect(english.body.$i18n).toBeUndefined();
    expect(german.body.type.props.reason.metadata["meta.label"]).toBe("Grund");
    expect(german.body.$i18n).toMatchObject({ REQUIRED: "Darf nicht leer sein" });
    expect(german.headers.get("etag")).not.toBe(english.headers.get("etag"));
    const again = await send("/meta/form/I18nReason", {
      ...de,
      "if-none-match": german.headers.get("etag")!,
    });
    expect(again.status).toBe(304);
  });
});

const labelsOf = (r: { body: any }): string[] => r.body.actions.map((x: any) => x.label);

describe("/meta translation × per-principal variants", () => {
  it("role A / de and role B / de: own actions and ETags, the same translated type", async () => {
    setTranslator({ en: {}, de: DE });
    const send = await boot({ overlay: true });
    const a = await send("/meta", { ...de, "x-role": "a" });
    const b = await send("/meta", { ...de, "x-role": "b" });
    expect(labelsOf(a)).toContain("Archivieren");
    expect(labelsOf(b)).not.toContain("Archivieren");
    expect(labelsOf(b)).toContain("Sperren");
    expect(a.body.type).toEqual(b.body.type);
    expect(a.body.type.type.props.name.metadata["meta.label"]).toBe("Bezeichnung");
    const etagA = a.headers.get("etag")!;
    const etagB = b.headers.get("etag")!;
    expect(etagA).toMatch(/^W\//);
    expect(etagB).toMatch(/^W\//);
    expect(etagA).not.toBe(etagB);
    expect((await send("/meta", { ...de, "x-role": "b", "if-none-match": etagB })).status).toBe(
      304,
    );
    const bEn = await send("/meta", { ...en, "x-role": "b", "if-none-match": etagB });
    expect(bEn.status).toBe(200);
    expect(bEn.headers.get("etag")).not.toBe(etagB);
  });

  it("a new translator generation is served on the next request", async () => {
    setTranslator({ en: {}, de: DE });
    const send = await boot();
    const before = await send("/meta", de);
    setTranslator({ en: {}, de: { ...DE, Name: "Benennung" } });
    const after = await send("/meta", de);
    expect(after.body.type.type.props.name.metadata["meta.label"]).toBe("Benennung");
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
  });
});

describe("error bodies in the request's language", () => {
  it("a validation error: custom text by its text, built-in message by its code", async () => {
    setTranslator({ en: {}, de: DE });
    const send = await boot();
    const short = await send("", de, { method: "POST", body: { id: 1, name: "ab" } });
    expect(short.status).toBe(400);
    expect(short.body.errors[0]).toMatchObject({
      path: "name",
      message: "Die Bezeichnung ist zu kurz",
    });
    expect(short.body.message).toBe("name: Die Bezeichnung ist zu kurz");

    const long = await send("", de, {
      method: "POST",
      body: { id: 1, name: "abc", code: "abcdef" },
    });
    expect(long.body.errors[0]).toMatchObject({
      path: "code",
      code: "MAX_LENGTH",
      message: "Höchstens 4 Zeichen",
    });
  });

  it("a unique violation: entries by their code, the top message by the error's code", async () => {
    setTranslator({ en: {}, de: DE });
    const send = await boot();
    expect((await send("", de, { method: "POST", body: { id: 1, name: "abc" } })).status).toBe(201);
    const dup = await send("", de, { method: "POST", body: { id: 2, name: "abc" } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("CONFLICT");
    expect(dup.body.message).toBe("Konflikt");
    expect(dup.body.errors[0]).toMatchObject({
      code: "UNIQUE",
      message: "name ist bereits vergeben",
    });

    const english = await send("", en, { method: "POST", body: { id: 3, name: "abc" } });
    expect(english.body.errors[0].message).not.toContain("vergeben");
  });
});

const reasonsOf = async (send: Awaited<ReturnType<typeof boot>>, h: Record<string, string>) => ({
  list: (await send("/query?$actions=true&$sort=id", h)).body.map(
    (r: any) => r.$disabledReasons ?? null,
  ),
  one: (await send("/meta/actions/1", h)).body,
  refused: (await send("/actions/ship", h, { method: "POST", body: { ids: { id: 1 } } })).body,
  skipped: (
    await send("/actions/ship-many", h, { method: "POST", body: { ids: [{ id: 1 }, { id: 2 }] } })
  ).body.skipped,
});

describe("disabled reasons in the request's language", () => {
  async function seeded() {
    const send = await boot();
    for (const [id, name] of [
      [1, "done one"],
      [2, "open two"],
    ] as const) {
      expect((await send("", en, { method: "POST", body: { id, name } })).status).toBe(201);
    }
    return send;
  }

  it("$disabledReasons, /meta/actions/:id and the 409 agree in German", async () => {
    setTranslator({ en: {}, de: DE });
    const send = await seeded();
    const de_ = await reasonsOf(send, de);
    expect(de_.list).toEqual([{ ship: "Bereits versandt", shipMany: "Bereits versandt" }, null]);
    expect(de_.one.disabledReasons).toEqual({
      ship: "Bereits versandt",
      shipMany: "Bereits versandt",
    });
    expect(de_.refused).toMatchObject({
      name: "ActionDisabledError",
      statusCode: 409,
      reason: "Bereits versandt",
      message: "Bereits versandt",
    });
    const en_ = await reasonsOf(send, en);
    expect(en_.list).toEqual([{ ship: "Already shipped", shipMany: "Already shipped" }, null]);
    expect(en_.one.disabledReasons).toEqual({
      ship: "Already shipped",
      shipMany: "Already shipped",
    });
    expect(en_.refused.reason).toBe("Already shipped");
    expect(de_.skipped).toEqual([{ id: { id: 1 }, reason: "Bereits versandt" }]);
    expect(en_.skipped).toEqual([{ id: { id: 1 }, reason: "Already shipped" }]);
  });

  it("no translator: the reasons as the predicate wrote them", async () => {
    const send = await seeded();
    const r = await reasonsOf(send, de);
    expect(r.list).toEqual([{ ship: "Already shipped", shipMany: "Already shipped" }, null]);
    expect(r.one.disabledReasons).toEqual({ ship: "Already shipped", shipMany: "Already shipped" });
    expect(r.refused).toMatchObject({ reason: "Already shipped", message: "Already shipped" });
    expect(r.skipped).toEqual([{ id: { id: 1 }, reason: "Already shipped" }]);
  });
});
