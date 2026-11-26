import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { DbError } from "../db-error";
import { AtscriptDbTable } from "../table/db-table";
import { DbSpace } from "../table/db-space";
import type { TResolvedWith } from "../types";
import { InReadMockAdapter, MockAdapter, prepareFixtures } from "./test-utils";

/**
 * Relations read inside the root read (since 0.1.196): an adapter whose
 * `supportsWithInRead()` is true receives the `$with` tree as resolved entries
 * (`query.controls.$with`, built from the same plan the generic loader uses)
 * and returns the related rows in its rows; the core converts them through
 * each related table and refuses what such an adapter cannot do.
 */

let WrAuthor: any;
let WrBook: any;
let WrChapter: any;
let WrTagged: any;
let WrReview: any;

type TRow = Record<string, unknown>;

const LINKS: Record<string, (parent: TRow, child: TRow) => boolean> = {
  "wr_authors.books": (a, b) => b.authorId === a.id,
  "wr_books.author": (b, a) => a.id === b.authorId,
  "wr_books.chapters": (b, c) => c.bookId === b.id,
  "wr_chapters.book": (c, b) => b.id === c.bookId,
};

let store: Map<string, TRow[]>;
let space: DbSpace;

function inReadSpace(Adapter: typeof InReadMockAdapter = InReadMockAdapter): DbSpace {
  return new DbSpace(() => {
    const adapter = new Adapter(LINKS);
    adapter.store = store;
    return adapter;
  });
}

/** Every entry list the adapter behind `table` received. */
function received(table: AtscriptDbTable<any>): TResolvedWith[][] {
  return (table.getAdapter() as InReadMockAdapter).entries;
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

beforeAll(async () => {
  await prepareFixtures();
  ({ WrAuthor, WrBook, WrChapter, WrTagged, WrReview } =
    await import("./fixtures/with-in-read.as"));
});

beforeEach(() => {
  store = new Map();
  store.set("wr_authors", [
    { id: 1, name: "Ann" },
    { id: 2, name: "Ben" },
  ]);
  store.set("wr_books", [
    { id: 10, title: "Alpha", status: "published", in_print: 1, authorId: 1 },
    { id: 20, title: "Beta", status: "draft", in_print: 0, authorId: 1 },
    { id: 30, title: "Gamma", status: "published", in_print: 0, authorId: 2 },
  ]);
  store.set("wr_chapters", [
    { id: 100, title: "One", pages: 12, bookId: 10 },
    { id: 101, title: "Two", pages: 40, bookId: 10 },
    { id: 300, title: "Only", pages: 8, bookId: 30 },
  ]);
  space = inReadSpace();
});

describe("reads with the relations inside", () => {
  it("to-one: the related row under the navigation name, values converted", async () => {
    const chapters = space.getTable(WrChapter);
    const rows = await chapters.findMany({
      filter: { id: 100 },
      controls: { $with: [{ name: "book" }] },
    });
    // `in_print: 1` is the book's physical name and stored value
    expect(rows).toEqual([
      {
        id: 100,
        title: "One",
        pages: 12,
        bookId: 10,
        book: { id: 10, title: "Alpha", status: "published", inPrint: true, authorId: 1 },
      },
    ]);
    const [entry] = received(chapters)[0]!;
    expect(entry).toMatchObject({ kind: "to", nav: "book", isArray: false });
    expect(entry!.target).toMatchObject({ table: "wr_books", name: "wr_books" });
    // the adapter correlates by navigation name: no join keys, no paging
    expect(entry).not.toHaveProperty("pairs");
    expect(entry!.query.controls).not.toHaveProperty("$limit");
  });

  it("to-many: an array per row, [] when there is none", async () => {
    const books = space.getTable(WrBook);
    const rows = (await books.findMany({
      filter: {},
      controls: { $with: [{ name: "chapters" }], $sort: { id: 1 } },
    })) as any[];
    expect(rows.map((b) => b.chapters.map((c: any) => c.id))).toEqual([[100, 101], [], [300]]);
    expect(received(books)[0]![0]).toMatchObject({ kind: "from", nav: "chapters", isArray: true });
  });

  it("nested: the whole tree is planned with the root read and converted at every depth", async () => {
    const authors = space.getTable(WrAuthor);
    const rows = (await authors.findMany({
      filter: { id: 1 },
      controls: {
        $with: [{ name: "books", controls: { $with: [{ name: "chapters" }, { name: "author" }] } }],
      },
    })) as any[];
    expect(rows[0].books).toHaveLength(1);
    expect(rows[0].books[0].inPrint).toBe(true);
    expect(rows[0].books[0].chapters.map((c: any) => c.title)).toEqual(["One", "Two"]);
    expect(rows[0].books[0].author).toEqual({ id: 1, name: "Ann" });
    // one adapter read: the nested entries ride in the entry's controls
    const [root] = received(authors);
    const nested = root![0]!.query.controls.$with!;
    expect(nested.map((e) => [e.kind, e.nav])).toEqual([
      ["from", "chapters"],
      ["to", "author"],
    ]);
    expect(nested[0]!.target.name).toBe("wr_chapters");
  });

  it("nested: one related row object shared by several parents is read for each", async () => {
    // the adapter hands both chapters the same book object, author inside
    const chapters = space.getTable(WrChapter);
    const rows = (await chapters.findMany({
      filter: { bookId: 10 },
      controls: { $with: [{ name: "book", controls: { $with: [{ name: "author" }] } }] },
    })) as any[];
    expect(rows.map((r) => [r.title, r.book.title, r.book.author])).toEqual([
      ["One", "Alpha", { id: 1, name: "Ann" }],
      ["Two", "Alpha", { id: 1, name: "Ann" }],
    ]);
  });

  it("dotted names nest like a nested $with", async () => {
    const authors = space.getTable(WrAuthor);
    const rows = (await authors.findMany({
      filter: { id: 1 },
      controls: { $with: [{ name: "books.chapters" }] },
    })) as any[];
    expect(rows[0].books[0].chapters).toHaveLength(2);
  });

  it("an entry's filter, $sort and $select reach the adapter translated", async () => {
    const books = space.getTable(WrBook);
    const rows = (await books.findMany({
      filter: { id: 10 },
      controls: {
        $with: [
          {
            name: "chapters",
            filter: { pages: { $lt: 20 } },
            controls: { $select: ["title"], $sort: { title: -1 } },
          },
        ],
      },
    })) as any[];
    expect(rows[0].chapters).toEqual([{ title: "One" }]);
    const [entry] = received(books)[0]!;
    expect(entry!.query.filter).toEqual({ pages: { $lt: 20 } });
    expect(entry!.query.controls.$select?.asArray).toEqual(["title"]);
    expect(entry!.query.controls.$sort).toEqual({ title: -1, id: -1 });
  });

  it("the relation's @db.rel.filter is part of the entry's filter", async () => {
    const authors = space.getTable(WrAuthor);
    const rows = (await authors.findMany({
      filter: { id: 1 },
      controls: { $with: [{ name: "books", filter: { title: { $in: ["Alpha", "Beta"] } } }] },
    })) as any[];
    expect(rows[0].books.map((b: any) => b.title)).toEqual(["Alpha"]);
    expect(received(authors)[0]![0]!.query.filter).toEqual({
      $and: [{ status: { $eq: "published" } }, { title: { $in: ["Alpha", "Beta"] } }],
    });
  });

  it("a server-conjoined filter and a restricted $select reach the entry query (authorization contract)", async () => {
    const books = space.getTable(WrBook);
    // what a controller's `validateControls` does to a client entry: conjoin
    // the related table's row scope, narrow the selected fields
    const client = { title: { $in: ["One", "Two"] } };
    const scope = { pages: { $lt: 30 } };
    const rows = (await books.findMany({
      filter: { id: 10 },
      controls: {
        $with: [
          { name: "chapters", filter: { $and: [scope, client] }, controls: { $select: ["id"] } },
        ],
      },
    })) as any[];
    expect(rows[0].chapters).toEqual([{ id: 100 }]);
    const [entry] = received(books)[0]!;
    expect(entry!.query.filter).toEqual({ $and: [scope, client] });
    expect(entry!.query.controls.$select?.asArray).toEqual(["id"]);
  });

  it("the root $select is not widened by join keys", async () => {
    const books = space.getTable(WrBook);
    const rows = (await books.findMany({
      filter: { id: 30 },
      controls: {
        $select: ["title"],
        $with: [{ name: "chapters", controls: { $select: ["id"] } }],
      },
    })) as any[];
    expect(rows).toEqual([{ title: "Gamma", chapters: [{ id: 300 }] }]);
    const root = (books.getAdapter() as InReadMockAdapter).calls.find(
      (c) => c.method === "findMany",
    )!;
    expect(root.args[0].controls.$select.asArray).toEqual(["title"]);
  });

  it("findOne and findManyWithCount carry the entries too", async () => {
    const books = space.getTable(WrBook);
    const one = (await books.findOne({
      filter: { id: 30 },
      controls: { $with: [{ name: "author" }] },
    })) as any;
    expect(one.author).toEqual({ id: 2, name: "Ben" });
    const page = await books.findManyWithCount({
      filter: { authorId: 1 },
      controls: { $with: [{ name: "chapters" }] },
    });
    expect(page.count).toBe(2);
    expect((page.data as any[]).map((b) => b.chapters.length)).toEqual([2, 0]);
  });

  it("an in-repo style adapter does not read relations in-read (default)", () => {
    expect(new MockAdapter().supportsWithInRead()).toBe(false);
  });
});

describe("refusals", () => {
  it("$skip / $limit inside $with: NOT_SUPPORTED at depth 1", async () => {
    const books = space.getTable(WrBook);
    for (const controls of [{ $limit: 1 }, { $skip: 1 }]) {
      const error = await failure(() =>
        books.findMany({ filter: {}, controls: { $with: [{ name: "chapters", controls }] } }),
      );
      expect((error as DbError).code).toBe("NOT_SUPPORTED");
      expect((error as DbError).errors[0]).toMatchObject({ path: "$with" });
      expect(error.message).toContain('Relation "chapters"');
    }
    // nothing was read
    expect(received(books)).toEqual([]);
  });

  it("$skip / $limit inside $with: NOT_SUPPORTED at depth 2, flat (URL) shape included", async () => {
    const authors = space.getTable(WrAuthor);
    const error = await failure(() =>
      authors.findMany({
        filter: {},
        controls: {
          $with: [{ name: "books", controls: { $with: [{ name: "chapters", $limit: 2 } as any] } }],
        },
      }),
    );
    expect((error as DbError).code).toBe("NOT_SUPPORTED");
    expect(error.message).toContain('Relation "books.chapters"');
  });

  it("a row without a requested relation is an adapter defect", async () => {
    const books = space.getTable(WrBook);
    (books.getAdapter() as InReadMockAdapter).omit.add("chapters");
    const error = await failure(() =>
      books.findMany({ filter: {}, controls: { $with: [{ name: "chapters" }] } }),
    );
    expect(error).not.toBeInstanceOf(DbError);
    expect(error.message).toBe('InReadMockAdapter returned a row without relation "chapters"');
  });

  it("an unknown relation is UNKNOWN_RELATION", async () => {
    const books = space.getTable(WrBook);
    const error = await failure(() =>
      books.findMany({ filter: {}, controls: { $with: [{ name: "reviews" }] } }),
    );
    expect((error as DbError).errors[0]).toMatchObject({ code: "UNKNOWN_RELATION" });
  });

  it("a target on another store: NOT_SUPPORTED", async () => {
    class OtherStoreAdapter extends InReadMockAdapter {}
    const other = new AtscriptDbTable(WrChapter, new OtherStoreAdapter(LINKS));
    const books = new AtscriptDbTable(
      WrBook,
      new InReadMockAdapter(LINKS),
      undefined,
      (() => other) as any,
    );
    const error = await failure(() =>
      books.findMany({ filter: {}, controls: { $with: [{ name: "chapters" }] } }),
    );
    expect((error as DbError).code).toBe("NOT_SUPPORTED");
    expect(error.message).toContain("different database or adapter");
  });

  it("an unresolved target and a missing resolver are configuration faults", async () => {
    const unresolved = new AtscriptDbTable(
      WrBook,
      new InReadMockAdapter(LINKS),
      undefined,
      () => undefined,
    );
    const a = await failure(() =>
      unresolved.findMany({ filter: {}, controls: { $with: [{ name: "chapters" }] } }),
    );
    expect(a).not.toBeInstanceOf(DbError);
    expect(a.message).toContain('Relation "chapters" of "wr_books": the table resolver returned');
    const unwired = new AtscriptDbTable(WrBook, new InReadMockAdapter(LINKS));
    const b = await failure(() =>
      unwired.findMany({ filter: {}, controls: { $with: [{ name: "chapters" }] } }),
    );
    expect(b.message).toContain('Table "wr_books" has no table resolver');
  });

  it("table build: both relation capabilities", async () => {
    class BothAdapter extends InReadMockAdapter {
      override supportsNativeRelations(): boolean {
        return true;
      }
    }
    const books = inReadSpace(BothAdapter).getTable(WrBook);
    const error = await failure(() => books.findMany({ filter: {}, controls: {} }));
    expect(error.message).toContain("both supportsNativeRelations() and supportsWithInRead()");
  });

  it("table build: a @db.rel.via relation", async () => {
    const tagged = space.getTable(WrTagged);
    const error = await failure(() => tagged.findMany({ filter: {}, controls: {} }));
    expect(error.message).toBe(
      'Relation "tags" of "wr_tagged" is a @db.rel.via relation; the InReadMockAdapter adapter reads relations in-read, where a junction table is not read',
    );
  });

  it("table build: a navigation named like a stored column", async () => {
    const reviews = space.getTable(WrReview);
    const error = await failure(() => reviews.findMany({ filter: {}, controls: {} }));
    expect(error.message).toContain(
      'Navigation "book" of "wr_reviews" has the name of a stored column',
    );
  });

  it("loadRelations() refuses: NOT_SUPPORTED", async () => {
    const books = space.getTable(WrBook);
    const error = await failure(() => books.loadRelations([{ id: 10 }], [{ name: "chapters" }]));
    expect((error as DbError).code).toBe("NOT_SUPPORTED");
    expect(error.message).toContain("request them with $with");
  });
});
