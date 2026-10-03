import { describe, it, expect, beforeAll, beforeEach, vi } from "vite-plus/test";
import type { AtscriptDbTable, DbSpace, TDbWriteCheckContext } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { AsReadableController, type TDbRequestContext } from "../as-readable.controller";
import {
  fakeOverview,
  idMate,
  inputFormMate,
  makeApp as makeActionApp,
} from "./actions-test-utils";
import { DbRowActions } from "../actions/db-actions.decorator";
import { unknownRelationError } from "../http-errors";
import { GEO_CONTROLS, PAGES_CONTROLS, QUERY_CONTROLS } from "../permissions/crud-controls";
import {
  createMockApp as makeApp,
  createMockReadable,
  errorsOf,
  prepareFixtures,
} from "./test-utils";

/**
 * 0.1.143 security gates of the readable / db controllers: the async
 * `prepareRequest` hook, `/geo` validation parity, index visibility gating,
 * derived columns following their source, the joined-row write-only seal,
 * `checkWrite` plumbing and the PK-first 409 disambiguation.
 */

let SgOrg: any;
let SgUser: any;
let SgTask: any;
let SgAccount: any;
let SgSlug: any;
let CommentForm: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ SgOrg, SgUser, SgTask, SgAccount, SgSlug } = await import("./fixtures/security-gates.as"));
  ({ CommentForm } = await import("./fixtures/input-form.as"));
});

type Row = Record<string, any>;

/** Paths (or path heads) the scoped controller hides — reset per test. */
let HIDDEN = new Set<string>();

class ScopedController extends AsDbController {
  protected override hasField(path: string): boolean {
    return super.hasField(path) && !HIDDEN.has(path) && !HIDDEN.has(path.split(".")[0]!);
  }
}

beforeEach(() => {
  HIDDEN = new Set();
});

async function space(): Promise<DbSpace> {
  const db = createAdapter();
  for (const type of [SgOrg, SgUser, SgTask, SgAccount, SgSlug]) {
    db.getTable(type);
    await db.getAdapter(type).ensureTable();
  }
  await db.getTable(SgOrg).insertMany([{ id: 1, name: "acme", apiToken: "tok-1" }] as never);
  await db.getTable(SgUser).insertMany([
    { id: 1, name: "alice", password: "pw-alice", orgId: 1 },
    { id: 2, name: "bob", password: "pw-bob", orgId: 1 },
  ] as never);
  await db.getTable(SgTask).insertMany([
    { id: 1, title: "t1", ownerId: 1 },
    { id: 2, title: "t2", ownerId: 2 },
  ] as never);
  await db.getTable(SgAccount).insertMany([
    {
      id: 1,
      title: "alpha",
      secretNote: "zebra",
      note: "n1",
      settings: { apiKey: "KEY-A", theme: "dark" },
    },
    {
      id: 2,
      title: "beta",
      secretNote: "lion",
      note: "n2",
      settings: { apiKey: "KEY-B", theme: "light" },
    },
  ] as never);
  return db;
}

async function status(p: Promise<unknown>): Promise<number | undefined> {
  const r = await p.then(
    (v) => v,
    (e: unknown) => e,
  );
  return r instanceof HttpError ? r.body.statusCode : undefined;
}

// ── prepareRequest ────────────────────────────────────────────────────────

describe("prepareRequest", () => {
  it("runs first on every endpoint, with the parsed controls on reads", async () => {
    const db = await space();
    const log: string[] = [];
    const contexts: TDbRequestContext[] = [];
    class Ctrl extends AsDbController {
      protected async prepareRequest(ctx: TDbRequestContext) {
        contexts.push(ctx);
        log.push(`prepare:${ctx.endpoint}`);
      }
      protected override hasField(path: string): boolean {
        log.push("hasField");
        return super.hasField(path);
      }
    }
    const c = new Ctrl(makeApp(), db.getTable(SgTask) as any);
    vi.spyOn(db.getTable(SgTask) as any, "isGeoSearchable").mockReturnValue(true);
    vi.spyOn(db.getTable(SgTask) as any, "geoSearch").mockResolvedValue([]);

    const calls: Array<[string, () => Promise<unknown>]> = [
      ["query", () => c.query("?$select=title")],
      ["pages", () => c.pages("?$select=title")],
      ["geo", () => c.geo("?$center=1,2&$select=title")],
      ["one", () => c.getOne("1", "?$select=title")],
      ["one", () => c.getOneComposite({ id: "1" }, "?id=1")],
      ["meta", () => c.meta()],
      ["metaForm", () => c.metaForm("Nope").catch(() => undefined)],
      ["insert", () => c.insert({ id: 9, title: "x" })],
      ["update", () => c.update({ id: 9, title: "y" })],
      ["replace", () => c.replace({ id: 9, title: "z" })],
      ["remove", () => c.remove("9")],
      ["remove", () => c.removeComposite({ id: "1" })],
    ];
    for (const [endpoint, run] of calls) {
      log.length = 0;
      await run();
      // Exactly one call, before anything consulted hasField.
      expect(log[0], endpoint).toBe(`prepare:${endpoint}`);
      expect(
        log.filter((e) => e.startsWith("prepare:")),
        endpoint,
      ).toHaveLength(1);
    }
    expect(contexts[0]!.controls).toMatchObject({ $select: ["title"] });
    expect(contexts[5]!.controls).toBeUndefined();
    expect(contexts[7]!.controls).toBeUndefined();
  });

  it("is awaited before validation — async policy feeds hasField / controls", async () => {
    const db = await space();
    class Ctrl extends AsDbController {
      private visible = new Set<string>();
      protected async prepareRequest(ctx: TDbRequestContext) {
        await new Promise((r) => setTimeout(r, 1));
        this.visible = new Set(["id", "title"]);
        (ctx.controls as Row).$limit = 1;
      }
      protected override hasField(path: string): boolean {
        return this.visible.has(path);
      }
    }
    const c = new Ctrl(makeApp(), db.getTable(SgTask) as any);
    const rows = (await c.query("?$select=title")) as Row[];
    expect(rows).toEqual([{ id: 1, title: "t1" }]);
  });

  it("a throw aborts the request before any read or write", async () => {
    const table = createMockReadable();
    class Ctrl extends AsDbController {
      protected prepareRequest() {
        throw new HttpError(403, "nope");
      }
    }
    const c = new Ctrl(makeApp(), table);
    await expect(c.query("?")).rejects.toMatchObject({ body: { statusCode: 403 } });
    await expect(c.insert({ id: 1 })).rejects.toMatchObject({ body: { statusCode: 403 } });
    await expect(c.remove("1")).rejects.toMatchObject({ body: { statusCode: 403 } });
    await expect(c.meta()).rejects.toMatchObject({ body: { statusCode: 403 } });
    expect(table.findMany).not.toHaveBeenCalled();
    expect(table.insertOne).not.toHaveBeenCalled();
    expect(table.deleteOne).not.toHaveBeenCalled();
  });

  it("runs once on a $actions read that consults the /meta overlay", async () => {
    const db = await space();
    const endpoints: string[] = [];
    @DbRowActions({
      approve: {
        label: "Approve",
        processor: "backend",
        value: "/approve",
        requiredFields: ["title"],
        disabled: (rows: unknown[]) => rows.map(() => false),
      },
    })
    class Ctrl extends AsDbController {
      protected prepareRequest(ctx: TDbRequestContext) {
        endpoints.push(ctx.endpoint);
      }
      protected override applyMetaOverlay(meta: any) {
        return meta;
      }
    }
    const c = new Ctrl(makeApp(), db.getTable(SgTask) as any);
    const rows = (await c.query("?$actions=true&$select=id")) as Row[];
    expect(rows[0]!.$actions).toEqual(["approve"]);
    expect(endpoints).toEqual(["query"]);
  });

  it("is optional: parseRequest parses and coerces without it", async () => {
    const c = new AsDbController(makeApp(), createMockReadable());
    expect(await (c as any).parseRequest("meta")).toBeUndefined();
    const req = await (c as any).parseRequest("one", "/one/1?$actions=true&x=1");
    expect(req.controls).toEqual({ $actions: true });
    expect(req.hasNonControl).toBe(true);
  });
});

// ── /geo validation parity ────────────────────────────────────────────────

describe("/geo runs validateParsed like /query", () => {
  function geoController(Ctrl: new (...args: any[]) => AsDbController = AsDbController) {
    return (async () => {
      const db = await space();
      const table = db.getTable(SgTask) as any;
      vi.spyOn(table, "isGeoSearchable").mockReturnValue(true);
      const geoSearch = vi.spyOn(table, "geoSearch").mockResolvedValue([]);
      vi.spyOn(table, "geoSearchWithCount").mockResolvedValue({ data: [], count: 0 });
      return { c: new Ctrl(makeApp(), table), geoSearch };
    })();
  }

  it("validateControls sees type 'geo' and can veto", async () => {
    const types: string[] = [];
    class Ctrl extends AsDbController {
      protected override validateControls(controls: Record<string, unknown>, type: any) {
        types.push(type);
        return controls.$with ? "$with is not allowed" : super.validateControls(controls, type);
      }
    }
    const { c, geoSearch } = await geoController(Ctrl);
    const r = await c.geo("?$center=0,0&$with=owner");
    expect(types).toEqual(["geo"]);
    expect(r).toBeInstanceOf(HttpError);
    expect((r as HttpError).body.statusCode).toBe(400);
    expect(geoSearch).not.toHaveBeenCalled();
  });

  it("checks $with relation names (a hidden relation is unknown)", async () => {
    HIDDEN = new Set(["owner"]);
    const { c, geoSearch } = await geoController(ScopedController);
    const r = await c.geo("?$center=0,0&$with=owner");
    expect(errorsOf(r)).toEqual([{ path: "$with", message: 'Unknown relation "owner"' }]);
    expect(geoSearch).not.toHaveBeenCalled();
  });

  it("rejects controls that are not geo controls (DTO)", async () => {
    const { c } = await geoController();
    expect(await status(c.geo("?$center=0,0&$search=x"))).toBe(400);
    expect(await status(c.geo("?$center=0,0&$page=x"))).toBe(400);
    expect(
      (await c.geo("?$center=0,0&$page=1&$size=2&$select=id&$maxDistance=10")) as Row,
    ).toMatchObject({
      page: 1,
    });
  });

  it("crud.geo lists the same controls as before", () => {
    expect(GEO_CONTROLS).toEqual([
      "filter",
      "insights",
      "center",
      "maxDistance",
      "minDistance",
      "index",
      "select",
      "skip",
      "limit",
      "page",
      "size",
      "with",
      "actions",
    ]);
  });
});

// ── Index visibility gating ───────────────────────────────────────────────

describe("text / vector / geo index gating through hasField", () => {
  async function accounts(Ctrl: new (...args: any[]) => AsDbController = ScopedController) {
    const db = await space();
    const table = db.getTable(SgAccount) as any;
    // What an adapter reports (0.1.143): logical `fields` + `isDefault`.
    vi.spyOn(table, "getSearchIndexes").mockReturnValue([
      { name: "txt_idx", type: "text", fields: ["title", "secretNote"], isDefault: true },
      { name: "note_idx", type: "text", fields: ["note"] },
      { name: "embedding", type: "vector", fields: ["embedding"], isDefault: true },
    ]);
    vi.spyOn(table, "isSearchable").mockReturnValue(true);
    vi.spyOn(table, "isGeoSearchable").mockReturnValue(true);
    const spies = {
      search: vi.spyOn(table, "search").mockResolvedValue([]),
      vectorSearch: vi.spyOn(table, "vectorSearch").mockResolvedValue([]),
      geoSearch: vi.spyOn(table, "geoSearch").mockResolvedValue([]),
      findMany: vi.spyOn(table, "findMany"),
      aggregate: vi.spyOn(table, "aggregate").mockResolvedValue([]),
    };
    class Embedded extends Ctrl {
      protected override computeEmbedding(): Promise<number[]> {
        return Promise.resolve([1, 0, 0]);
      }
    }
    return { c: new Embedded(makeApp(), table), table, ...spies };
  }

  it("indexFieldPaths maps each index to its logical fields", async () => {
    const { c } = await accounts();
    expect((c as any).indexFieldPaths()).toEqual([
      { name: "txt_idx", type: "text", fields: ["title", "secretNote"], isDefault: true },
      { name: "note_idx", type: "text", fields: ["note"], isDefault: false },
      { name: "embedding", type: "vector", fields: ["embedding"], isDefault: true },
      { name: "home", type: "geo", fields: ["home"], isDefault: true },
    ]);
  });

  it("a named text index over a hidden field answers like a nonexistent one", async () => {
    HIDDEN = new Set(["secretNote"]);
    const { c, search } = await accounts();
    const hidden = await c.query("?$search=zebra&$index=txt_idx");
    const missing = await c.query("?$search=zebra&$index=nope");
    expect(errorsOf(hidden)).toEqual([
      { path: "$index", message: 'Search index "txt_idx" not found' },
    ]);
    expect(errorsOf(missing)).toEqual([
      { path: "$index", message: 'Search index "nope" not found' },
    ]);
    expect(await status(c.pages("?$search=zebra&$index=txt_idx"))).toBe(400);
    expect(search).not.toHaveBeenCalled();
    await c.query("?$search=n1&$index=note_idx");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("SECURITY: a hidden DEFAULT text index answers like no index — never a native search over it", async () => {
    HIDDEN = new Set(["secretNote"]);
    const { c, search, findMany, aggregate } = await accounts();
    for (const pending of [
      c.query("?$search=alp&$select=id"),
      c.pages("?$search=alp"),
      c.query("?$search=zebra&$select=note,count(*):n&$groupBy=note"),
    ]) {
      expect(errorsOf(await pending)).toEqual([
        { path: "$search", message: "No search index available" },
      ]);
    }
    expect(search).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
    // a visible index stays usable by name
    await c.query("?$search=n1&$index=note_idx");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("/meta hides what the gate refuses: hidden indexes, and search when the default is hidden", async () => {
    HIDDEN = new Set(["secretNote", "embedding"]);
    const { c, table } = await accounts();
    vi.spyOn(table, "isVectorSearchable").mockReturnValue(true);
    const meta = (await c.meta()) as any;
    expect(meta.searchIndexes.map((i: any) => i.name)).toEqual(["note_idx"]);
    expect(meta.searchable).toBe(false);
    expect(meta.vectorSearchable).toBe(false);

    HIDDEN = new Set();
    const open = (await c.meta()) as any;
    expect(open.searchIndexes.map((i: any) => i.name)).toEqual([
      "txt_idx",
      "note_idx",
      "embedding",
    ]);
    expect(open.searchable).toBe(true);
    expect(open.vectorSearchable).toBe(true);
  });

  it("/meta crud leaves out the controls the gate would refuse", async () => {
    const without = (list: readonly string[], drop: string[]) =>
      list.filter((c) => !drop.includes(c));
    // The default text index, the vector index and the geo point hidden:
    // `note_idx` stays usable by name, so the text controls stay.
    HIDDEN = new Set(["secretNote", "embedding", "home"]);
    const { c } = await accounts();
    const meta = (await c.meta()) as any;
    expect(meta.crud.query).toEqual(without(QUERY_CONTROLS, ["vector", "threshold"]));
    expect(meta.crud.pages).toEqual(without(PAGES_CONTROLS, ["vector", "threshold"]));
    expect(meta.crud.geo).toBeUndefined();
    expect(meta.geoSearchable).toBe(false);

    // No text index visible either: nothing to search with.
    HIDDEN = new Set(["secretNote", "note", "embedding"]);
    const none = (await c.meta()) as any;
    const searchControls = ["search", "index", "fuzzy", "vector", "threshold"];
    expect(none.crud.query).toEqual(without(QUERY_CONTROLS, searchControls));
    expect(none.crud.pages).toEqual(without(PAGES_CONTROLS, searchControls));
    expect(none.crud.geo).toEqual([...GEO_CONTROLS]);
    for (const q of ["?$search=x", "?$search=x&$index=note_idx", "?$search=x&$vector=embedding"]) {
      expect(await status(c.query(q))).toBe(400);
    }

    HIDDEN = new Set();
    const open = (await c.meta()) as any;
    expect(open.crud.query).toEqual([...QUERY_CONTROLS]);
    expect(open.crud.geo).toEqual([...GEO_CONTROLS]);
  });

  it("a hidden vector index answers like a nonexistent one, before any embedding", async () => {
    HIDDEN = new Set(["embedding"]);
    const { c, vectorSearch } = await accounts();
    const hidden = await c.query("?$search=x&$vector=embedding");
    const missing = await c.query("?$search=x&$vector=nope");
    expect(errorsOf(hidden)).toEqual([
      { path: "$vector", message: 'Vector index "embedding" not found' },
    ]);
    expect(errorsOf(missing)).toEqual([
      { path: "$vector", message: 'Vector index "nope" not found' },
    ]);
    expect(await status(c.query("?$search=x&$vector="))).toBe(400);
    expect(vectorSearch).not.toHaveBeenCalled();
  });

  it("/geo over a hidden geo point answers like a missing geo index", async () => {
    HIDDEN = new Set(["home"]);
    const { c, geoSearch } = await accounts();
    expect(errorsOf(await c.geo("?$center=1,2"))).toEqual([
      {
        path: "",
        message: 'Table "sg_accounts" declares no @db.index.geo — geoSearch requires a geo index',
      },
    ]);
    expect(errorsOf(await c.geo("?$center=1,2&$index=home"))).toEqual([
      { path: "home", message: 'Geo index "home" not found on table "sg_accounts"' },
    ]);
    expect(geoSearch).not.toHaveBeenCalled();
  });

  it("/geo on an adapter without geo support: a hidden geo index still answers like a missing one", async () => {
    HIDDEN = new Set(["home"]);
    const { c, table, geoSearch } = await accounts();
    table.isGeoSearchable.mockReturnValue(false);
    geoSearch.mockRestore();
    vi.spyOn(table.getAdapter(), "isGeoSearchable").mockReturnValue(false);
    // The core checks the schema before the adapter, so a hidden index answers
    // exactly like a table without one, whatever the adapter supports.
    expect(errorsOf(await c.geo("?$center=1,2"))).toEqual([
      {
        path: "",
        message: 'Table "sg_accounts" declares no @db.index.geo — geoSearch requires a geo index',
      },
    ]);
  });

  it("an index without `fields` covers every field; no flagged default → the first of its type", async () => {
    const { c, table } = await accounts();
    table.getSearchIndexes.mockReturnValue([
      { name: "a", type: "text" },
      { name: "b", type: "text", fields: ["note"] },
    ]);
    const [a, b] = (c as any).indexFieldPaths();
    expect(a).toMatchObject({ name: "a", isDefault: true });
    expect(a.fields).toEqual(expect.arrayContaining(["title", "secretNote", "note", "home"]));
    expect(b).toEqual({ name: "b", type: "text", fields: ["note"], isDefault: false });
  });

  it("visible indexes and unmodified controllers are untouched", async () => {
    const scoped = await accounts();
    await scoped.c.query("?$search=zebra&$index=txt_idx");
    await scoped.c.query("?$search=x&$vector=embedding");
    await scoped.c.geo("?$center=1,2");
    expect(scoped.search).toHaveBeenCalledTimes(1);
    expect(scoped.vectorSearch).toHaveBeenCalledTimes(1);
    expect(scoped.geoSearch).toHaveBeenCalledTimes(1);

    // No hasField override → no gate; the adapter answers unknown names itself.
    const plain = await accounts(AsDbController);
    await plain.c.query("?$search=zebra&$index=nope");
    expect(plain.search).toHaveBeenCalledTimes(1);
  });
});

// ── Derived columns follow their source ────────────────────────────────────

describe("@db.column.derived follows its source's visibility", () => {
  async function accounts(Ctrl: new (...args: any[]) => AsDbController = ScopedController) {
    const db = await space();
    return new Ctrl(makeApp(), db.getTable(SgAccount) as any);
  }

  it("a derived field over a hidden source is an unknown field", async () => {
    HIDDEN = new Set(["settings"]);
    const c = await accounts();
    for (const qs of [
      "apiKeyCopy='KEY-B'",
      "$sort=apiKeyCopy",
      "$select=apiKeyCopy",
      "$select=apiKeyCopy,count(*):n&$groupBy=apiKeyCopy",
    ]) {
      expect(errorsOf(await c.query(`?${qs}`))?.[0], qs).toEqual({
        path: "apiKeyCopy",
        message: 'Unknown field "apiKeyCopy"',
      });
    }
  });

  it("…and is sealed out of every read projection for the request", async () => {
    HIDDEN = new Set(["settings"]);
    const c = await accounts();
    const rows = (await c.query("?")) as Row[];
    expect(rows[0]).not.toHaveProperty("apiKeyCopy");
    const excl = (await c.query("?$select=-title")) as Row[];
    expect(excl[0]).not.toHaveProperty("apiKeyCopy");
    const one = (await c.getOne("1", "?")) as Row;
    expect(one).not.toHaveProperty("apiKeyCopy");
    const pages = (await c.pages("?")) as { data: Row[] };
    expect(pages.data[0]).not.toHaveProperty("apiKeyCopy");
  });

  it("a hidden JSON leaf source hides the derived copy too", async () => {
    HIDDEN = new Set(["settings.apiKey"]);
    const c = await accounts();
    expect(await status(c.query("?$select=id,apiKeyCopy"))).toBe(400);
    expect(((await c.query("?")) as Row[])[0]).not.toHaveProperty("apiKeyCopy");
  });

  it("a visible source keeps the derived field (and unmodified controllers are unaffected)", async () => {
    const scoped = await accounts();
    expect(((await scoped.query("?$select=apiKeyCopy")) as Row[])[0]).toMatchObject({
      apiKeyCopy: "KEY-A",
    });
    const plain = await accounts(AsDbController);
    expect(((await plain.query("?")) as Row[])[0]).toMatchObject({ apiKeyCopy: "KEY-A" });
  });
});

// ── Joined-row write-only seal ─────────────────────────────────────────────

describe("$with: the joined table's @db.writeOnly fields are sealed", () => {
  async function tasks() {
    const db = await space();
    return new AsDbController(makeApp(), db.getTable(SgTask) as any);
  }
  const t1 = (rows: unknown) => (rows as Row[]).find((r) => r.id === 1)!;

  it("seals the default and explicit $with projections, recursively", async () => {
    const c = await tasks();
    const plain = t1(await c.query("?$with=owner"));
    expect(plain.owner).toMatchObject({ id: 1, name: "alice" });
    expect(plain.owner).not.toHaveProperty("password");

    const explicit = t1(await c.query("?$with=owner($select=id,password)"));
    expect(explicit.owner).toMatchObject({ id: 1 });
    expect(explicit.owner).not.toHaveProperty("password");

    const deep = t1(await c.query("?$with=owner($with=org)"));
    expect(deep.owner).not.toHaveProperty("password");
    expect(deep.owner.org).toMatchObject({ id: 1, name: "acme" });
    expect(deep.owner.org).not.toHaveProperty("apiToken");
  });

  it("seals on /pages and /one too", async () => {
    const c = await tasks();
    const pages = (await c.pages("?$with=owner")) as { data: Row[] };
    expect(pages.data[0]!.owner).not.toHaveProperty("password");
    const one = (await c.getOne("1", "?$with=owner($with=org)")) as Row;
    expect(one.owner).toMatchObject({ id: 1 });
    expect(one.owner).not.toHaveProperty("password");
    expect(one.owner.org).not.toHaveProperty("apiToken");
  });

  it("vetoes a write-only filter / sort inside $with like a top-level one", async () => {
    const c = await tasks();
    expect(errorsOf(await c.query("?$with=owner(password='pw-bob')"))).toEqual([
      {
        path: "owner.password",
        message: 'Filtering on field "owner.password" is not permitted — field is @db.writeOnly.',
      },
    ]);
    expect(errorsOf(await c.query("?$with=owner($sort=password)"))).toEqual([
      {
        path: "owner.password",
        message: 'Sorting on field "owner.password" is not permitted — field is @db.writeOnly.',
      },
    ]);
    expect(errorsOf(await c.query("?$with=owner($with=org(apiToken='tok-1'))"))?.[0]).toMatchObject(
      {
        path: "owner.org.apiToken",
      },
    );
    expect(await status(c.getOne("1", "?$with=owner(password='x')"))).toBe(400);
  });
});

/** The `Unknown relation` 400 body (see `unknownRelationError`). */
function unknownRelationBody(name: string, available: string) {
  return {
    statusCode: 400,
    message: `Unknown relation "${name}" in $with. Available relations: ${available}`,
    errors: [{ path: "$with", message: `Unknown relation "${name}"` }],
  };
}

describe("$with relation names are checked at every level (hasField on the full path)", () => {
  async function tasks(scoped = true) {
    const db = await space();
    const Ctrl = scoped ? ScopedController : AsDbController;
    return new Ctrl(makeApp(), db.getTable(SgTask) as any);
  }
  const unknown = unknownRelationBody;

  it("a nonexistent nested relation → the 400, listing the TARGET level's relations", async () => {
    const c = await tasks();
    const r = await c.query("?$with=owner($with=nope)");
    expect((r as HttpError).body).toMatchObject(unknown("nope", "org"));
  });

  it("a nested relation hasField hides (as `owner.org`) answers exactly like a nonexistent one", async () => {
    HIDDEN = new Set(["owner.org"]);
    const c = await tasks();
    const hidden = await c.query("?$with=owner($with=org)");
    expect((hidden as HttpError).body).toMatchObject(unknown("org", "(none)"));
    const missing = await c.query("?$with=owner($with=nope)");
    expect((missing as HttpError).body).toMatchObject(unknown("nope", "(none)"));
    // The parent relation itself stays loadable.
    expect(Array.isArray(await c.query("?$with=owner"))).toBe(true);
  });

  it("deeper levels: owner → org → (nothing)", async () => {
    const c = await tasks();
    const r = await c.query("?$with=owner($with=org($with=owner))");
    expect((r as HttpError).body).toMatchObject(unknown("owner", "(none)"));
  });

  it("dotted names check every segment the same way", async () => {
    HIDDEN = new Set(["owner.org"]);
    const c = await tasks();
    expect(((await c.query("?$with=owner.org")) as HttpError).body).toMatchObject(
      unknown("owner.org", "(none)"),
    );
    expect(((await c.query("?$with=owner.nope")) as HttpError).body).toMatchObject(
      unknown("owner.nope", "(none)"),
    );
    expect(((await c.query("?$with=title.x")) as HttpError).body).toMatchObject(
      unknown("title.x", "owner"),
    );
  });

  it("the same check on /pages and /one", async () => {
    HIDDEN = new Set(["owner.org"]);
    const c = await tasks();
    for (const r of [
      await c.pages("?$with=owner($with=org)"),
      await c.getOne("1", "?$with=owner($with=org)"),
    ]) {
      expect((r as HttpError).body).toMatchObject(unknown("org", "(none)"));
    }
  });

  it("visible nested relations still load", async () => {
    const c = await tasks(false);
    const rows = (await c.query("?$with=owner($with=org)")) as Row[];
    expect(rows.find((r) => r.id === 1)!.owner.org).toMatchObject({ id: 1, name: "acme" });
  });

  it("unknownRelationError is the single source of the wording", () => {
    expect(unknownRelationError("x", ["a", "b"]).body).toMatchObject(unknown("x", "a, b"));
    expect(unknownRelationError("x", []).body).toMatchObject(unknown("x", "(none)"));
  });
});

// ── checkWrite plumbing ─────────────────────────────────────────────────────

describe("checkWrite → TWriteOptions.check", () => {
  it("is passed only when overridden, on every insert / replace / update form", async () => {
    const table = createMockReadable();
    const checks: TDbWriteCheckContext[] = [];
    class Ctrl extends AsDbController {
      protected override checkWrite(ctx: TDbWriteCheckContext) {
        checks.push(ctx);
      }
    }
    const c = new Ctrl(makeApp(), table);
    await c.insert({ id: 1 });
    await c.insert([{ id: 1 }, { id: 2 }]);
    await c.replace({ id: 1 });
    await c.replace([{ id: 1 }]);
    await c.update({ id: 1 });
    await c.update([{ id: 1 }]);
    for (const method of [
      "insertOne",
      "insertMany",
      "replaceOne",
      "bulkReplace",
      "updateOne",
      "bulkUpdate",
    ]) {
      const opts = table[method].mock.calls[0]![1];
      expect(typeof opts?.check, method).toBe("function");
    }
    const ctx = { action: "insert", filters: [], transactional: true, count: async () => 0 };
    await table.insertOne.mock.calls[0]![1].check(ctx);
    expect(checks).toEqual([ctx]);

    const plainTable = createMockReadable();
    await new AsDbController(makeApp(), plainTable).insert({ id: 1 });
    expect(plainTable.insertOne.mock.calls[0]).toHaveLength(1);
  });
});

describe("checkWrite end to end (memory adapter)", () => {
  it("sees the written rows' PK filters and rejects with the thrown error", async () => {
    const db = await space();
    const table = db.getTable(SgTask);
    const seen: Array<{ action: string; filters: unknown; transactional: boolean }> = [];
    class Ctrl extends AsDbController {
      protected override async checkWrite(ctx: TDbWriteCheckContext) {
        seen.push({ action: ctx.action, filters: ctx.filters, transactional: ctx.transactional });
        const bad = await ctx.count({ $and: [{ $or: [...ctx.filters] }, { title: "bad" }] });
        if (bad > 0) throw new HttpError(403, "WITH CHECK");
      }
    }
    const c = new Ctrl(makeApp(), table as any);
    await c.insert({ id: 5, title: "ok" });
    await c.update({ id: 5, title: "still ok" });
    expect(seen.map((s) => [s.action, s.filters])).toEqual([
      ["insert", [{ id: 5 }]],
      ["update", [{ id: 5 }]],
    ]);
    const err = (await c.update({ id: 5, title: "bad" }).catch((e: unknown) => e)) as HttpError;
    expect(err.body.statusCode).toBe(403);
    const row = (await table.findOne({ filter: { id: 5 }, controls: {} } as never)) as Row;
    // Rolled back when the adapter's transaction is real.
    expect(row.title).toBe(seen[2]!.transactional ? "still ok" : "bad");
  });
});

// ── PK-first 409 disambiguation ─────────────────────────────────────────────

describe("409 disambiguation resolves the row PK-first", () => {
  it("reports the version of the row whose PK the payload carries", async () => {
    const db = createAdapter();
    const table = db.getTable(SgSlug) as AtscriptDbTable;
    await db.getAdapter(SgSlug).ensureTable();
    // The foreign row's UNIQUE slug equals our row's PRIMARY KEY.
    await table.insertMany([
      { id: "zz-b", slug: "abc", title: "b" },
      { id: "abc", slug: "a-own", title: "a" },
    ] as never);
    for (const title of ["b1", "b2", "b3"]) {
      await table.updateOne({ id: "zz-b", title } as never);
    }
    const own = (await table.findOne({ filter: { id: "abc" }, controls: {} } as never)) as Row;
    const foreign = (await table.findOne({ filter: { id: "zz-b" }, controls: {} } as never)) as Row;
    expect(foreign.version).not.toBe(own.version);

    const c = new AsDbController(makeApp(), table as any);
    const err = (await c
      .update({ id: "abc", slug: "abc", version: 12345, title: "x" })
      .catch((e: unknown) => e)) as HttpError;
    expect(err.body.statusCode).toBe(409);
    expect((err.body as Row).currentVersion).toBe(own.version);
  });

  it("reads the row the write targeted (recordFilter) with the request's id options", async () => {
    HIDDEN = new Set(["slug"]);
    const table = createMockReadable({}, { fields: ["id", "slug", "version"] });
    table.versionColumn = "version";
    table.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    table.recordFilter = vi.fn(() => ({ id: "abc" }));
    table.findOne.mockResolvedValue({ id: "abc", version: 7 });
    const c = new ScopedController(makeApp(), table);
    const err = (await c.update({ id: "abc", slug: "s", version: 1 }).catch((e) => e)) as HttpError;
    expect((err.body as Row).currentVersion).toBe(7);
    const [id, opts] = table.recordFilter.mock.calls[0]!;
    expect(id).toMatchObject({ id: "abc", slug: "s" });
    expect(opts.isFieldVisible("slug")).toBe(false);
    expect(table.findOne.mock.calls[0]![0].filter).toEqual({ id: "abc" });
  });
});

// ── No existence oracle through PK-first resolution ────────────────────────

describe("/one and DELETE: an out-of-scope row never shadows an in-scope one", () => {
  class MineController extends AsDbController {
    protected override transformFilter(filter: any) {
      return Object.keys(filter).length > 0
        ? { $and: [filter, { title: "mine" }] }
        : { title: "mine" };
    }
  }
  const MINE = { id: "zz-b", slug: "abc", title: "mine" }; // in scope; its UNIQUE slug is "abc"
  const THEIRS = { id: "abc", slug: "a-own", title: "theirs" }; // out of scope; its PK is "abc"

  async function slugs(rows: Row[]) {
    const db = createAdapter();
    const table = db.getTable(SgSlug) as AtscriptDbTable;
    await db.getAdapter(SgSlug).ensureTable();
    await table.insertMany(rows as never);
    const ids = async () =>
      ((await table.findMany({ filter: {}, controls: {} } as never)) as Row[])
        .map((r) => String(r.id))
        .sort((a, b) => a.localeCompare(b));
    return { c: new MineController(makeApp(), table as any), ids };
  }
  const outcome = async (p: Promise<unknown>) =>
    p.then(
      (v) => ({ ok: v instanceof HttpError ? v.body.statusCode : ((v as Row).id ?? v) }),
      (e: HttpError) => ({ err: e.body.statusCode }),
    );

  it("GET /one answers the same whether or not the shadowing out-of-scope PK row exists", async () => {
    const shadowed = await slugs([MINE, THEIRS]);
    const alone = await slugs([MINE]);
    expect(await outcome(shadowed.c.getOne("abc", "?"))).toEqual({ ok: "zz-b" });
    expect(await outcome(alone.c.getOne("abc", "?"))).toEqual({ ok: "zz-b" });
    // The out-of-scope row itself answers like a missing one.
    expect(await outcome(shadowed.c.getOne("a-own", "?"))).toEqual({ ok: 404 });
    expect(await outcome(shadowed.c.getOne("nope", "?"))).toEqual({ ok: 404 });
    expect(await outcome(shadowed.c.getOneComposite({ slug: "a-own" }, "?slug=a-own"))).toEqual({
      ok: 404,
    });
  });

  it("DELETE answers (and deletes) the same whether or not the shadowing row exists", async () => {
    const shadowed = await slugs([MINE, THEIRS]);
    const alone = await slugs([MINE]);
    expect(await outcome(shadowed.c.remove("abc"))).toEqual(await outcome(alone.c.remove("abc")));
    expect(await shadowed.ids()).toEqual(["abc"]); // only the in-scope row went
    expect(await alone.ids()).toEqual([]);
  });

  it("DELETE of an out-of-scope row is a 404, like a missing one, and deletes nothing", async () => {
    const { c, ids } = await slugs([MINE, THEIRS]);
    expect(await outcome(c.remove("a-own"))).toEqual({ err: 404 });
    expect(await outcome(c.removeComposite({ id: "abc" }))).toEqual({ err: 404 });
    expect(await outcome(c.remove("nope"))).toEqual({ err: 404 });
    expect(await ids()).toEqual(["abc", "zz-b"]);
  });

  it("controllers without a row overlay pass no scope", async () => {
    const table = createMockReadable();
    await new AsDbController(makeApp(), table).remove("1");
    expect(table.deleteOne.mock.calls[0]).toHaveLength(1);
  });
});

// ── requiredFields widening ─────────────────────────────────────────────────

describe("$actions requiredFields widening respects hasField", () => {
  it("never widens with a hidden field", async () => {
    HIDDEN = new Set(["secretNote"]);
    const db = await space();
    const c = new ScopedController(makeApp(), db.getTable(SgAccount) as any);
    const envelopes = [{ info: { name: "a" }, raw: { requiredFields: ["note", "secretNote"] } }];
    expect((c as any)._widenSelectForActions(envelopes, ["id"])).toEqual(["id", "note"]);
  });

  it("never widens with a derived field over a hidden source", async () => {
    HIDDEN = new Set(["settings"]);
    const db = await space();
    const c = new ScopedController(makeApp(), db.getTable(SgAccount) as any);
    const envelopes = [{ info: { name: "a" }, raw: { requiredFields: ["note", "apiKeyCopy"] } }];
    expect((c as any)._widenSelectForActions(envelopes, ["id"])).toEqual(["id", "note"]);
  });
});

// ── authorizeForm ───────────────────────────────────────────────────────────

describe("metaForm → authorizeForm", () => {
  function formController(allow: (name: string, actions: readonly string[]) => boolean) {
    const seen: Array<[string, readonly string[]]> = [];
    class Ctrl extends AsReadableController {
      protected hasField(): boolean {
        return true;
      }
      protected override async authorizeForm(name: string, actions: readonly string[]) {
        seen.push([name, actions]);
        return allow(name, actions);
      }
    }
    const ctx = makeActionApp();
    ctx.setOverview([
      fakeOverview(Ctrl, [
        {
          method: "approve",
          httpMethod: "POST",
          path: "/x/actions/approve",
          action: { name: "approve", opts: { label: "Approve" } },
          paramMates: [idMate(), inputFormMate(CommentForm)],
        },
      ]),
    ]);
    const bound = {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    } as any;
    return { ctrl: new Ctrl(bound, "test", ctx.app), seen };
  }

  it("receives the form's actions; false answers like an unknown form", async () => {
    const denied = formController(() => false);
    const refused = await denied.ctrl.metaForm("CommentForm").catch((e: unknown) => e);
    const unknown = await denied.ctrl.metaForm("Nope").catch((e: unknown) => e);
    expect(denied.seen).toEqual([["CommentForm", ["approve"]]]);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).body.statusCode).toBe(404);
    expect((refused as HttpError).body.message).toBe('Unknown form "CommentForm"');
    expect((unknown as HttpError).body.message).toBe('Unknown form "Nope"');

    const allowed = formController(() => true);
    expect(await allowed.ctrl.metaForm("CommentForm")).toBeDefined();
  });
});
