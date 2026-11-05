import { describe, it, expect, vi, beforeAll, afterEach } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { Client } from "../client";
import { ClientValidationError } from "../client-error";
import { MetaStore, clearMetaStore } from "../meta-store";
import type { MetaResponse } from "../types";
import { createClientValidator } from "../validator";

/**
 * `ClientOptions.locale` (since 0.1.170): every request asks for the locale
 * (`Accept-Language`), the cached `/meta` (and what is built from it) belongs
 * to one locale, and the preflight speaks the served type's language
 * (`type.$i18n`), keeping each error's `code` / `params`.
 */

const DE_I18N = {
  TYPE: "{expected} erwartet, {actual} erhalten",
  FIELD_OP_NOT_NUMERIC: "Feldoperationen nur auf Zahlenfeldern",
};

let metaDe: MetaResponse;
let metaEn: MetaResponse;

beforeAll(async () => {
  const fixtures = await import("./fixtures/test-table.as");
  const type = serializeAnnotatedType(fixtures.User as unknown as TAtscriptAnnotatedType);
  const base = {
    searchable: false,
    vectorSearchable: false,
    searchIndexes: [],
    primaryKeys: ["id"],
    preferredId: ["id"],
    relations: [],
    fields: {},
    actions: [],
    crud: {},
  };
  metaEn = { ...base, type } as MetaResponse;
  metaDe = { ...base, type: { ...type, $i18n: DE_I18N } } as MetaResponse;
});

afterEach(() => clearMetaStore());

/** A server answering `/meta` per `Accept-Language` (ETag per language), recording the headers. */
function serverMock() {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url, headers });
    if (!url.endsWith("/meta")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    const lang = headers["Accept-Language"] === "de" ? "de" : "en";
    const etag = `W/"${lang}"`;
    if (headers["If-None-Match"]?.includes(etag)) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(JSON.stringify(lang === "de" ? metaDe : metaEn), {
      status: 200,
      headers: { "content-type": "application/json", etag },
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

describe("ClientOptions.locale", () => {
  it("sends Accept-Language on every request", async () => {
    const { fetch, sent } = serverMock();
    const client = new Client("/api/users", { fetch, locale: "de" });
    await client.query();
    await client.meta();
    expect(sent.map((s) => s.headers["Accept-Language"])).toEqual(["de", "de"]);
  });

  it("reads a getter per request; a header the app sets itself wins", async () => {
    const { fetch, sent } = serverMock();
    let locale: string | undefined = "de";
    const client = new Client("/api/users", { fetch, locale: () => locale });
    await client.query();
    locale = "fr";
    await client.query();
    locale = undefined;
    await client.query();
    const own = new Client("/api/users", {
      fetch,
      locale: "de",
      headers: { "accept-language": "it" },
    });
    await own.query();
    expect(sent.map((s) => s.headers["Accept-Language"])).toEqual([
      "de",
      "fr",
      undefined,
      undefined,
    ]);
    expect(sent[3]!.headers["accept-language"]).toBe("it");
  });

  it("without a locale nothing changes: no header, the store key is the URL", async () => {
    const { fetch, sent } = serverMock();
    const metaStore = new MetaStore();
    await new Client("/api/users", { fetch, metaStore }).meta();
    expect(sent[0]!.headers["Accept-Language"]).toBeUndefined();
    expect(metaStore.candidates("/api/users/meta")).toEqual(['W/"en"']);
  });

  it("the cached /meta belongs to one locale: a switch refetches, a switch back revalidates (304)", async () => {
    const { fetch, sent } = serverMock();
    const metaStore = new MetaStore();
    let locale = "de";
    const client = new Client("/api/users", { fetch, metaStore, locale: () => locale });
    expect((await client.meta()).type.$i18n).toEqual(DE_I18N);
    expect(await client.meta()).toBe(await client.meta()); // cached per locale
    locale = "en";
    expect((await client.meta()).type.$i18n).toBeUndefined();
    locale = "de";
    expect((await client.meta()).type.$i18n).toEqual(DE_I18N);
    expect(sent.map((s) => [s.headers["Accept-Language"], s.headers["If-None-Match"]])).toEqual([
      ["de", undefined],
      ["en", undefined],
      ["de", 'W/"de"'],
    ]);
    expect(metaStore.candidates("/api/users/meta#de")).toEqual(['W/"de"']);
    expect(metaStore.candidates("/api/users/meta#en")).toEqual(['W/"en"']);
  });

  it("the preflight validator follows the locale", async () => {
    const { fetch } = serverMock();
    let locale = "de";
    const client = new Client("/api/users", { fetch, locale: () => locale });
    const de = await client.getValidator();
    expect(await client.getValidator()).toBe(de);
    locale = "en";
    expect(await client.getValidator()).not.toBe(de);
  });

  it("preflight errors are translated with type.$i18n, keeping code and params", async () => {
    const { fetch, sent } = serverMock();
    const client = new Client("/api/users", { fetch, locale: "de" });
    const error = await client.insert({ name: 5 } as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientValidationError);
    expect((error as ClientValidationError).errors).toEqual([
      {
        path: "name",
        message: "string erwartet, number erhalten",
        code: "TYPE",
        params: { expected: "string", actual: "number" },
      },
    ]);
    expect((error as ClientValidationError).message).toBe("string erwartet, number erhalten");
    const op = await client.update({ id: 1, name: { $inc: 1 } } as never).catch((e: unknown) => e);
    expect((op as ClientValidationError).errors[0]).toMatchObject({
      code: "FIELD_OP_NOT_NUMERIC",
      message: "Feldoperationen nur auf Zahlenfeldern",
    });
    expect(sent.every((s) => s.url.endsWith("/meta"))).toBe(true); // nothing else was sent
  });

  it("createClientValidator: English without $i18n, codes kept", () => {
    try {
      createClientValidator(metaEn).validate({ name: 5 }, "insert");
      expect.unreachable();
    } catch (error) {
      expect((error as ClientValidationError).errors[0]).toMatchObject({
        path: "name",
        code: "TYPE",
        message: "Expected string, got number",
      });
    }
  });
});
