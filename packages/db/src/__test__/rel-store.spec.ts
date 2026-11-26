import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { ValidatorError } from "@atscript/typescript/utils";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { DbError } from "../db-error";
import dbPlugin from "../plugin";
import { isResolvedRelationFilter } from "../query/relation-filter";
import { DbSpace } from "../table/db-space";
import { buildValidationContext, isNavRelation } from "../validator";
import { InReadMockAdapter, MockAdapter, prepareFixtures } from "./test-utils";

/**
 * `@db.rel.store` (since 0.1.196): a navigation without foreign keys,
 * correlated by the store — valid only on a table whose adapter reads
 * relations in-read, loaded with `$with`, never written.
 */

let RsShelf: any;
let RsBook: any;

type TRow = Record<string, unknown>;

const LINKS: Record<string, (parent: TRow, child: TRow) => boolean> = {
  "rs_shelves.books": (s, b) => b.shelfId === s.id,
  "rs_shelves.featured": (s, b) => b.shelfId === s.id && (b.title as string).startsWith("A"),
  "rs_shelves.curator": (s, p) => p.id === (s.id as number) * 100,
  "rs_books.shelf": (b, s) => s.id === b.shelfId,
  "rs_books.notes": (b, n) => Math.floor((n.id as number) / 10) === b.id,
};

let store: Map<string, TRow[]>;

function space(Adapter: typeof MockAdapter = InReadMockAdapter): DbSpace {
  return new DbSpace(() => {
    const adapter = new (Adapter as typeof InReadMockAdapter)(LINKS);
    adapter.store = store;
    return adapter;
  });
}

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "rel-store-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  return [...(await repo.diagnostics()).values()].flat().map((m) => m.message);
}

/** The errors a rejected write (or `validateRows`) reports: `[path, code]`. */
async function refused(run: () => Promise<unknown>): Promise<Array<[string, string | undefined]>> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ValidatorError);
  return (error as ValidatorError).errors.map((e) => [e.path, e.code]);
}

beforeAll(async () => {
  await prepareFixtures();
  ({ RsShelf, RsBook } = await import("./fixtures/rel-store.as"));
});

beforeEach(() => {
  store = new Map();
  store.set("rs_shelves", [{ id: 1, label: "Top" }]);
  store.set("rs_books", [
    { id: 1, title: "Atlas", shelfId: 1 },
    { id: 2, title: "Bible", shelfId: 1 },
  ]);
  store.set("rs_notes", [
    { id: 10, text: "first" },
    { id: 11, text: "" },
  ]);
  store.set("rs_people", [{ id: 100, name: "Kim" }]);
});

// ── Compile rules (K1) ──────────────────────────────────────────────────────

const TABLES = `
  @db.table 'k_people'
  export interface KPerson {
    @meta.id
    id: number
  }
  export interface KPlain {
    id: number
  }
`;

describe("K1: where @db.rel.store compiles", () => {
  it("the fixture compiles: to-one and to-many store navigations, with @db.rel.filter / .filterable", async () => {
    const messages = await diagnosticsFor(`${TABLES}
      @db.table 'k_teams'
      export interface KTeam {
        @meta.id
        id: number
        @db.rel.store
        @db.rel.filterable
        @db.rel.filter \`KPerson.id > 0\`
        members: KPerson[]
        @db.rel.store
        lead?: KPerson
      }
    `);
    expect(messages).toEqual([]);
  });

  it("only on a field of a @db.table interface", async () => {
    const messages = await diagnosticsFor(`${TABLES}
      export interface KForm {
        @db.rel.store
        lead?: KPerson
      }
    `);
    expect(messages).toContain("@db.rel.store is only valid on fields of a @db.table interface");
  });

  it("typed as a @db.table entity or an array of one, no union", async () => {
    const messages = await diagnosticsFor(`${TABLES}
      @db.table 'k_teams'
      export interface KTeam {
        @meta.id
        id: number
        @db.rel.store
        plain?: KPlain
        @db.rel.store
        name?: string
        @db.rel.store
        inline?: { a: number }
        @db.rel.store
        either?: KPerson | KPlain
      }
    `);
    expect(messages).toEqual(
      expect.arrayContaining([
        "@db.rel.store target 'KPlain' is not a @db.table entity",
        "@db.rel.store target 'string' is not a @db.table entity",
        "@db.rel.store requires a @db.table type or an array of one (e.g. User or Comment[])",
        "@db.rel.store does not support union types — use separate relations",
      ]),
    );
  });

  it("not with @db.rel.to / .from / .via or @db.rel.FK (F6 and V6 count it too)", async () => {
    const messages = await diagnosticsFor(`${TABLES}
      @db.table 'k_links'
      export interface KLink {
        @meta.id
        id: number
        @db.rel.FK
        teamId: KTeam.id
        @db.rel.FK
        personId: KPerson.id
      }
      @db.table 'k_teams'
      export interface KTeam {
        @meta.id
        id: number
        @db.rel.store
        @db.rel.FK
        ownerId: KPerson.id
        @db.rel.store
        @db.rel.via KLink
        people: KPerson[]
      }
    `);
    expect(messages).toEqual(
      expect.arrayContaining([
        "@db.rel.store cannot be combined with @db.rel.FK — it is a relation without foreign keys",
        "A field cannot be both a foreign key and a navigational property",
        "@db.rel.store cannot be combined with @db.rel.via — it is a relation without foreign keys",
        "@db.rel.via is self-sufficient — cannot be combined with @db.rel.to, @db.rel.from or @db.rel.store",
      ]),
    );
  });

  it("an inherited store relation is not one of another table's foreign keys (no warning)", async () => {
    const messages = await diagnosticsFor(`${TABLES}
      @db.table 'k_base'
      export interface KBase {
        @meta.id
        id: number
        @db.rel.store
        lead?: KPerson
      }
      @db.table 'k_child'
      export interface KChild extends KBase {
        note?: string
      }
    `);
    expect(messages).toEqual([]);
  });
});

// ── Run time ────────────────────────────────────────────────────────────────

describe("a navigation", () => {
  it("is a relation of direction 'store', a navigation field, never a column", () => {
    const shelves = space().getTable(RsShelf);
    expect(shelves.relations.get("featured")).toMatchObject({ direction: "store", isArray: true });
    expect(shelves.relations.get("curator")).toMatchObject({ direction: "store", isArray: false });
    expect(shelves.navFields.has("curator")).toBe(true);
    expect(shelves.columnDescriptors.map((fd) => fd.path)).toEqual(["id", "label"]);
    expect(isNavRelation(RsShelf.type.props.get("curator"))).toBe(true);
    expect(buildValidationContext(RsShelf).navFields.has("featured")).toBe(true);
  });

  it("table build: refused on an adapter that does not read relations in-read", async () => {
    const shelves = space(MockAdapter).getTable(RsShelf);
    await expect(shelves.findMany({ filter: {}, controls: {} })).rejects.toThrow(
      'Relation "featured" of "rs_shelves" has no foreign key; the MockAdapter adapter does not read relations in-read',
    );
  });
});

describe("reads: loaded with $with, correlated by the store", () => {
  it("to-many and to-one, nested", async () => {
    const shelves = space().getTable(RsShelf);
    const [shelf] = (await shelves.findMany({
      filter: {},
      controls: {
        $with: [
          { name: "featured", controls: { $with: [{ name: "notes" }] } },
          { name: "curator" },
        ],
      },
    })) as any[];
    expect(shelf.featured.map((b: any) => b.title)).toEqual(["Atlas"]);
    expect(shelf.featured[0].notes).toEqual([{ id: 10, text: "first" }]);
    expect(shelf.curator).toEqual({ id: 100, name: "Kim" });
    const [entries] = (shelves.getAdapter() as InReadMockAdapter).entries;
    expect(entries!.map((e) => [e.kind, e.nav, e.isArray])).toEqual([
      ["store", "featured", true],
      ["store", "curator", false],
    ]);
    // `@db.rel.filter` is part of a store relation's entry too
    expect(entries![0]!.query.controls.$with![0]!.query.filter).toEqual({ id: { $lt: 11 } });
  });
});

describe("relational predicates: the store member has no pairs", () => {
  class PredicateAdapter extends InReadMockAdapter {
    override supportsRelationFilters(): boolean {
      return true;
    }
  }

  it("resolves to kind 'store', correlated by nav, the inner filter translated", async () => {
    const shelves = space(PredicateAdapter).getTable(RsShelf);
    await shelves.findMany({ filter: { featured: { $some: { title: "Atlas" } } }, controls: {} });
    const call = (shelves.getAdapter() as InReadMockAdapter).calls.find(
      (c) => c.method === "findMany",
    )!;
    const node = call.args[0].filter.featured.$some;
    expect(isResolvedRelationFilter(node)).toBe(true);
    expect(node).toMatchObject({ kind: "store", nav: "featured", filter: { title: "Atlas" } });
    expect(node.target).toMatchObject({ name: "rs_books" });
    expect(node).not.toHaveProperty("pairs");
    expect(node.junction).toBeUndefined();
  });

  it("the gate is unchanged: refused without supportsRelationFilters", async () => {
    const shelves = space().getTable(RsShelf);
    const error = await shelves
      .findMany({ filter: { featured: { $some: { title: "Atlas" } } }, controls: {} })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((error as DbError).code).toBe("REL_FILTER_NOT_SUPPORTED");
  });
});

describe("writes: refused at the field's path, on every path", () => {
  const note = { id: 99, text: "x" };

  it("insert / replace / patch, null included", async () => {
    const shelves = space().getTable(RsShelf);
    expect(
      await refused(() =>
        shelves.insertOne({ id: 2, label: "New", featured: [{ id: 3, title: "A" }] }),
      ),
    ).toEqual([["featured", "NAV_STORE_WRITE"]]);
    expect(
      await refused(() => shelves.insertOne({ id: 2, label: "New", curator: null } as any)),
    ).toEqual([["curator", "NAV_STORE_WRITE"]]);
    expect(
      await refused(() => shelves.replaceOne({ id: 1, label: "Top", featured: [] } as any)),
    ).toEqual([["featured", "NAV_STORE_WRITE"]]);
    // a patch operator object is refused the same (no array-op handling)
    expect(
      await refused(() =>
        shelves.updateOne({ id: 1, featured: { $insert: [{ id: 3, title: "A" }] } } as any),
      ),
    ).toEqual([["featured", "NAV_STORE_WRITE"]]);
    // the message names the field
    const [error] = await shelves.validateRows([{ id: 2, label: "New", curator: null }]);
    expect(error).toMatchObject({
      index: 0,
      path: "curator",
      code: "NAV_STORE_WRITE",
      params: { field: "curator" },
      message: "Navigation property 'curator' is read from the store and cannot be written",
    });
    // nothing was written
    expect(store.get("rs_shelves")).toEqual([{ id: 1, label: "Top" }]);
  });

  it("validateRows agrees with the writes, in every mode", async () => {
    const shelves = space().getTable(RsShelf);
    for (const mode of ["insert", "replace", "patch"] as const) {
      const errors = await shelves.validateRows([{ id: 1, label: "Top", featured: [] }], mode);
      expect(errors.map((e) => [e.path, e.code])).toEqual([["featured", "NAV_STORE_WRITE"]]);
    }
    expect(await shelves.validateRows([{ id: 1, label: "Top" }])).toEqual([]);
  });

  it("depth 2: inside a nested from entry, and inside a nested to entry", async () => {
    const db = space();
    const shelves = db.getTable(RsShelf);
    expect(
      await refused(() =>
        shelves.insertOne({
          id: 2,
          label: "New",
          books: [{ id: 3, title: "Atlas", notes: [note] }],
        } as any),
      ),
    ).toEqual([["books.0.notes", "NAV_STORE_WRITE"]]);
    const books = db.getTable(RsBook);
    expect(
      await refused(() =>
        books.insertOne({
          id: 3,
          title: "Atlas",
          shelf: { id: 2, label: "New", curator: { id: 5, name: "Lee" } },
        } as any),
      ),
    ).toEqual([["shelf.curator", "NAV_STORE_WRITE"]]);
    expect(store.get("rs_books")).toHaveLength(2);
  });

  it("depth 2: inside a patch $update / $upsert of a from relation", async () => {
    const shelves = space().getTable(RsShelf);
    expect(
      await refused(() =>
        shelves.updateOne({ id: 1, books: { $update: [{ id: 1, notes: [note] }] } } as any),
      ),
    ).toEqual([["books.$update[0].notes", "NAV_STORE_WRITE"]]);
    expect(
      await refused(() =>
        shelves.updateOne({
          id: 1,
          books: { $upsert: [{ id: 3, title: "Atlas", notes: [] }] },
        } as any),
      ),
    ).toEqual([["books.0.notes", "NAV_STORE_WRITE"]]);
  });

  it("the depth-overflow check skips it: the store refusal answers first", async () => {
    const shelves = space().getTable(RsShelf);
    expect(
      await refused(() =>
        shelves.insertOne({ id: 2, label: "New", curator: { id: 5, name: "Lee" } } as any, {
          maxDepth: 0,
        }),
      ),
    ).toEqual([["curator", "NAV_STORE_WRITE"]]);
  });
});
