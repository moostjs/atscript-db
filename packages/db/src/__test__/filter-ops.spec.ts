import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { DbError } from "../db-error";
import { DbSpace } from "../table/db-space";
import type { TDbFieldMeta } from "../types";
import { prepareFixtures, MockAdapter } from "./test-utils";

/**
 * `filterOps(fd)` (since 0.1.196): the operators an adapter executes on a
 * field. The list only narrows what the field's type accepts, an empty list
 * refuses every filter (`$exists` included), the core's own reads pass the
 * same guard, and a key or foreign-key field without `$eq` / `$in` is
 * refused when the table is built.
 */

let AuthorType: any;
let PostType: any;
let CommentType: any;

type TLists = Record<string, readonly string[] | undefined>;

/** A mock adapter whose `filterOps` answers `lists[<table>.<path>]`. */
class ListedAdapter extends MockAdapter {
  constructor(private readonly lists: TLists) {
    super();
  }

  override filterOps(fd: TDbFieldMeta) {
    return this.lists[`${this._table.tableName}.${fd.path}`] as any;
  }
}

/** `$eq` / `$in` on every key and foreign key the fixtures declare. */
const KEYS: TLists = {
  "authors.id": ["$eq", "$in"],
  "posts.id": ["$eq", "$in"],
  "posts.authorId": ["$eq", "$in"],
  "comments.id": ["$eq", "$in"],
  "comments.postId": ["$eq", "$in"],
  "comments.authorId": ["$eq", "$in"],
};

let store: Map<string, Array<Record<string, unknown>>>;

function space(lists: TLists) {
  return new DbSpace(() => {
    const adapter = new ListedAdapter(lists);
    adapter.store = store;
    return adapter;
  });
}

function seed() {
  store.set("authors", [
    { id: 1, name: "Alice", createdAt: 1000 },
    { id: 2, name: "Bob", createdAt: 2000 },
  ]);
  store.set("posts", [
    { id: 10, title: "Post A", authorId: 1, status: "published", createdAt: 1000 },
    { id: 20, title: "Post B", authorId: 1, status: "draft", createdAt: 2000 },
  ]);
  store.set("comments", [{ id: 100, body: "Nice", postId: 10, createdAt: 1000 }]);
}

/** The rejection `run` throws: an `INVALID_QUERY` whose one entry is `FIELD_NOT_PERMITTED`. */
async function refusal(run: () => Promise<unknown>) {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe("INVALID_QUERY");
  const [entry] = (error as DbError).errors;
  expect(entry.code).toBe("FIELD_NOT_PERMITTED");
  return entry;
}

beforeAll(async () => {
  await prepareFixtures();
  AuthorType = (await import("./fixtures/rel-author.as")).Author;
  PostType = (await import("./fixtures/test-relations.as")).Post;
  CommentType = (await import("./fixtures/rel-comment.as")).Comment;
});

beforeEach(() => {
  store = new Map();
  seed();
});

describe("filterOps — the list narrows what a field accepts", () => {
  it("refuses an operator the list leaves out and names the accepted ones", async () => {
    const posts = space({ ...KEYS, "posts.title": ["$eq", "$in"] }).getTable(PostType);
    const entry = await refusal(() => posts.findMany({ filter: { title: { $regex: "A" } } }));
    expect(entry).toEqual({
      path: "title",
      message:
        'Cannot filter on "title" — the adapter does not accept $regex on this field (accepted operators: $eq, $in)',
      code: "FIELD_NOT_PERMITTED",
      params: { field: "title", op: "filter" },
    });
    // a bare value is `$eq`
    expect(await posts.findMany({ filter: { title: "Post A" } })).toHaveLength(1);
    expect(await posts.findMany({ filter: { title: { $in: ["Post A", "Post B"] } } })).toHaveLength(
      2,
    );
  });

  it("a RegExp is $regex — bare, or as the operand of $eq / $ne", async () => {
    const posts = space({ ...KEYS, "posts.title": ["$eq", "$ne", "$in"] }).getTable(PostType);
    for (const filter of [
      { title: /Post/ },
      { title: { $eq: /Post/ } },
      { title: { $ne: /Post/ } },
    ]) {
      const entry = await refusal(() => posts.findMany({ filter } as any));
      expect(entry.message).toContain("does not accept $regex");
    }
    expect(await posts.findMany({ filter: { title: { $eq: "Post A" } } })).toHaveLength(1);
  });

  it("every operator of an entry must be listed — inside $or / $not and mutation filters too", async () => {
    const posts = space({ ...KEYS, "posts.title": ["$eq", "$in"] }).getTable(PostType);
    const mixed = await refusal(() =>
      posts.findMany({ filter: { title: { $in: ["Post A"], $ne: "Post B" } } as any }),
    );
    expect(mixed.message).toContain("does not accept $ne");
    await refusal(() =>
      posts.findMany({ filter: { $or: [{ id: 10 }, { $not: { title: { $lt: "B" } } }] } as any }),
    );
    await refusal(() => posts.deleteMany({ title: { $regex: "A" } } as any));
    await refusal(() => posts.count({ filter: { title: { $gt: "A" } } }));
  });

  it("a sole $exists is refused when the list leaves it out", async () => {
    const posts = space({ ...KEYS, "posts.title": ["$eq"] }).getTable(PostType);
    const entry = await refusal(() => posts.findMany({ filter: { title: { $exists: true } } }));
    expect(entry.message).toBe(
      'Cannot filter on "title" — the adapter does not accept $exists on this field (accepted operators: $eq)',
    );
  });

  it("an empty list refuses every filter, $exists included", async () => {
    const posts = space({ ...KEYS, "posts.status": [] }).getTable(PostType);
    const value = await refusal(() => posts.findMany({ filter: { status: "draft" } }));
    expect(value.message).toBe(
      'Cannot filter on "status" — the adapter does not accept $eq on this field',
    );
    await refusal(() => posts.findMany({ filter: { status: { $exists: false } } }));
    // sort and select are not filters
    expect(
      await posts.findMany({ filter: {}, controls: { $sort: { status: 1 }, $select: ["status"] } }),
    ).toHaveLength(2);
  });

  it("no list: the type's rule alone decides", async () => {
    const posts = space(KEYS).getTable(PostType);
    await expect(posts.findMany({ filter: { title: { $exists: true } } })).resolves.toBeDefined();
    expect(await posts.findMany({ filter: { title: { $lt: "Post B" } } })).toHaveLength(1);
    expect(await posts.findMany({ filter: { status: { $in: ["draft"] } } })).toHaveLength(1);
  });
});

describe("filterOps — the core's own reads pass the guard", () => {
  // Every non-key field refuses every filter: only the keys are readable.
  const narrow: TLists = {
    ...KEYS,
    "authors.name": [],
    "posts.title": [],
    "posts.status": [],
    "comments.body": [],
  };

  it("relation loads (to, from, nested), foreign-key checks and cascades read by keys", async () => {
    const s = space(narrow);
    const authors = s.getTable(AuthorType);
    const posts = s.getTable(PostType);
    s.getTable(CommentType);

    const withAuthor = await posts.findMany({
      filter: { id: 10 },
      controls: { $with: [{ name: "author" }] },
    } as any);
    expect((withAuthor[0] as any).author).toMatchObject({ id: 1, name: "Alice" });

    const withPosts = await authors.findMany({
      filter: { id: 1 },
      controls: { $with: [{ name: "posts", controls: { $with: [{ name: "comments" }] } }] },
    } as any);
    expect((withPosts[0] as any).posts).toHaveLength(2);
    expect((withPosts[0] as any).posts.find((p: any) => p.id === 10).comments).toHaveLength(1);

    // foreign-key validation reads the target by its key
    await expect(posts.insertOne({ title: "New", authorId: 2 } as any)).resolves.toBeDefined();
    await expect(posts.insertOne({ title: "Bad", authorId: 999 } as any)).rejects.toThrow(
      "References a non-existent record",
    );

    // cascades read the children by their foreign key
    await posts.deleteOne(10);
    expect(store.get("comments")).toEqual([]);
  });

  it("a relation read is guarded too: a $with sub-filter on a field with an empty list is refused", async () => {
    const s = space(narrow);
    const authors = s.getTable(AuthorType);
    s.getTable(PostType);
    const entry = await refusal(() =>
      authors.findMany({
        filter: { id: 1 },
        controls: { $with: [{ name: "posts", filter: { title: "Post A" } }] },
      } as any),
    );
    expect(entry).toMatchObject({ path: "title", code: "FIELD_NOT_PERMITTED" });
  });
});

describe("filterOps — a key or foreign-key field needs $eq and $in (table build)", () => {
  it("refuses a primary key whose list lacks $in, on every use", async () => {
    const posts = space({ ...KEYS, "posts.id": ["$eq"] }).getTable(PostType);
    const message =
      'Table "posts": filterOps of key field "id" must include $eq and $in — the core reads primary-key and foreign-key fields with them';
    await expect(posts.findMany({ filter: {} })).rejects.toThrow(message);
    await expect(posts.findMany({ filter: {} })).rejects.toThrow(message);
    expect(() => posts.fieldDescriptors).toThrow(message);
  });

  it("refuses a foreign key whose list lacks $eq", async () => {
    const posts = space({ ...KEYS, "posts.authorId": ["$in"] }).getTable(PostType);
    await expect(posts.count({ filter: {} })).rejects.toThrow(
      'filterOps of key field "authorId" must include $eq and $in',
    );
  });

  it("a key list may hold more; a non-key field may hold any list", async () => {
    const posts = space({
      ...KEYS,
      "posts.id": ["$eq", "$in", "$gt"],
      "posts.title": [],
    }).getTable(PostType);
    expect(await posts.findMany({ filter: { id: { $in: [10] } } })).toHaveLength(1);
  });
});
