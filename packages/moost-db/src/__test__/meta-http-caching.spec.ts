import { describe, it, expect, beforeAll, beforeEach, vi } from "vite-plus/test";
import type { AtscriptDbTable } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { HttpError, MoostHttp } from "@moostjs/event-http";
import { useHeaders, useResponse } from "@wooksjs/event-http";
import {
  Intercept,
  Moost,
  clearGlobalWooks,
  defineAfterInterceptor,
  defineBeforeInterceptor,
  getMoostInfact,
} from "moost";

import { AsDbController } from "../as-db.controller";
import { stableMeta } from "../meta/meta-cache";
import type { TDbMetaHttpCaching } from "../as-readable.controller";
import { TableController } from "../decorators";
import { prepareFixtures } from "./test-utils";

/**
 * `/meta` HTTP caching (since 0.1.151): the served object is identity-stable
 * per (envelope, request-dependent answers), serialized once and sent with a
 * weak ETag computed from its bytes — a request seeing a different `/meta`
 * never gets a `304` for someone else's copy.
 */

let SgAccount: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ SgAccount } = await import("./fixtures/security-gates.as"));
});

/** Field heads hidden per role (the `x-role` request header). */
const ROLES: Record<string, string[]> = {
  admin: [],
  viewer: ["secretNote"],
  viewerToo: ["secretNote"],
  narrow: ["secretNote", "note"],
};

function role(): string {
  return String(useHeaders()["x-role"] ?? "admin");
}

/** The role's hidden set, or `HIDDEN_OVERRIDE` when a test sets one. */
let HIDDEN_OVERRIDE: Set<string> | undefined;
function hidden(): Set<string> {
  return HIDDEN_OVERRIDE ?? new Set(ROLES[role()] ?? []);
}

class RoleController extends AsDbController {
  protected override async prepareRequest(): Promise<void> {
    if (role() === "none") throw new HttpError(403, "forbidden");
  }

  protected override hasField(path: string): boolean {
    return super.hasField(path) && !hidden().has(path.split(".")[0]!);
  }
}

async function accountsTable(): Promise<AtscriptDbTable<any>> {
  const db = createAdapter();
  const table = db.getTable(SgAccount) as any;
  await db.getAdapter(SgAccount).ensureTable();
  vi.spyOn(table, "getSearchIndexes").mockReturnValue([
    { name: "txt_idx", type: "text", fields: ["title", "secretNote"], isDefault: true },
    { name: "note_idx", type: "text", fields: ["note"] },
  ]);
  vi.spyOn(table, "isSearchable").mockReturnValue(true);
  return table;
}

async function boot(
  Ctrl: new (...args: any[]) => AsDbController,
  table: AtscriptDbTable<any>,
  opts: { prefix?: string; globalPrefix?: string } = {},
) {
  TableController(table as never, opts.prefix ?? "accounts")(Ctrl);
  const app = new Moost({ globalPrefix: opts.globalPrefix });
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(Ctrl);
  await app.init();
  const base = `${opts.globalPrefix ? `/${opts.globalPrefix}` : ""}/${opts.prefix ?? "accounts"}`;
  const get = async (headers: Record<string, string> = {}, path = "/meta") => {
    const res = (await http.request(`${base}${path}`, { headers }))!;
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  };
  return { app, get };
}

beforeEach(() => {
  clearGlobalWooks();
  getMoostInfact()._cleanup();
  HIDDEN_OVERRIDE = undefined;
});

describe("/meta HTTP caching", () => {
  it("plain controller: identical bytes, ETag + Cache-Control + Vary, 304 on revalidation", async () => {
    class Plain extends AsDbController {}
    const { get } = await boot(Plain, await accountsTable());
    const a = await get();
    const b = await get();
    expect(a.status).toBe(200);
    expect(b.text).toBe(a.text);
    const etag = a.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"/);
    expect(b.headers.get("etag")).toBe(etag);
    expect(a.headers.get("cache-control")).toBe("private, no-cache");
    expect(a.headers.get("vary")).toBe("Authorization, Cookie");

    const c = await get({ "if-none-match": etag });
    expect(c.status).toBe(304);
    expect(c.text).toBe("");
    expect(c.headers.get("etag")).toBe(etag);
    expect(c.headers.get("cache-control")).toBe("private, no-cache");
    expect(c.headers.get("vary")).toBe("Authorization, Cookie");
  });

  it("role switch with a carried If-None-Match: 200 with the new role's body and a different ETag", async () => {
    const { get } = await boot(RoleController, await accountsTable());
    const admin = await get({ "x-role": "admin" });
    const etagA = admin.headers.get("etag")!;
    expect(JSON.parse(admin.text).searchIndexes.map((i: any) => i.name)).toEqual([
      "txt_idx",
      "note_idx",
    ]);

    const viewer = await get({ "x-role": "viewer", "if-none-match": etagA });
    expect(viewer.status).toBe(200);
    const etagV = viewer.headers.get("etag")!;
    expect(etagV).not.toBe(etagA);
    const viewerMeta = JSON.parse(viewer.text);
    expect(viewerMeta.searchIndexes.map((i: any) => i.name)).toEqual(["note_idx"]);
    expect(viewerMeta.searchable).toBe(false);

    // Back to admin with the viewer's tag: 200, admin's bytes again.
    const adminAgain = await get({ "x-role": "admin", "if-none-match": etagV });
    expect(adminAgain.status).toBe(200);
    expect(adminAgain.text).toBe(admin.text);
    expect(adminAgain.headers.get("etag")).toBe(etagA);

    // A different role seeing identical bytes may revalidate — the bytes are equal.
    const viewerToo = await get({ "x-role": "viewerToo" });
    expect(viewerToo.text).toBe(viewer.text);
    const revalidated = await get({ "x-role": "viewerToo", "if-none-match": etagV });
    expect(revalidated.status).toBe(304);

    // A narrower role never revalidates against a wider one's tag.
    const narrow = await get({ "x-role": "narrow", "if-none-match": etagV });
    expect(narrow.status).toBe(200);
    expect(narrow.headers.get("etag")).not.toBe(etagV);
    expect(narrow.text).not.toBe(viewer.text);
  });

  it("a forbidden request with a matching ETag is a 403, never a 304", async () => {
    const { get } = await boot(RoleController, await accountsTable());
    const etag = (await get({ "x-role": "admin" })).headers.get("etag")!;
    const res = await get({ "x-role": "none", "if-none-match": etag });
    expect(res.status).toBe(403);
    expect(res.headers.get("etag")).toBeNull();
  });

  it("an after-interceptor replacing the body: no ETag, no 304", async () => {
    @Intercept(
      defineAfterInterceptor((response, reply) => {
        reply({ ...(response as object), extra: true });
      }),
    )
    class Replaced extends AsDbController {}
    const table = await accountsTable();
    const plainEtag = await (async () => {
      class Plain extends AsDbController {}
      const { get } = await boot(Plain, table);
      return (await get()).headers.get("etag")!;
    })();
    clearGlobalWooks();
    getMoostInfact()._cleanup();
    const { get } = await boot(Replaced, table);
    const res = await get({ "if-none-match": plainEtag });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).extra).toBe(true);
    expect(res.headers.get("etag")).toBeNull();
  });

  it("served objects are frozen in test mode: an in-place mutation fails loudly", async () => {
    @Intercept(
      defineAfterInterceptor((response) => {
        (response as Record<string, unknown>).extra = true;
      }),
    )
    class Mutating extends AsDbController {}
    const { get } = await boot(Mutating, await accountsTable());
    const res = await get();
    expect(res.status).toBe(500);
  });

  it("a capability rebuild serves a new ETag", async () => {
    const table = await accountsTable();
    const geo = vi.spyOn(table as any, "isGeoSearchable").mockReturnValue(false);
    class Plain extends AsDbController {}
    const { get } = await boot(Plain, table);
    const before = await get();
    geo.mockReturnValue(true);
    const after = await get({ "if-none-match": before.headers.get("etag")! });
    expect(after.status).toBe(200);
    expect(after.text).not.toBe(before.text);
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
  });

  it("another app (mount path) serves a new ETag", async () => {
    const table = await accountsTable();
    class First extends AsDbController {}
    const one = await (await boot(First, table, { globalPrefix: "v1" })).get();
    clearGlobalWooks();
    getMoostInfact()._cleanup();
    class Second extends AsDbController {}
    const two = await (await boot(Second, table, { globalPrefix: "v2" })).get();
    expect(two.text).not.toBe(one.text);
    expect(two.headers.get("etag")).not.toBe(one.headers.get("etag"));
  });

  it("metaHttpCaching() false: no ETag, no caching headers, no 304", async () => {
    class OptOut extends AsDbController {
      protected override metaHttpCaching(): false {
        return false;
      }
    }
    const { get } = await boot(OptOut, await accountsTable());
    const res = await get({ "if-none-match": "*" });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });

  it("custom caching headers; an existing Cache-Control is kept, Vary is merged", async () => {
    @Intercept(
      defineBeforeInterceptor(() => {
        useResponse().setHeader("Vary", "Accept-Language, cookie");
      }),
    )
    class Custom extends AsDbController {
      protected override metaHttpCaching(): TDbMetaHttpCaching {
        return { cacheControl: "no-store", vary: ["Authorization", "Cookie", "X-Tenant"] };
      }
    }
    const { get } = await boot(Custom, await accountsTable());
    const res = await get();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("Accept-Language, cookie, Authorization, X-Tenant");
    expect(res.headers.get("etag")).toMatch(/^W\//);

    @Intercept(
      defineBeforeInterceptor(() => {
        useResponse().setHeader("Cache-Control", "max-age=60");
      }),
    )
    class Preset extends AsDbController {}
    clearGlobalWooks();
    getMoostInfact()._cleanup();
    const preset = await (await boot(Preset, await accountsTable())).get();
    expect(preset.headers.get("cache-control")).toBe("max-age=60");
  });

  it("differential: memoized /meta equals an unmemoized build byte for byte across random visibility", async () => {
    const table = await accountsTable();
    /** Memo off: an overlay returning a fresh copy defeats every identity memo. */
    class Unmemoized extends RoleController {
      protected override applyMetaOverlay(meta: any) {
        return { ...meta };
      }
    }
    TableController(table as never, "off")(Unmemoized);
    const app = new Moost();
    const http = new MoostHttp();
    app.adapter(http);
    TableController(table as never, "on")(RoleController);
    app.registerControllers(RoleController, Unmemoized);
    await app.init();
    const fetchText = async (path: string) => {
      const res = (await http.request(path))!;
      return { text: await res.text(), etag: res.headers.get("etag") };
    };
    const heads = ["title", "secretNote", "note", "embedding", "home", "settings", "apiKeyCopy"];
    let seed = 7;
    const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
    const seen = new Map<string, { text: string; etag: string | null }>();
    for (let i = 0; i < 150; i++) {
      HIDDEN_OVERRIDE = new Set(heads.filter(() => random() < 0.4));
      const key = [...HIDDEN_OVERRIDE].toSorted().join(",");
      const on = await fetchText("/on/meta");
      const off = await fetchText("/off/meta");
      // `db.http.path` of the root differs by mount; everything else must match.
      expect(on.text.replace('"/on"', '"/off"'), key).toBe(off.text);
      expect(off.etag, key).toBeNull();
      expect(on.etag, key).toMatch(/^W\//);
      const prior = seen.get(key);
      if (prior) {
        expect(on.text, key).toBe(prior.text);
        expect(on.etag, key).toBe(prior.etag);
      } else {
        seen.set(key, on);
      }
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it("an overlay reusing a shallow-frozen object is never served from stale bytes", async () => {
    // Anti-pattern (mutates a nested part of a reused object per request):
    // `Object.freeze` alone does not make an object reusable.
    let shared: any;
    class Overlay extends AsDbController {
      protected override applyMetaOverlay(meta: any) {
        shared ??= Object.freeze({ ...meta, crud: { ...meta.crud } });
        shared.crud.query = role() === "admin" ? ["$limit"] : ["$skip"];
        return shared;
      }
    }
    const { get } = await boot(Overlay, await accountsTable());
    const a = await get({ "x-role": "admin" });
    const b = await get({ "x-role": "viewer" });
    expect(JSON.parse(a.text).crud.query).toEqual(["$limit"]);
    expect(JSON.parse(b.text).crud.query).toEqual(["$skip"]);
    expect(a.headers.get("etag")).toBeNull();
  });

  it("stableMeta(): a memoized overlay variant is served with an ETag and 304", async () => {
    const variants = new Map<string, any>();
    class Overlay extends AsDbController {
      protected override applyMetaOverlay(meta: any) {
        const r = role();
        let v = variants.get(r);
        if (!v) variants.set(r, (v = stableMeta({ ...meta, crud: { ...meta.crud, role: [r] } })));
        return v;
      }
    }
    const { get } = await boot(Overlay, await accountsTable());
    const a = await get({ "x-role": "admin" });
    const etag = a.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    expect(Object.isFrozen(variants.get("admin").crud)).toBe(true);
    expect((await get({ "x-role": "admin", "if-none-match": etag })).status).toBe(304);
    const b = await get({ "x-role": "viewer", "if-none-match": etag });
    expect(b.status).toBe(200);
    expect(JSON.parse(b.text).crud.role).toEqual(["viewer"]);
  });

  it("an overridden meta() gets the headers but no ETag (it may post-process the result)", async () => {
    class Enriched extends AsDbController {
      override async meta() {
        return { ...(await super.meta()), extra: 1 } as any;
      }
    }
    const { get } = await boot(Enriched, await accountsTable());
    const a = await get();
    expect(JSON.parse(a.text).extra).toBe(1);
    expect(a.headers.get("etag")).toBeNull();
    expect(a.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("metaHttpCaching() false for some requests: those never get an ETag or a 304", async () => {
    class Partial extends AsDbController {
      protected override metaHttpCaching() {
        return useHeaders()["x-no-cache"] ? (false as const) : {};
      }
    }
    const { get } = await boot(Partial, await accountsTable());
    const etag = (await get())!.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    const off = await get({ "x-no-cache": "1", "if-none-match": etag });
    expect(off.status).toBe(200);
    expect(off.headers.get("etag")).toBeNull();
  });
});
