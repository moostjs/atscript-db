import { describe, it, expect, beforeAll, afterEach, vi } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import { HttpError, MoostHttp } from "@moostjs/event-http";
import { useHeaders } from "@wooksjs/event-http";
import { Moost, clearGlobalWooks, getMoostInfact } from "moost";

// Cross-package source import (as the adapters do with db's test-kit):
// moost-db does not depend on db-client.
import { Client, ClientError, MetaStore } from "../../../db-client/src";
import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { prepareFixtures } from "./test-utils";

/**
 * db-client's meta store against a real listening moost-db server: the
 * prerendered `/meta` (weak ETag, `304` on a matching `If-None-Match`) of a
 * parametric mount is downloaded once and revalidated for every other
 * route param.
 */

let SgAccount: any;
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  await prepareFixtures();
  ({ SgAccount } = await import("./fixtures/security-gates.as"));
});

afterEach(async () => {
  await stop?.();
  stop = undefined;
});

async function boot() {
  clearGlobalWooks();
  getMoostInfact()._cleanup();
  const db = createAdapter();
  const table = db.getTable(SgAccount);
  await db.getAdapter(SgAccount).ensureTable();
  @TableController(table as never)
  class TenantAccounts extends AsDbController {
    protected override async prepareRequest(): Promise<void> {
      if (useHeaders()["x-fail"] === "1") throw new HttpError(500, "boom");
    }
  }

  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(["tenant/:tenantId/accounts", TenantAccounts]);
  await app.init();
  await http.listen(0);
  const server = http.getHttpApp().getServer() as { address(): { port: number } };
  stop = async () => {
    await http.getHttpApp().close();
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const exchanges: Array<{ url: string; ifNoneMatch?: string; status: number; etag?: string }> = [];
  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    const res = await globalThis.fetch(url, init);
    exchanges.push({
      url: url.slice(baseUrl.length),
      ifNoneMatch: (init?.headers as Record<string, string> | undefined)?.["If-None-Match"],
      status: res.status,
      etag: res.headers.get("etag") ?? undefined,
    });
    return res;
  });
  let fail = false;
  const client = (tenant: string, opts: { metaStore: MetaStore; metaKey?: string }) =>
    new Client(`/tenant/${tenant}/accounts`, {
      baseUrl,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      headers: (): Record<string, string> => (fail ? { "x-fail": "1" } : {}),
      ...opts,
    });
  return { client, exchanges, setFail: (v: boolean) => (fail = v) };
}

describe("db-client meta store against moost-db /meta", () => {
  it("a shared metaKey: the first tenant downloads, the next one revalidates with a 304", async () => {
    const { client, exchanges } = await boot();
    const metaStore = new MetaStore();
    const metaKey = "/tenant/:tenantId/accounts";

    const a = await client("acme", { metaStore, metaKey }).meta();
    const b = await client("globex", { metaStore, metaKey }).meta();

    expect(b).toEqual(a);
    expect(a.fields).toBeDefined();
    const [first, second] = exchanges;
    expect(first).toMatchObject({ url: "/tenant/acme/accounts/meta", status: 200 });
    expect(first!.ifNoneMatch).toBeUndefined();
    expect(first!.etag).toMatch(/^W\/"/);
    expect(second).toEqual({
      url: "/tenant/globex/accounts/meta",
      ifNoneMatch: first!.etag,
      status: 304,
      etag: first!.etag,
    });
    expect(exchanges).toHaveLength(2);
  });

  it("without metaKey: the same URL revalidates after invalidateMeta(); another URL downloads", async () => {
    const { client, exchanges } = await boot();
    const metaStore = new MetaStore();
    const acme = client("acme", { metaStore });

    const first = await acme.meta();
    acme.invalidateMeta();
    expect(await acme.meta()).toEqual(first);
    await client("globex", { metaStore }).meta();

    expect(exchanges.map((e) => [e.url, e.ifNoneMatch === undefined, e.status])).toEqual([
      ["/tenant/acme/accounts/meta", true, 200],
      ["/tenant/acme/accounts/meta", false, 304],
      ["/tenant/globex/accounts/meta", true, 200],
    ]);
  });

  it("a 500 is thrown and not cached; the next call downloads with no If-None-Match", async () => {
    const { client, exchanges, setFail } = await boot();
    const metaStore = new MetaStore();

    setFail(true);
    const err = await client("acme", { metaStore })
      .meta()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect(err.status).toBe(500);
    expect(metaStore.size).toBe(0);

    setFail(false);
    await client("acme", { metaStore }).meta();
    expect(exchanges.map((e) => [e.ifNoneMatch, e.status])).toEqual([
      [undefined, 500],
      [undefined, 200],
    ]);
  });

  it("a request that fails while holding a stored ETag gets the error, never the stored body", async () => {
    const { client, exchanges, setFail } = await boot();
    const metaStore = new MetaStore();
    await client("acme", { metaStore }).meta();
    setFail(true);
    await expect(client("acme", { metaStore }).meta()).rejects.toBeInstanceOf(ClientError);
    expect(exchanges.map((e) => [e.ifNoneMatch === undefined, e.status])).toEqual([
      [true, 200],
      [false, 500],
    ]);
  });

  it("clear() drops the stored bodies: the next request carries no If-None-Match", async () => {
    const { client, exchanges } = await boot();
    const metaStore = new MetaStore();
    await client("acme", { metaStore }).meta();
    metaStore.clear();
    await client("acme", { metaStore }).meta();
    expect(exchanges.map((e) => [e.ifNoneMatch, e.status])).toEqual([
      [undefined, 200],
      [undefined, 200],
    ]);
  });
});
