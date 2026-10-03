import { describe, it, expect, vi } from "vite-plus/test";
import type { TDbActionInfo } from "@atscript/db";

import { Client, actionIdentifier } from "../client";
import { ActionTargetError, ActionUnsupportedError } from "../client-error";

/**
 * Since 0.1.147: delegated actions (`owner` + `idMap` — ids are mapped from
 * this controller's rows to the owner's identification) and query targets
 * (`actionOnQuery` / `countActionTarget`, `ActionTargetError`).
 */

const META_BASE = {
  searchable: true,
  vectorSearchable: false,
  searchIndexes: [],
  primaryKeys: ["rowId"],
  preferredId: ["rowId"],
  relations: [],
  fields: {},
  crud: {},
  type: { type: { kind: "object", props: {}, propsPatterns: [], tags: [] }, metadata: {} },
};

const CLOSE: TDbActionInfo = {
  name: "close",
  label: "Close",
  level: "rows",
  processor: "backend",
  value: "/api/issues/actions/close",
  owner: "/api/issues",
  idMap: { id: "issueId" },
  queryTarget: { maxRows: 500, url: "/api/board/delegated-actions/close" },
};
const COMMENT: TDbActionInfo = {
  name: "comment",
  label: "Comment",
  level: "row",
  processor: "backend",
  value: "/api/issues/actions/comment",
  owner: "/api/issues",
  idMap: { tenant: "org.id", number: "issueNo" },
};
const OPEN: TDbActionInfo = {
  name: "open",
  label: "Open",
  level: "row",
  processor: "navigate",
  value: "/issues/$1",
  owner: "/api/issues",
  idMap: { tenant: "org.id", number: "issueNo" },
};
const OWN: TDbActionInfo = {
  name: "pin",
  label: "Pin",
  level: "rows",
  processor: "backend",
  value: "/api/board/actions/pin",
  queryTarget: { maxRows: 100 },
};
const PLAIN: TDbActionInfo = {
  name: "plain",
  label: "Plain",
  level: "rows",
  processor: "backend",
  value: "/api/board/actions/plain",
};

function client(
  respond: (url: string, init: RequestInit) => { status?: number; body: unknown } = () => ({
    body: { ok: true },
  }),
  opts: { navigate?: (url: string) => void; baseUrl?: string } = {},
) {
  const fetchFn = vi.fn().mockImplementation((url: string, init: RequestInit) => {
    const { status = 200, body } = url.endsWith("/meta")
      ? { body: { ...META_BASE, actions: [CLOSE, COMMENT, OPEN, OWN, PLAIN] } }
      : respond(url, init);
    return Promise.resolve({
      ok: status < 400,
      status,
      statusText: "",
      headers: new Map() as unknown as Headers,
      json: () => Promise.resolve(body),
    });
  });
  const c = new Client("/api/board", { fetch: fetchFn, ...opts });
  const posted = () =>
    fetchFn.mock.calls
      .filter(([u]) => !String(u).endsWith("/meta"))
      .map(([u, init]) => ({ url: u, body: JSON.parse((init as RequestInit).body as string) }));
  return { c, posted };
}

describe("delegated actions (idMap)", () => {
  it("maps each row of this controller to the owner's identification", async () => {
    const { c, posted } = client();
    await c.action("close", [
      { rowId: 10, issueId: 1, title: "a" },
      { rowId: 11, issueId: 2 },
    ] as never);
    expect(posted()).toEqual([
      { url: "/api/issues/actions/close", body: { ids: [{ id: 1 }, { id: 2 }] } },
    ]);
  });

  it("maps composite ids through dot paths; a missing path is a TypeError naming it", async () => {
    const { c, posted } = client();
    await c.action("comment", { org: { id: "acme" }, issueNo: 7 } as never, { note: "hi" });
    expect(posted()[0].body).toEqual({ ids: { tenant: "acme", number: 7 }, input: { note: "hi" } });
    await expect(c.action("comment", { issueNo: 7 } as never)).rejects.toThrow(
      /client.action\("comment"\): the identifier has no "org.id"/,
    );
  });

  it("navigate $1 uses the mapped id in idMap order", async () => {
    const navigate = vi.fn();
    const { c } = client(undefined, { navigate });
    await c.action("open", { issueNo: 7, org: { id: "a b" } } as never);
    expect(navigate).toHaveBeenCalledWith("/issues/a%20b/7");
  });

  it("actionIdentifier: idMap mapping, preferredId extraction, identifier passthrough", () => {
    expect(actionIdentifier(CLOSE, { rowId: 1, issueId: 9 }, ["rowId"])).toEqual({ id: 9 });
    expect(actionIdentifier(OWN, { rowId: 1, title: "x" }, ["rowId"])).toEqual({ rowId: 1 });
    expect(actionIdentifier(OWN, { slug: "s" }, ["rowId"])).toEqual({ slug: "s" });
    expect(() => actionIdentifier(CLOSE, { rowId: 1, issueId: null }, ["rowId"])).toThrow(
      TypeError,
    );
  });

  it("dot paths also read flat dotted keys (a flattened row) — the flat key first", async () => {
    expect(actionIdentifier(COMMENT, { "org.id": "acme", issueNo: 7 }, ["rowId"])).toEqual({
      tenant: "acme",
      number: 7,
    });
    expect(
      actionIdentifier(COMMENT, { "org.id": "flat", org: { id: "nested" }, issueNo: 7 }, ["rowId"]),
    ).toEqual({ tenant: "flat", number: 7 });
    const { c, posted } = client();
    await c.action("comment", { "org.id": "acme", issueNo: 7 } as never);
    expect(posted()[0].body).toEqual({ ids: { tenant: "acme", number: 7 } });
  });
});

describe("query targets", () => {
  it("actionOnQuery POSTs { query: { q, … }, input } to queryTarget.url (else value)", async () => {
    const { c, posted } = client(() => ({
      body: { matched: 2, processed: 2, skipped: [], failed: [] },
    }));
    const summary = await c.actionOnQuery(
      "close",
      {
        filter: { teamId: "a", status: { $ne: "closed" } } as never,
        search: "urgent",
        index: "main",
        exclude: [{ rowId: 10 }],
        expectCount: 2,
        maxRows: 50,
      },
      { reason: "done" },
    );
    expect(summary).toEqual({ matched: 2, processed: 2, skipped: [], failed: [] });
    const [call] = posted();
    expect(call.url).toBe("/api/board/delegated-actions/close");
    expect(call.body.input).toEqual({ reason: "done" });
    expect(call.body.query).toMatchObject({
      exclude: [{ rowId: 10 }],
      expectCount: 2,
      maxRows: 50,
    });
    const params = new URLSearchParams(call.body.query.q);
    expect(params.get("$search")).toBe("urgent");
    expect(params.get("$index")).toBe("main");
    expect(call.body.query.q).toContain("teamId=a");

    await c.actionOnQuery("pin", {});
    expect(posted()[1]).toEqual({ url: "/api/board/actions/pin", body: { query: { q: "" } } });
  });

  it("countActionTarget is a dry run returning { matched }; baseUrl is prefixed", async () => {
    const { c, posted } = client(() => ({ body: { matched: 7 } }), { baseUrl: "https://x.test" });
    expect(await c.countActionTarget("close", { filter: { teamId: "a" } as never })).toEqual({
      matched: 7,
    });
    expect(posted()[0]).toMatchObject({
      url: "https://x.test/api/board/delegated-actions/close",
      body: { query: { dryRun: true } },
    });
  });

  it("an action without queryTarget is refused client-side", async () => {
    const { c } = client();
    await expect(c.actionOnQuery("plain", {})).rejects.toBeInstanceOf(ActionUnsupportedError);
    await expect(c.countActionTarget("comment", {})).rejects.toBeInstanceOf(ActionUnsupportedError);
  });

  it("maps refusals to ActionTargetError with code / matched / cap", async () => {
    const { c } = client(() => ({
      status: 409,
      body: {
        name: "ActionTargetError",
        statusCode: 409,
        message: "The query now matches 3 rows (expected 2)",
        code: "TARGET_CHANGED",
        action: "close",
        matched: 3,
      },
    }));
    const error = await c.actionOnQuery("close", { expectCount: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionTargetError);
    expect(error).toMatchObject({
      code: "TARGET_CHANGED",
      matched: 3,
      action: "close",
      status: 409,
    });

    const { c: c2 } = client(() => ({
      status: 400,
      body: {
        name: "ActionTargetError",
        statusCode: 400,
        message: "too many",
        code: "TARGET_TOO_LARGE",
        action: "close",
        cap: 500,
      },
    }));
    await expect(c2.actionOnQuery("close", {})).rejects.toMatchObject({
      code: "TARGET_TOO_LARGE",
      cap: 500,
    });
  });
});
