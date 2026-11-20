/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import { Get } from "@moostjs/event-http";
import { Inherit, formatMessage, getMoostInfact, setTranslator } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { MOOST_DB_MESSAGES } from "../http-errors";
import { bootHttp, prepareFixtures, type THttpSend } from "./test-utils";

/**
 * Every 400 / 409 moost-db answers is coded (since 0.1.175): the envelope's
 * top-level `code` / `params` and its entry's, so a translator keys on the
 * code, never on the English text. One envelope per code.
 */

let EcItem: any;
let EcOwner: any;
let send: THttpSend;
let SEQ = 0;
let prefix = "";

beforeAll(async () => {
  await prepareFixtures();
  ({ EcItem, EcOwner } = await import("./fixtures/error-codes.as"));
  getMoostInfact()._cleanup();
  const adapter = createAdapter();
  const items = adapter.getTable(EcItem);
  adapter.getTable(EcOwner);
  prefix = `ec${++SEQ}`;

  @TableController(items, prefix)
  @Inherit()
  class Items extends AsDbController {
    /** A nested `join: 'same'` call inside a transaction opened without a level. */
    @Get("nested-tx")
    nestedTx() {
      return this.withTransaction(() =>
        this.withTransaction(async () => 1, { isolation: "read committed", join: "same" }),
      );
    }
  }

  send = await bootHttp(Items);
  expect((await send("POST", `/${prefix}`, { id: 1, title: "a", version: 1 })).status).toBe(201);
});

/** The envelope `res` must be: `code` / `params` on top and on its single entry. */
function expectCoded(
  res: { status: number; body: any },
  status: number,
  code: string,
  params: Record<string, unknown> | undefined,
  path?: string,
) {
  expect(res.status).toBe(status);
  expect(res.body.code).toBe(code);
  expect(res.body.params).toEqual(params);
  expect(res.body.errors).toHaveLength(1);
  expect(res.body.errors[0].code).toBe(code);
  expect(res.body.errors[0].params).toEqual(params);
  if (path !== undefined) expect(res.body.errors[0].path).toBe(path);
  expect(Object.hasOwn(MOOST_DB_MESSAGES, code)).toBe(true);
}

describe("coded error envelopes", () => {
  it("UNKNOWN_FIELD { field }", async () => {
    const res = await send("GET", `/${prefix}/query?nope=1`);
    expectCoded(res, 400, "UNKNOWN_FIELD", { field: "nope" }, "nope");
    expect(res.body.message).toBe('Unknown field "nope"');
  });

  it("UNKNOWN_RELATION { relation } (the top message keeps the list of relations)", async () => {
    const res = await send("GET", `/${prefix}/query?$with=nope`);
    expectCoded(res, 400, "UNKNOWN_RELATION", { relation: "nope" }, "$with");
    expect(res.body.message).toBe('Unknown relation "nope" in $with. Available relations: owner');
  });

  it("FIELD_NOT_PERMITTED { field, op }", async () => {
    const res = await send("GET", `/${prefix}/query?note=x`);
    expectCoded(res, 400, "FIELD_NOT_PERMITTED", { field: "note", op: "filter" }, "note");
    expect(res.body.message).toContain("add @db.column.filterable to enable");
  });

  it("FIELD_WRITE_ONLY { field, op }", async () => {
    const res = await send("GET", `/${prefix}/query?secret=x`);
    expectCoded(res, 400, "FIELD_WRITE_ONLY", { field: "secret", op: "filter" });
  });

  it("FIELD_NESTED_OBJECT { field, op }", async () => {
    const res = await send("GET", `/${prefix}/query?$sort=contact`);
    expectCoded(res, 400, "FIELD_NESTED_OBJECT", { field: "contact", op: "sort" });
  });

  it("NAVIGATION_PATH { field, op }", async () => {
    const res = await send("GET", `/${prefix}/query?$sort=owner`);
    expectCoded(res, 400, "NAVIGATION_PATH", { field: "owner", op: "sort" });
  });

  it("NOT_A_RELATION { field }", async () => {
    const res = await send("GET", `/${prefix}/query?title=$some(x=1)`);
    expectCoded(res, 400, "NOT_A_RELATION", { field: "title" });
  });

  it("RELATION_NOT_FILTERABLE { relation }", async () => {
    const res = await send("GET", `/${prefix}/query?owner=$some(name=a)`);
    expectCoded(res, 400, "RELATION_NOT_FILTERABLE", { relation: "owner" });
  });

  it("INVALID_QUERY (no params)", async () => {
    for (const qs of ["?title=json-", "?$sort=title&$with=owner&$groupBy=title"]) {
      const res = await send("GET", `/${prefix}/query${qs}`);
      expectCoded(res, 400, "INVALID_QUERY", undefined);
    }
  });

  it("EXPECTED_OBJECT", async () => {
    const res = await send("POST", `/${prefix}`, [1]);
    expectCoded(res, 400, "EXPECTED_OBJECT", undefined, "[0]");
    expect(res.body.message).toBe("Expected an object");
  });

  it("ARRAY_OP_ON_JSON: array operators on a @db.json field (send the whole array)", async () => {
    const res = await send("PATCH", `/${prefix}`, { id: 1, tags: { $insert: ["x"] } });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([
      expect.objectContaining({
        path: "tags",
        code: "ARRAY_OP_ON_JSON",
        message:
          "Array patch operators are not supported on a @db.json field — send the whole array",
      }),
    ]);
    const whole = await send("PATCH", `/${prefix}`, { id: 1, tags: ["x", "y"] });
    expect(whole.status).toBe(200);
  });

  // The core's entry code (since 0.1.177) has a template since 0.1.178. Its
  // `open` param is `null` here, so the template names `{requested}` only.
  // Since 0.1.179 the answer is 500 under that code (400 `INVALID_QUERY`
  // before): the server's code opened the transaction at the wrong level — no
  // request can fix it. The HTTP layer does not log an `HttpError` reply, so
  // the interceptor logs it.
  it("ISOLATION_MISMATCH { requested, open, join } — a nested withTransaction refused: 500, logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await send("GET", `/${prefix}/nested-tx`);
      expectCoded(
        res,
        500,
        "ISOLATION_MISMATCH",
        { requested: "read committed", open: null, join: "same" },
        "isolation",
      );
      expect(res.body.errors[0].message).toContain("join 'same'");
      expect(formatMessage(MOOST_DB_MESSAGES.ISOLATION_MISMATCH, res.body.params)).toBe(
        'The open transaction does not satisfy isolation "read committed" — set the level on the outermost call',
      );
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0][0]).toContain("moost-db");
      expect(logged.mock.calls[0][0]).toContain("join 'same'");
    } finally {
      logged.mockRestore();
    }
  });

  it("ISOLATION_MISMATCH: the template is registered (served in $i18n), the entry and the top message translated by code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const german = 'Isolation "{requested}" ist nicht erfüllt';
    setTranslator({ en: {}, de: { ISOLATION_MISMATCH: german } });
    try {
      const de = { "accept-language": "de" };
      const res = await send("GET", `/${prefix}/nested-tx`, undefined, de);
      expect(res.body.errors[0].message).toBe('Isolation "read committed" ist nicht erfüllt');
      // the top message is translated by the same code, with the same params
      expect(res.body.message).toBe('Isolation "read committed" ist nicht erfüllt');
      const meta = await send("GET", `/${prefix}/meta`, undefined, de);
      expect(meta.body.type.$i18n.ISOLATION_MISMATCH).toBe(german);
    } finally {
      setTranslator(undefined);
      logged.mockRestore();
    }
  });

  it("VERSION_MISMATCH { currentVersion } — `kind` kept", async () => {
    const { version } = (await send("GET", `/${prefix}/one/1`)).body;
    const res = await send("PATCH", `/${prefix}`, { id: 1, title: "b", $cas: { version: 99 } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "VERSION_MISMATCH",
      params: { currentVersion: version },
      kind: "version_mismatch",
      message: "version_mismatch",
      currentVersion: version,
    });
  });
});
