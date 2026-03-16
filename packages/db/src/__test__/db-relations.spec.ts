import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import type { FilterExpr } from "@uniqu/core";

import { AtscriptDbTable } from "../table/db-table";
import { DbSpace } from "../table/db-space";
import { BaseDbAdapter } from "../base-adapter";
import { prepareFixtures } from "./test-utils";
import type {
  DbQuery,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "../types";

let Author: any;
let Post: any;
let Comment: any;

// ── Mock adapter that stores data in memory ──────────────────────────────

class InMemoryAdapter extends BaseDbAdapter {
  private _store: Array<Record<string, unknown>> = [];
  private _nextId = 1;

  seed(rows: Array<Record<string, unknown>>): void {
    for (const row of rows) {
      this._store.push({ ...row });
      const id = row.id as number;
      if (id >= this._nextId) {
        this._nextId = id + 1;
      }
    }
  }

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    const id = data.id ?? this._nextId++;
    const row = { ...data, id };
    this._store.push(row);
    return { insertedId: id as number };
  }

  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    const ids: number[] = [];
    for (const item of data) {
      const result = await this.insertOne(item);
      ids.push(result.insertedId as number);
    }
    return { insertedCount: ids.length, insertedIds: ids };
  }

  async replaceOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    const idx = this._store.findIndex((row) =>
      this._matchFilter(row, filter as Record<string, unknown>),
    );
    if (idx === -1) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    this._store[idx] = { ...data };
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    const idx = this._store.findIndex((row) =>
      this._matchFilter(row, filter as Record<string, unknown>),
    );
    if (idx === -1) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    Object.assign(this._store[idx], data);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(_filter: FilterExpr): Promise<TDbDeleteResult> {
    return { deletedCount: 0 };
  }

  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    const results = await this.findMany(query);
    return results[0] ?? null;
  }

  private _matchFilter(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    if ("$and" in filter) {
      return (filter.$and as Array<Record<string, unknown>>).every((f) =>
        this._matchFilter(row, f),
      );
    }
    if ("$or" in filter) {
      return (filter.$or as Array<Record<string, unknown>>).some((f) => this._matchFilter(row, f));
    }
    return Object.entries(filter).every(([key, condition]) => {
      if (typeof condition === "object" && condition !== null) {
        const ops = condition as Record<string, unknown>;
        if ("$in" in ops) {
          return (ops.$in as unknown[]).includes(row[key]);
        }
        if ("$regex" in ops) {
          return new RegExp(ops.$regex as string).test(String((row[key] ?? "") as string | number));
        }
      }
      return row[key] === condition;
    });
  }

  async findMany(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    let results = [...this._store];

    if (query.filter && Object.keys(query.filter).length > 0) {
      results = results.filter((row) =>
        this._matchFilter(row, query.filter as Record<string, unknown>),
      );
    }

    const controls = query.controls || {};
    if (controls.$limit) {
      results = results.slice(0, controls.$limit as number);
    }

    return results;
  }

  async count(query: DbQuery): Promise<number> {
    return (await this.findMany(query)).length;
  }

  async updateMany(_filter: FilterExpr, _data: Record<string, unknown>): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async replaceMany(_filter: FilterExpr, _data: Record<string, unknown>): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    const before = this._store.length;
    this._store = this._store.filter(
      (row) => !this._matchFilter(row, filter as Record<string, unknown>),
    );
    return { deletedCount: before - this._store.length };
  }

  async syncIndexes(): Promise<void> {}
  async ensureTable(): Promise<void> {}
}

// Helper to build WithRelation objects (Uniquery & { name })
function withRel(name: string, opts?: { filter?: any; controls?: any }): any {
  return { name, filter: opts?.filter ?? {}, controls: opts?.controls ?? {} };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("AtscriptDbTable — Relations", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const author = await import("./fixtures/rel-author.as");
    const post = await import("./fixtures/test-relations.as");
    const comment = await import("./fixtures/rel-comment.as");
    Author = author.Author;
    Post = post.Post;
    Comment = comment.Comment;
  });

  // ── Nav field filtering ────────────────────────────────────────────────

  describe("nav field filtering", () => {
    let table: AtscriptDbTable;

    beforeEach(() => {
      table = new AtscriptDbTable(Author, new InMemoryAdapter());
    });

    it("should identify nav fields from @db.rel.from", () => {
      expect(table.navFields.has("posts")).toBe(true);
    });

    it("should add nav fields to ignored fields", () => {
      expect(table.ignoredFields.has("posts")).toBe(true);
    });

    it("should NOT register defaults for fields nested under nav fields", () => {
      for (const key of table.defaults.keys()) {
        expect(key.startsWith("posts.")).toBe(false);
      }
    });

    it("should NOT register primary keys from nav field descendants", () => {
      for (const pk of table.primaryKeys) {
        expect(pk.startsWith("posts.")).toBe(false);
      }
    });

    it("should only have own defaults (id, createdAt)", () => {
      const defaultKeys = [...table.defaults.keys()];
      expect(defaultKeys).toContain("id");
      expect(defaultKeys).toContain("createdAt");
      expect(defaultKeys).toHaveLength(2);
    });

    it("should not include nav descendant defaults on Post table", () => {
      const postTable = new AtscriptDbTable(Post, new InMemoryAdapter());
      for (const key of postTable.defaults.keys()) {
        expect(key.startsWith("comments.")).toBe(false);
        expect(key.startsWith("author.")).toBe(false);
      }
      expect(postTable.defaults.has("id")).toBe(true);
      expect(postTable.defaults.has("status")).toBe(true);
      expect(postTable.defaults.has("createdAt")).toBe(true);
    });
  });

  // ── FK metadata ───────────────────────────────────────────────────────

  describe("FK metadata", () => {
    it("should extract FK from @db.rel.FK on Post.authorId", () => {
      const postTable = new AtscriptDbTable(Post, new InMemoryAdapter());
      const fks = [...postTable.foreignKeys.values()];
      const authorFK = fks.find((fk) => fk.fields.includes("authorId"));
      expect(authorFK).toBeDefined();
      expect(authorFK!.targetTable).toBe("authors");
      expect(authorFK!.targetFields).toEqual(["id"]);
    });

    it("should extract onDelete from @db.rel.onDelete", () => {
      const postTable = new AtscriptDbTable(Post, new InMemoryAdapter());
      const fks = [...postTable.foreignKeys.values()];
      const authorFK = fks.find((fk) => fk.fields.includes("authorId"));
      expect(authorFK!.onDelete).toBe("cascade");
    });

    it("should extract FK on Comment.postId pointing to Post", () => {
      const commentTable = new AtscriptDbTable(Comment, new InMemoryAdapter());
      const fks = [...commentTable.foreignKeys.values()];
      const postFK = fks.find((fk) => fk.fields.includes("postId"));
      expect(postFK).toBeDefined();
      expect(postFK!.targetTable).toBe("posts");
      expect(postFK!.targetFields).toEqual(["id"]);
      expect(postFK!.onDelete).toBe("cascade");
    });
  });

  // ── Relation metadata ─────────────────────────────────────────────────

  describe("relation metadata", () => {
    it("should extract @db.rel.to relation on Post.author", () => {
      const postTable = new AtscriptDbTable(Post, new InMemoryAdapter());
      const rel = postTable.relations.get("author");
      expect(rel).toBeDefined();
      expect(rel!.direction).toBe("to");
      expect(rel!.isArray).toBe(false);
    });

    it("should extract @db.rel.from relation on Post.comments", () => {
      const postTable = new AtscriptDbTable(Post, new InMemoryAdapter());
      const rel = postTable.relations.get("comments");
      expect(rel).toBeDefined();
      expect(rel!.direction).toBe("from");
      expect(rel!.isArray).toBe(true);
    });

    it("should extract @db.rel.from relation on Author.posts", () => {
      const authorTable = new AtscriptDbTable(Author, new InMemoryAdapter());
      const rel = authorTable.relations.get("posts");
      expect(rel).toBeDefined();
      expect(rel!.direction).toBe("from");
      expect(rel!.isArray).toBe(true);
    });

    it("should extract @db.rel.to relation on Comment.post", () => {
      const commentTable = new AtscriptDbTable(Comment, new InMemoryAdapter());
      const rel = commentTable.relations.get("post");
      expect(rel).toBeDefined();
      expect(rel!.direction).toBe("to");
      expect(rel!.isArray).toBe(false);
    });

    it("should resolve targetType to the actual type class", () => {
      const postTable = new AtscriptDbTable(Post, new InMemoryAdapter());
      const authorRel = postTable.relations.get("author");
      const target = authorRel!.targetType();
      expect(target).toBe(Author);
    });

    it("should resolve array targetType to the element type class", () => {
      const postTable = new AtscriptDbTable(Post, new InMemoryAdapter());
      const commentsRel = postTable.relations.get("comments");
      const target = commentsRel!.targetType();
      expect(target).toBe(Comment);
    });
  });

  // ── $with relation loading ────────────────────────────────────────────

  describe("$with relation loading", () => {
    let db: DbSpace;

    function seedData() {
      const authorAdapter = (db.getTable(Author) as any).adapter as InMemoryAdapter;
      authorAdapter.seed([
        { id: 1, name: "Alice", createdAt: 1000 },
        { id: 2, name: "Bob", createdAt: 1001 },
      ]);

      const postAdapter = (db.getTable(Post) as any).adapter as InMemoryAdapter;
      postAdapter.seed([
        { id: 1, title: "First Post", status: "published", authorId: 1, createdAt: 2000 },
        { id: 2, title: "Second Post", status: "draft", authorId: 1, createdAt: 2001 },
        { id: 3, title: "Bobs Post", status: "published", authorId: 2, createdAt: 2002 },
      ]);

      const commentAdapter = (db.getTable(Comment) as any).adapter as InMemoryAdapter;
      commentAdapter.seed([
        { id: 1, body: "Nice post!", postId: 1, createdAt: 3000 },
        { id: 2, body: "Thanks!", postId: 1, createdAt: 3001 },
        { id: 3, body: "Interesting", postId: 3, createdAt: 3002 },
      ]);
    }

    beforeEach(() => {
      db = new DbSpace(() => new InMemoryAdapter());
      // Initialize all tables first, then seed
      db.getTable(Author);
      db.getTable(Post);
      db.getTable(Comment);
      seedData();
    });

    it("should load @db.rel.to relation (Post.author)", async () => {
      const postTable = db.getTable(Post);
      const results = (await postTable.findMany({
        filter: {},
        controls: { $with: [withRel("author")] },
      })) as any[];

      expect(results).toHaveLength(3);
      expect(results[0].author).toEqual({ id: 1, name: "Alice", createdAt: 1000 });
      expect(results[1].author).toEqual({ id: 1, name: "Alice", createdAt: 1000 });
      expect(results[2].author).toEqual({ id: 2, name: "Bob", createdAt: 1001 });
    });

    it("should load @db.rel.from relation (Post.comments)", async () => {
      const postTable = db.getTable(Post);
      const results = (await postTable.findMany({
        filter: { id: 1 },
        controls: { $with: [withRel("comments")] },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].comments).toHaveLength(2);
      expect(results[0].comments[0].body).toBe("Nice post!");
      expect(results[0].comments[1].body).toBe("Thanks!");
    });

    it("should load @db.rel.from relation (Author.posts)", async () => {
      const authorTable = db.getTable(Author);
      const results = (await authorTable.findMany({
        filter: { id: 1 },
        controls: { $with: [withRel("posts")] },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].posts).toHaveLength(2);
      expect(results[0].posts[0].title).toBe("First Post");
      expect(results[0].posts[1].title).toBe("Second Post");
    });

    it("should load @db.rel.to relation (Comment.post)", async () => {
      const commentTable = db.getTable(Comment);
      const results = (await commentTable.findMany({
        filter: {},
        controls: { $with: [withRel("post")] },
      })) as any[];

      expect(results).toHaveLength(3);
      expect(results[0].post.title).toBe("First Post");
      expect(results[2].post.title).toBe("Bobs Post");
    });

    it("should load multiple relations at once", async () => {
      const postTable = db.getTable(Post);
      const results = (await postTable.findMany({
        filter: {},
        controls: { $with: [withRel("author"), withRel("comments")] },
      })) as any[];

      expect(results).toHaveLength(3);
      expect(results[0].author.name).toBe("Alice");
      expect(results[0].comments).toHaveLength(2);
      expect(results[1].author.name).toBe("Alice");
      expect(results[1].comments).toHaveLength(0);
      expect(results[2].author.name).toBe("Bob");
      expect(results[2].comments).toHaveLength(1);
    });

    it("should return empty array for @db.rel.from with no matching records", async () => {
      const postTable = db.getTable(Post);
      const results = (await postTable.findMany({
        filter: { id: 2 },
        controls: { $with: [withRel("comments")] },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].comments).toEqual([]);
    });

    it("should assign null for @db.rel.to with null FK", async () => {
      // Insert a post with null authorId directly via adapter (skip validation)
      const postAdapter = (db.getTable(Post) as any).adapter as InMemoryAdapter;
      postAdapter.seed([
        { id: 99, title: "Orphan", status: "draft", authorId: null, createdAt: 9000 },
      ]);

      const postTable = db.getTable(Post);
      const results = (await postTable.findMany({
        filter: { id: 99 },
        controls: { $with: [withRel("author")] },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].author).toBeNull();
    });

    it("should throw for unknown relation names in $with", async () => {
      const postTable = db.getTable(Post);
      await expect(
        postTable.findMany({
          filter: {},
          controls: { $with: [withRel("nonexistent")] },
        }),
      ).rejects.toThrow('Unknown relation "nonexistent"');
    });

    it("should throw when $with references a non-nav field (e.g. FK field)", async () => {
      const postTable = db.getTable(Post);
      await expect(
        postTable.findMany({
          filter: {},
          controls: { $with: [withRel("authorId")] },
        }),
      ).rejects.toThrow('Unknown relation "authorId"');
    });

    it("should load nested $with (Post.comments via tasks($with=comments) syntax)", async () => {
      const authorTable = db.getTable(Author);
      const results = (await authorTable.findMany({
        filter: { id: 1 },
        controls: {
          $with: [withRel("posts", { controls: { $with: [withRel("comments")] } })],
        },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].posts).toHaveLength(2);
      // First post has 2 comments
      expect(results[0].posts[0].comments).toHaveLength(2);
      expect(results[0].posts[0].comments[0].body).toBe("Nice post!");
      expect(results[0].posts[0].comments[1].body).toBe("Thanks!");
      // Second post has 0 comments
      expect(results[0].posts[1].comments).toEqual([]);
    });

    it("should throw for invalid nested $with relation names", async () => {
      const authorTable = db.getTable(Author);
      await expect(
        authorTable.findMany({
          filter: {},
          controls: {
            $with: [withRel("posts", { controls: { $with: [withRel("bogus")] } })],
          },
        }),
      ).rejects.toThrow('Unknown relation "bogus"');
    });

    it("should forward $select to the correct nested relation level", async () => {
      const authorTable = db.getTable(Author);
      const results = (await authorTable.findMany({
        filter: { id: 1 },
        controls: {
          // $select=body should be on comments, not on posts
          $with: [
            withRel("posts", {
              controls: { $with: [withRel("comments", { controls: { $select: ["body"] } })] },
            }),
          ],
        },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].posts).toHaveLength(2);
      // First post has 2 comments — each should have been queried with $select=body
      expect(results[0].posts[0].comments).toHaveLength(2);
      expect(results[0].posts[0].comments[0].body).toBe("Nice post!");
    });

    it("should apply $select at the relation level it is specified on", async () => {
      const postTable = db.getTable(Post);
      const results = (await postTable.findMany({
        filter: { id: 1 },
        controls: {
          // $select on comments level (correct usage for selecting comment fields)
          $with: [withRel("comments", { controls: { $select: ["body"] } })],
        },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].comments).toHaveLength(2);
      expect(results[0].comments[0].body).toBe("Nice post!");
    });

    // ── 2-level deep nested controls + filters ────────────────────────

    it("should forward $limit to nested relation", async () => {
      const authorTable = db.getTable(Author);
      const results = (await authorTable.findMany({
        filter: { id: 1 },
        controls: {
          $with: [withRel("posts", { controls: { $limit: 1 } })],
        },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].posts).toHaveLength(1);
    });

    it("should apply filter on nested relation", async () => {
      const authorTable = db.getTable(Author);
      const results = (await authorTable.findMany({
        filter: { id: 1 },
        controls: {
          $with: [withRel("posts", { filter: { status: "published" } })],
        },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].posts).toHaveLength(1);
      expect(results[0].posts[0].title).toBe("First Post");
    });

    it("should apply filter + nested $with with filter (2 levels deep)", async () => {
      const authorTable = db.getTable(Author);
      const results = (await authorTable.findMany({
        filter: { id: 1 },
        controls: {
          $with: [
            withRel("posts", {
              filter: { status: "published" },
              controls: {
                $with: [withRel("comments", { filter: { body: { $regex: "Nice" } } })],
              },
            }),
          ],
        },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].posts).toHaveLength(1);
      expect(results[0].posts[0].comments).toHaveLength(1);
      expect(results[0].posts[0].comments[0].body).toBe("Nice post!");
    });

    it("should apply $select at each nested level", async () => {
      const authorTable = db.getTable(Author);
      const results = (await authorTable.findMany({
        filter: { id: 1 },
        controls: {
          $with: [
            withRel("posts", {
              controls: {
                $select: ["title"],
                $with: [withRel("comments", { controls: { $select: ["body"] } })],
              },
            }),
          ],
        },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].posts).toHaveLength(2);
      expect(results[0].posts[0].title).toBe("First Post");
      expect(results[0].posts[0].comments).toHaveLength(2);
      expect(results[0].posts[0].comments[0].body).toBe("Nice post!");
    });

    it("should apply $limit at 2nd level deep", async () => {
      const authorTable = db.getTable(Author);
      const results = (await authorTable.findMany({
        filter: { id: 1 },
        controls: {
          $with: [
            withRel("posts", {
              controls: {
                $with: [withRel("comments", { controls: { $limit: 1 } })],
              },
            }),
          ],
        },
      })) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].posts).toHaveLength(2);
      // First post: 2 comments but $limit=1
      expect(results[0].posts[0].comments).toHaveLength(1);
      expect(results[0].posts[0].comments[0].body).toBe("Nice post!");
    });

    it("should work without $with (no relation loading)", async () => {
      const postTable = db.getTable(Post);
      const results = (await postTable.findMany({ filter: {} })) as any[];

      expect(results).toHaveLength(3);
      expect(results[0]).not.toHaveProperty("author");
      expect(results[0]).not.toHaveProperty("comments");
    });
  });

  // ── Insert with nav fields ────────────────────────────────────────────

  describe("insert with nav fields", () => {
    it("should not apply defaults for nav field descendants", async () => {
      const adapter = new InMemoryAdapter();
      const table = new AtscriptDbTable(Author, adapter);
      await table.insertOne({ name: "Charlie" } as any);

      const stored = (await adapter.findMany({ filter: {}, controls: {} })) as any[];
      expect(stored).toHaveLength(1);
      const keys = Object.keys(stored[0]);
      for (const key of keys) {
        expect(key.includes(".")).toBe(false);
      }
    });

    it("should error when nav fields are present but cannot be processed", async () => {
      const adapter = new InMemoryAdapter();
      const table = new AtscriptDbTable(Author, adapter);
      await expect(
        table.insertOne({ name: "Charlie", posts: [{ title: "junk" }] } as any),
      ).rejects.toThrow(/exceeds maxDepth/);
    });

    it("should accept insert when nav fields are undefined", async () => {
      const adapter = new InMemoryAdapter();
      const table = new AtscriptDbTable(Author, adapter);
      await expect(table.insertOne({ name: "Charlie" } as any)).resolves.toBeDefined();
    });
  });

  // ── Batch nested creation ─────────────────────────────────────────────

  describe("batch nested creation (insertMany)", () => {
    let db: DbSpace;

    beforeEach(() => {
      db = new DbSpace(() => new InMemoryAdapter());
      db.getTable(Author);
      db.getTable(Post);
      db.getTable(Comment);
    });

    it("should batch-create TO dependencies across multiple items", async () => {
      const postTable = db.getTable(Post);
      const result = await postTable.insertMany([
        { title: "Post A", author: { name: "Alice" } },
        { title: "Post B", author: { name: "Bob" } },
        { title: "Post C", author: { name: "Carol" } },
      ] as any);

      expect(result.insertedCount).toBe(3);
      expect(result.insertedIds).toHaveLength(3);

      // Verify authors were created
      const authorTable = db.getTable(Author);
      const authors = (await authorTable.findMany({ filter: {}, controls: {} })) as any[];
      expect(authors).toHaveLength(3);

      // Verify FK wiring — load posts with author relation
      const posts = (await postTable.findMany({
        filter: {},
        controls: { $with: [{ name: "author", filter: {}, controls: {} }] },
      })) as any[];
      expect(posts[0].author).toBeDefined();
      expect((posts[0].author as any).name).toBe("Alice");
      expect((posts[1].author as any).name).toBe("Bob");
      expect((posts[2].author as any).name).toBe("Carol");
    });

    it("should batch-create FROM dependents across multiple items", async () => {
      const authorTable = db.getTable(Author);
      const result = await authorTable.insertMany([
        { name: "Alice", posts: [{ title: "P1" }, { title: "P2" }] },
        { name: "Bob", posts: [{ title: "P3" }] },
      ] as any);

      expect(result.insertedCount).toBe(2);

      // Verify posts were created with correct FKs
      const postTable = db.getTable(Post);
      const allPosts = (await postTable.findMany({ filter: {}, controls: {} })) as any[];
      expect(allPosts).toHaveLength(3);

      // Load authors with posts
      const authors = (await authorTable.findMany({
        filter: {},
        controls: { $with: [{ name: "posts", filter: {}, controls: {} }] },
      })) as any[];
      expect(
        (authors[0].posts as any[])
          .map((p: any) => p.title)
          .toSorted((a: string, b: string) => a.localeCompare(b)),
      ).toEqual(["P1", "P2"]);
      expect((authors[1].posts as any[]).map((p: any) => p.title)).toEqual(["P3"]);
    });

    it("should handle mixed items — some with nav data, some without", async () => {
      // Pre-create an author for the third post
      const authorTable = db.getTable(Author);
      await authorTable.insertOne({ name: "Pre-existing" } as any);

      const postTable = db.getTable(Post);
      const result = await postTable.insertMany([
        { title: "Post A", author: { name: "Alice" } },
        { title: "Post B", author: { name: "Bob" } },
        { title: "Post C", authorId: 1 }, // uses pre-existing author
      ] as any);

      expect(result.insertedCount).toBe(3);

      const posts = (await postTable.findMany({
        filter: {},
        controls: { $with: [{ name: "author", filter: {}, controls: {} }] },
      })) as any[];
      expect((posts[0].author as any).name).toBe("Alice");
      expect((posts[1].author as any).name).toBe("Bob");
      expect((posts[2].author as any).name).toBe("Pre-existing");
    });

    it("should handle deep nesting (3 levels) via insertMany", async () => {
      const authorTable = db.getTable(Author);
      await authorTable.insertMany([
        {
          name: "Alice",
          posts: [
            { title: "P1", comments: [{ body: "C1" }, { body: "C2" }] },
            { title: "P2", comments: [{ body: "C3" }] },
          ],
        },
        {
          name: "Bob",
          posts: [{ title: "P3", comments: [{ body: "C4" }, { body: "C5" }, { body: "C6" }] }],
        },
      ] as any);

      // Verify all levels were created
      const authors = (await authorTable.findMany({ filter: {}, controls: {} })) as any[];
      expect(authors).toHaveLength(2);

      const postTable = db.getTable(Post);
      const posts = (await postTable.findMany({ filter: {}, controls: {} })) as any[];
      expect(posts).toHaveLength(3);

      const commentTable = db.getTable(Comment);
      const comments = (await commentTable.findMany({ filter: {}, controls: {} })) as any[];
      expect(comments).toHaveLength(6);

      // Verify FK chain: load authors → posts → comments
      const fullAuthors = (await authorTable.findMany({
        filter: {},
        controls: {
          $with: [
            {
              name: "posts",
              filter: {},
              controls: {
                $with: [{ name: "comments", filter: {}, controls: {} }],
              },
            },
          ],
        },
      })) as any[];

      const alicePosts = fullAuthors[0].posts as any[];
      expect(alicePosts).toHaveLength(2);
      expect(alicePosts[0].comments).toHaveLength(2);
      expect(alicePosts[1].comments).toHaveLength(1);

      const bobPosts = fullAuthors[1].posts as any[];
      expect(bobPosts).toHaveLength(1);
      expect(bobPosts[0].comments).toHaveLength(3);
    });

    it("should respect maxDepth limit", async () => {
      const authorTable = db.getTable(Author);
      // depth=0, maxDepth=1: authors created, posts created (depth 1),
      // but comments at depth 2 cause an error
      await expect(
        authorTable.insertMany(
          [
            {
              name: "Alice",
              posts: [{ title: "P1", comments: [{ body: "should not be created" }] }],
            },
          ] as any,
          { maxDepth: 1 },
        ),
      ).rejects.toThrow(/exceeds maxDepth/);
    });

    it("should succeed with maxDepth when nested data fits within limit", async () => {
      const authorTable = db.getTable(Author);
      // depth=0, maxDepth=1: authors created, posts created (depth 1), no deeper nesting
      await authorTable.insertMany(
        [
          {
            name: "Alice",
            posts: [{ title: "P1" }],
          },
        ] as any,
        { maxDepth: 1 },
      );

      const posts = (await db.getTable(Post).findMany({ filter: {}, controls: {} })) as any[];
      expect(posts).toHaveLength(1);
    });

    it("should work with plain insertMany (no nav data)", async () => {
      const authorTable = db.getTable(Author);
      const result = await authorTable.insertMany([
        { name: "Alice" },
        { name: "Bob" },
        { name: "Carol" },
      ] as any);

      expect(result.insertedCount).toBe(3);
      expect(result.insertedIds).toHaveLength(3);

      const authors = (await authorTable.findMany({ filter: {}, controls: {} })) as any[];
      expect(authors).toHaveLength(3);
    });

    it("should work with insertOne (delegates to insertMany)", async () => {
      const postTable = db.getTable(Post);
      const result = await postTable.insertOne({
        title: "Single post",
        author: { name: "Alice" },
      } as any);

      expect(result.insertedId).toBeDefined();

      const posts = (await postTable.findMany({
        filter: {},
        controls: { $with: [{ name: "author", filter: {}, controls: {} }] },
      })) as any[];
      expect(posts).toHaveLength(1);
      expect((posts[0].author as any).name).toBe("Alice");
    });
  });

  // ── Transaction wrapping ────────────────────────────────────────────────

  describe("transaction wrapping", () => {
    it("should wrap insertMany with nested creation in withTransaction", async () => {
      const txLog: string[] = [];

      class TxTrackingAdapter extends InMemoryAdapter {
        protected override async _beginTransaction(): Promise<unknown> {
          txLog.push("begin");
          return "tx-state";
        }
        protected override async _commitTransaction(state: unknown): Promise<void> {
          txLog.push(`commit:${String(state)}`);
        }
        protected override async _rollbackTransaction(state: unknown): Promise<void> {
          txLog.push(`rollback:${String(state)}`);
        }
      }

      const space = new DbSpace(() => new TxTrackingAdapter());
      const authorTable = space.getTable(Author) as AtscriptDbTable;

      await authorTable.insertMany([
        { name: "Tx Author 1", posts: [{ title: "Tx Post 1" }] },
        { name: "Tx Author 2", posts: [{ title: "Tx Post 2" }] },
      ]);

      // Only ONE begin/commit pair — nested calls reuse the transaction
      expect(txLog).toEqual(["begin", "commit:tx-state"]);
    });

    it("should rollback on error during nested creation", async () => {
      const txLog: string[] = [];
      // Shared counter across all adapter instances from the factory
      const shared = { callCount: 0 };

      class FailingInsertAdapter extends InMemoryAdapter {
        protected override async _beginTransaction(): Promise<unknown> {
          txLog.push("begin");
          return "tx";
        }
        protected override async _commitTransaction(): Promise<void> {
          txLog.push("commit");
        }
        protected override async _rollbackTransaction(): Promise<void> {
          txLog.push("rollback");
        }
        override async insertMany(
          data: Array<Record<string, unknown>>,
        ): Promise<TDbInsertManyResult> {
          shared.callCount++;
          // Fail on the second insertMany call (the main table insert, after TO deps)
          if (shared.callCount === 2) {
            throw new Error("Simulated insert failure");
          }
          return super.insertMany(data);
        }
      }

      const space = new DbSpace(() => new FailingInsertAdapter());
      const postTable = space.getTable(Post) as AtscriptDbTable;

      await expect(
        postTable.insertOne({ title: "Will fail", author: { name: "Ghost" } }),
      ).rejects.toThrow("Simulated insert failure");

      // Transaction was started and rolled back
      expect(txLog).toEqual(["begin", "rollback"]);
    });

    it("should not start a transaction for plain insertMany without nesting", async () => {
      const txLog: string[] = [];

      class TxTrackingAdapter extends InMemoryAdapter {
        protected override async _beginTransaction(): Promise<unknown> {
          txLog.push("begin");
          return undefined;
        }
        protected override async _commitTransaction(): Promise<void> {
          txLog.push("commit");
        }
        protected override async _rollbackTransaction(): Promise<void> {
          txLog.push("rollback");
        }
      }

      const space = new DbSpace(() => new TxTrackingAdapter());
      const authorTable = space.getTable(Author) as AtscriptDbTable;

      // Plain insert without nav data still wraps in withTransaction
      await authorTable.insertMany([{ name: "Plain 1" }, { name: "Plain 2" }]);

      // Transaction is still started (wraps the whole operation)
      expect(txLog).toEqual(["begin", "commit"]);
    });
  });

  // ── Deep replace (bulkReplace) ──────────────────────────────────────────

  describe("deep replace (bulkReplace)", () => {
    let db: DbSpace;

    beforeEach(() => {
      db = new DbSpace(() => new InMemoryAdapter());
      db.getTable(Author);
      db.getTable(Post);
      db.getTable(Comment);
    });

    function seedAll() {
      const authorAdapter = (db.getTable(Author) as any).adapter as InMemoryAdapter;
      authorAdapter.seed([
        { id: 1, name: "Alice", createdAt: 1000 },
        { id: 2, name: "Bob", createdAt: 1001 },
      ]);

      const postAdapter = (db.getTable(Post) as any).adapter as InMemoryAdapter;
      postAdapter.seed([
        { id: 1, title: "First Post", status: "published", authorId: 1, createdAt: 2000 },
        { id: 2, title: "Second Post", status: "draft", authorId: 1, createdAt: 2001 },
        { id: 3, title: "Bobs Post", status: "published", authorId: 2, createdAt: 2002 },
      ]);

      const commentAdapter = (db.getTable(Comment) as any).adapter as InMemoryAdapter;
      commentAdapter.seed([
        { id: 1, body: "Nice post!", postId: 1, createdAt: 3000 },
        { id: 2, body: "Thanks!", postId: 1, createdAt: 3001 },
      ]);
    }

    it("should replace a single record without nav props", async () => {
      seedAll();
      const authorTable = db.getTable(Author);
      const result = await authorTable.replaceOne({
        id: 1,
        name: "Alice Updated",
        createdAt: 1000,
      } as any);
      expect(result.matchedCount).toBe(1);

      const authors = (await authorTable.findMany({ filter: { id: 1 }, controls: {} })) as any[];
      expect(authors[0].name).toBe("Alice Updated");
    });

    it("should deep-replace TO dependency (Post.author)", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      await postTable.replaceOne({
        id: 1,
        title: "Updated Post",
        status: "published",
        authorId: 1,
        createdAt: 2000,
        author: { id: 1, name: "Alice Replaced" },
      } as any);

      const authorTable = db.getTable(Author);
      const authors = (await authorTable.findMany({ filter: { id: 1 }, controls: {} })) as any[];
      expect(authors[0].name).toBe("Alice Replaced");
    });

    it("should deep-replace FROM dependents (Author.posts)", async () => {
      seedAll();
      const authorTable = db.getTable(Author);
      await authorTable.replaceOne({
        id: 1,
        name: "Alice",
        createdAt: 1000,
        posts: [
          { id: 1, title: "Replaced Post 1", status: "active", authorId: 1, createdAt: 2000 },
          { id: 2, title: "Replaced Post 2", status: "active", authorId: 1, createdAt: 2001 },
        ],
      } as any);

      const postTable = db.getTable(Post);
      const posts = (await postTable.findMany({ filter: { authorId: 1 }, controls: {} })) as any[];
      expect(posts.find((p: any) => p.id === 1).title).toBe("Replaced Post 1");
      expect(posts.find((p: any) => p.id === 2).title).toBe("Replaced Post 2");
    });

    it("should deep-replace FROM dependents with new children (no id)", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      await postTable.replaceOne({
        id: 1,
        title: "Updated Post",
        status: "published",
        authorId: 1,
        createdAt: 2000,
        comments: [{ body: "New comment without id", postId: 1 }],
      } as any);

      const commentTable = db.getTable(Comment);
      const comments = (await commentTable.findMany({
        filter: { postId: 1 },
        controls: {},
      })) as any[];
      // Old comments (Nice post!, Thanks!) should be deleted, only the new one remains
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe("New comment without id");
    });

    it("should remove orphan children when replacing FROM with fewer items", async () => {
      seedAll();
      const authorTable = db.getTable(Author);
      // Author 1 has 2 posts (id 1, 2). Replace with only 1.
      await authorTable.replaceOne({
        id: 1,
        name: "Alice",
        createdAt: 1000,
        posts: [{ title: "Only Post", status: "active", authorId: 1 }],
      } as any);

      const postTable = db.getTable(Post);
      const posts = (await postTable.findMany({ filter: { authorId: 1 }, controls: {} })) as any[];
      expect(posts).toHaveLength(1);
      expect(posts[0].title).toBe("Only Post");
    });

    it("should add children when replacing FROM with more items", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      // Post 1 has 2 comments. Replace with 3.
      await postTable.replaceOne({
        id: 1,
        title: "First Post",
        status: "published",
        authorId: 1,
        createdAt: 2000,
        comments: [
          { body: "Comment A", postId: 1 },
          { body: "Comment B", postId: 1 },
          { body: "Comment C", postId: 1 },
        ],
      } as any);

      const commentTable = db.getTable(Comment);
      const comments = (await commentTable.findMany({
        filter: { postId: 1 },
        controls: {},
      })) as any[];
      expect(comments).toHaveLength(3);
      expect(
        comments.map((c: any) => c.body).toSorted((a: string, b: string) => a.localeCompare(b)),
      ).toEqual(["Comment A", "Comment B", "Comment C"]);
    });

    it("should remove all children when replacing FROM with empty array", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      // Post 1 has 2 comments. Replace with empty.
      await postTable.replaceOne({
        id: 1,
        title: "First Post",
        status: "published",
        authorId: 1,
        createdAt: 2000,
        comments: [],
      } as any);

      const commentTable = db.getTable(Comment);
      const comments = (await commentTable.findMany({
        filter: { postId: 1 },
        controls: {},
      })) as any[];
      expect(comments).toHaveLength(0);
    });

    it("should preserve child identity when replacing FROM with same PKs", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      // Post 1 has comments id=1,2. Replace with same PKs but updated body.
      await postTable.replaceOne({
        id: 1,
        title: "First Post",
        status: "published",
        authorId: 1,
        createdAt: 2000,
        comments: [
          { id: 1, body: "Updated comment 1", postId: 1, createdAt: 3000 },
          { id: 2, body: "Updated comment 2", postId: 1, createdAt: 3001 },
        ],
      } as any);

      const commentTable = db.getTable(Comment);
      const comments = (await commentTable.findMany({
        filter: { postId: 1 },
        controls: {},
      })) as any[];
      expect(comments).toHaveLength(2);
      // PKs preserved — same ids, updated bodies
      expect(comments.find((c: any) => c.id === 1).body).toBe("Updated comment 1");
      expect(comments.find((c: any) => c.id === 2).body).toBe("Updated comment 2");
    });

    it("should handle mixed FROM replace (keep some, remove orphans, add new)", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      // Post 1 has comments id=1,2. Replace: keep id=1, drop id=2 (orphan), add new.
      await postTable.replaceOne({
        id: 1,
        title: "First Post",
        status: "published",
        authorId: 1,
        createdAt: 2000,
        comments: [
          { id: 1, body: "Kept and updated", postId: 1, createdAt: 3000 },
          { body: "Brand new comment", postId: 1 },
        ],
      } as any);

      const commentTable = db.getTable(Comment);
      const comments = (await commentTable.findMany({
        filter: { postId: 1 },
        controls: {},
      })) as any[];
      expect(comments).toHaveLength(2);
      // id=1 preserved with updated body
      expect(comments.find((c: any) => c.id === 1).body).toBe("Kept and updated");
      // id=2 deleted (orphan), new comment inserted
      expect(comments.find((c: any) => c.id === 2)).toBeUndefined();
      expect(comments.some((c: any) => c.body === "Brand new comment")).toBe(true);
    });

    it("should bulk-replace multiple records with TO deps", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      const result = await postTable.bulkReplace([
        {
          id: 1,
          title: "P1 Updated",
          status: "x",
          authorId: 1,
          createdAt: 2000,
          author: { id: 1, name: "Alice V2" },
        },
        {
          id: 3,
          title: "P3 Updated",
          status: "x",
          authorId: 2,
          createdAt: 2002,
          author: { id: 2, name: "Bob V2" },
        },
      ] as any);

      expect(result.matchedCount).toBe(2);

      const authorTable = db.getTable(Author);
      const authors = (await authorTable.findMany({ filter: {}, controls: {} })) as any[];
      expect(authors.find((a: any) => a.id === 1).name).toBe("Alice V2");
      expect(authors.find((a: any) => a.id === 2).name).toBe("Bob V2");
    });

    it("should error on null nav prop", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      await expect(
        postTable.replaceOne({
          id: 1,
          title: "X",
          status: "x",
          authorId: 1,
          createdAt: 2000,
          author: null,
        } as any),
      ).rejects.toThrow("Cannot process null navigation property 'author'");
    });

    it("should wrap replace in a transaction", async () => {
      const txLog: string[] = [];

      class TxAdapter extends InMemoryAdapter {
        protected override async _beginTransaction(): Promise<unknown> {
          txLog.push("begin");
          return "tx";
        }
        protected override async _commitTransaction(): Promise<void> {
          txLog.push("commit");
        }
        protected override async _rollbackTransaction(): Promise<void> {
          txLog.push("rollback");
        }
      }

      const space = new DbSpace(() => new TxAdapter());
      const authorTable = space.getTable(Author) as AtscriptDbTable;
      const adapter = (authorTable as any).adapter as TxAdapter;
      adapter.seed([{ id: 1, name: "Alice", createdAt: 1000 }]);

      await authorTable.replaceOne({ id: 1, name: "Alice V2", createdAt: 1000 } as any);
      expect(txLog).toEqual(["begin", "commit"]);
    });

    it("should rollback on error during deep replace", async () => {
      const txLog: string[] = [];
      let replaceCount = 0;

      class FailAdapter extends InMemoryAdapter {
        protected override async _beginTransaction(): Promise<unknown> {
          txLog.push("begin");
          return "tx";
        }
        protected override async _commitTransaction(): Promise<void> {
          txLog.push("commit");
        }
        protected override async _rollbackTransaction(): Promise<void> {
          txLog.push("rollback");
        }
        override async replaceOne(
          filter: FilterExpr,
          data: Record<string, unknown>,
        ): Promise<TDbUpdateResult> {
          replaceCount++;
          if (replaceCount === 2) {
            throw new Error("Simulated replace failure");
          }
          return super.replaceOne(filter, data);
        }
      }

      const space = new DbSpace(() => new FailAdapter());
      const postTable = space.getTable(Post) as AtscriptDbTable;
      const authorTable = space.getTable(Author) as AtscriptDbTable;
      const authorAdapter = (authorTable as any).adapter as FailAdapter;
      authorAdapter.seed([{ id: 1, name: "Alice", createdAt: 1000 }]);
      const postAdapter = (postTable as any).adapter as FailAdapter;
      postAdapter.seed([{ id: 1, title: "P1", status: "x", authorId: 1, createdAt: 2000 }]);

      await expect(
        postTable.replaceOne({
          id: 1,
          title: "Updated",
          status: "x",
          authorId: 1,
          createdAt: 2000,
          author: { id: 1, name: "Alice V2", createdAt: 1000 },
        } as any),
      ).rejects.toThrow("Simulated replace failure");

      expect(txLog).toEqual(["begin", "rollback"]);
    });
  });

  // ── Deep update (bulkUpdate / PATCH) ────────────────────────────────────

  describe("deep update (bulkUpdate)", () => {
    let db: DbSpace;

    beforeEach(() => {
      db = new DbSpace(() => new InMemoryAdapter());
      db.getTable(Author);
      db.getTable(Post);
      db.getTable(Comment);
    });

    function seedAll() {
      const authorAdapter = (db.getTable(Author) as any).adapter as InMemoryAdapter;
      authorAdapter.seed([
        { id: 1, name: "Alice", createdAt: 1000 },
        { id: 2, name: "Bob", createdAt: 1001 },
      ]);

      const postAdapter = (db.getTable(Post) as any).adapter as InMemoryAdapter;
      postAdapter.seed([
        { id: 1, title: "First Post", status: "published", authorId: 1, createdAt: 2000 },
        { id: 2, title: "Second Post", status: "draft", authorId: 1, createdAt: 2001 },
      ]);
    }

    it("should patch a single record without nav props", async () => {
      seedAll();
      const authorTable = db.getTable(Author);
      const result = await authorTable.updateOne({ id: 1, name: "Alice Patched" } as any);
      expect(result.matchedCount).toBe(1);

      const authors = (await authorTable.findMany({ filter: { id: 1 }, controls: {} })) as any[];
      expect(authors[0].name).toBe("Alice Patched");
    });

    it("should deep-patch TO relation (Post.author)", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      await postTable.updateOne({
        id: 1,
        author: { name: "Alice Patched" },
      } as any);

      const authorTable = db.getTable(Author);
      const authors = (await authorTable.findMany({ filter: { id: 1 }, controls: {} })) as any[];
      expect(authors[0].name).toBe("Alice Patched");
    });

    it("should read FK from DB when not in payload", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      // authorId is NOT in the payload — must be read from DB
      await postTable.updateOne({
        id: 1,
        author: { name: "Alice From DB" },
      } as any);

      const authorTable = db.getTable(Author);
      const authors = (await authorTable.findMany({ filter: { id: 1 }, controls: {} })) as any[];
      expect(authors[0].name).toBe("Alice From DB");
    });

    it("should use FK from payload when present", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      await postTable.updateOne({
        id: 1,
        authorId: 2,
        author: { name: "Bob Patched" },
      } as any);

      const authorTable = db.getTable(Author);
      const bob = (await authorTable.findMany({ filter: { id: 2 }, controls: {} })) as any[];
      expect(bob[0].name).toBe("Bob Patched");
    });

    it("should error on null FK when patching TO relation", async () => {
      const postAdapter = (db.getTable(Post) as any).adapter as InMemoryAdapter;
      postAdapter.seed([{ id: 99, title: "Orphan", status: "x", authorId: null, createdAt: 5000 }]);

      const postTable = db.getTable(Post);
      await expect(
        postTable.updateOne({
          id: 99,
          author: { name: "Ghost" },
        } as any),
      ).rejects.toThrow("Cannot patch relation 'author' — foreign key 'authorId' is null");
    });

    it("should reject FROM relation in patch mode with plain array", async () => {
      seedAll();
      const authorTable = db.getTable(Author);
      await expect(
        authorTable.updateOne({
          id: 1,
          posts: [{ id: 1, title: "Nope" }],
        } as any),
      ).rejects.toThrow("Cannot patch 1:N relation");
    });

    it("should accept FROM relation with $insert operator", async () => {
      seedAll();
      const authorTable = db.getTable(Author);
      const result = await authorTable.updateOne({
        id: 1,
        posts: { $insert: [{ title: "New Post" }] },
      } as any);
      expect(result.matchedCount).toBe(1);

      // The new post should exist with FK wired to author 1
      const postTable = db.getTable(Post);
      const posts = (await postTable.findMany({ filter: { authorId: 1 }, controls: {} })) as any[];
      expect(posts.length).toBe(3); // 2 seeded + 1 inserted
      expect(posts.some((p: any) => p.title === "New Post")).toBe(true);
    });

    it("should accept FROM relation with $remove operator", async () => {
      seedAll();
      const authorTable = db.getTable(Author);
      const result = await authorTable.updateOne({
        id: 1,
        posts: { $remove: [{ id: 2 }] },
      } as any);
      expect(result.matchedCount).toBe(1);

      // Post 2 should be deleted
      const postTable = db.getTable(Post);
      const posts = (await postTable.findMany({ filter: { authorId: 1 }, controls: {} })) as any[];
      expect(posts.length).toBe(1);
      expect(posts[0].id).toBe(1);
    });

    it("should accept FROM relation with $replace operator", async () => {
      seedAll();
      const authorTable = db.getTable(Author);
      const result = await authorTable.updateOne({
        id: 1,
        posts: { $replace: [{ id: 1, title: "Replaced Post" }] },
      } as any);
      expect(result.matchedCount).toBe(1);

      // Only post 1 should remain (post 2 orphaned and deleted)
      const postTable = db.getTable(Post);
      const posts = (await postTable.findMany({ filter: { authorId: 1 }, controls: {} })) as any[];
      expect(posts.length).toBe(1);
      expect(posts[0].title).toBe("Replaced Post");
    });

    it("should accept FROM relation with $update operator", async () => {
      seedAll();
      const authorTable = db.getTable(Author);
      const result = await authorTable.updateOne({
        id: 1,
        posts: { $update: [{ id: 1, title: "Updated Title" }] },
      } as any);
      expect(result.matchedCount).toBe(1);

      // Post 1 should be updated, post 2 untouched
      const postTable = db.getTable(Post);
      const post1 = (await postTable.findOne({ filter: { id: 1 }, controls: {} })) as any;
      expect(post1.title).toBe("Updated Title");
      const post2 = (await postTable.findOne({ filter: { id: 2 }, controls: {} })) as any;
      expect(post2.title).toBe("Second Post");
    });

    it("should error on null nav prop in patch mode", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      await expect(
        postTable.updateOne({
          id: 1,
          author: null,
        } as any),
      ).rejects.toThrow("Cannot process null navigation property 'author'");
    });

    it("should bulk-update multiple records with TO deps", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      const result = await postTable.bulkUpdate([
        { id: 1, authorId: 1, author: { name: "Alice Bulk" } },
        { id: 2, authorId: 1, author: { name: "Alice Bulk2" } },
      ] as any);

      expect(result.matchedCount).toBe(2);

      // Second patch overwrites the first since they target the same author
      const authorTable = db.getTable(Author);
      const alice = (await authorTable.findMany({ filter: { id: 1 }, controls: {} })) as any[];
      expect(alice[0].name).toBe("Alice Bulk2");
    });

    it("should error when source record not found for FK read", async () => {
      seedAll();
      const postTable = db.getTable(Post);
      await expect(
        postTable.updateOne({
          id: 999,
          author: { name: "Ghost" },
        } as any),
      ).rejects.toThrow("Cannot patch relation 'author' — source record not found");
    });
  });

  // ── VIA (M:N) deep write ─────────────────────────────────────────────

  describe("VIA (M:N) deep write", () => {
    let ViaTask: any;
    let ViaTag: any;
    let ViaTaskTag: any;
    let db: DbSpace;

    beforeAll(async () => {
      const task = await import("./fixtures/rel-task.as");
      const tag = await import("./fixtures/rel-tag.as");
      const taskTag = await import("./fixtures/rel-task-tag.as");
      ViaTask = task.Task;
      ViaTag = tag.Tag;
      ViaTaskTag = taskTag.TaskTag;
    });

    function createViaDb() {
      db = new DbSpace(() => new InMemoryAdapter());
      db.getTable(ViaTag);
      db.getTable(ViaTask);
      db.getTable(ViaTaskTag);
      const tagAdapter = (db.getTable(ViaTag) as any).adapter as InMemoryAdapter;
      const taskAdapter = (db.getTable(ViaTask) as any).adapter as InMemoryAdapter;
      const junctionAdapter = (db.getTable(ViaTaskTag) as any).adapter as InMemoryAdapter;
      return { tagAdapter, taskAdapter, junctionAdapter };
    }

    it("should insert new tags via VIA relation", async () => {
      const { tagAdapter, junctionAdapter } = createViaDb();
      const taskTable = db.getTable(ViaTask);

      const result = await taskTable.insertMany([
        {
          title: "Task 1",
          tags: [{ name: "alpha" }, { name: "beta" }],
        },
      ] as any);

      expect(result.insertedIds).toHaveLength(1);

      const tags = await tagAdapter.findMany({ filter: {}, controls: {} });
      expect(tags).toHaveLength(2);
      expect(tags.map((t: any) => t.name)).toEqual(["alpha", "beta"]);

      const junctions = await junctionAdapter.findMany({ filter: {}, controls: {} });
      expect(junctions).toHaveLength(2);
      expect(junctions[0]).toMatchObject({ taskId: result.insertedIds[0], tagId: tags[0].id });
      expect(junctions[1]).toMatchObject({ taskId: result.insertedIds[0], tagId: tags[1].id });
    });

    it("should create junction rows for existing tags (by ID)", async () => {
      const { tagAdapter, junctionAdapter } = createViaDb();
      const taskTable = db.getTable(ViaTask);

      tagAdapter.seed([{ id: 10, name: "existing-tag" }]);

      const result = await taskTable.insertMany([
        {
          title: "Task 1",
          tags: [{ id: 10 }],
        },
      ] as any);

      expect(result.insertedIds).toHaveLength(1);

      const tags = await tagAdapter.findMany({ filter: {}, controls: {} });
      expect(tags).toHaveLength(1);
      expect(tags[0]).toMatchObject({ id: 10, name: "existing-tag" });

      const junctions = await junctionAdapter.findMany({ filter: {}, controls: {} });
      expect(junctions).toHaveLength(1);
      expect(junctions[0]).toMatchObject({ taskId: result.insertedIds[0], tagId: 10 });
    });

    it("should handle mix of new and existing tags on insert", async () => {
      const { tagAdapter, junctionAdapter } = createViaDb();
      const taskTable = db.getTable(ViaTask);

      tagAdapter.seed([{ id: 5, name: "old-tag" }]);

      await taskTable.insertMany([
        {
          title: "Task 1",
          tags: [{ id: 5 }, { name: "new-tag" }],
        },
      ] as any);

      const tags = await tagAdapter.findMany({ filter: {}, controls: {} });
      expect(tags).toHaveLength(2);

      const junctions = await junctionAdapter.findMany({ filter: {}, controls: {} });
      expect(junctions).toHaveLength(2);
      const junctionTagIds = junctions
        .map((j: any) => j.tagId)
        .toSorted((a: number, b: number) => a - b);
      expect(junctionTagIds).toContain(5);
      expect(junctionTagIds).toHaveLength(2);
    });

    it("should replace VIA: delete old junctions, insert new targets, create new junctions", async () => {
      const { tagAdapter, taskAdapter, junctionAdapter } = createViaDb();
      const taskTable = db.getTable(ViaTask);

      taskAdapter.seed([{ id: 1, title: "Task 1" }]);
      tagAdapter.seed([{ id: 10, name: "old-tag" }]);
      junctionAdapter.seed([{ id: 100, taskId: 1, tagId: 10 }]);

      await taskTable.bulkReplace([
        {
          id: 1,
          title: "Task 1 Updated",
          tags: [{ name: "new-1" }, { name: "new-2" }],
        },
      ] as any);

      const junctions = await junctionAdapter.findMany({ filter: {}, controls: {} });
      expect(junctions).toHaveLength(2);
      expect(junctions.every((j: any) => j.taskId === 1)).toBe(true);

      const tags = await tagAdapter.findMany({ filter: {}, controls: {} });
      const newTags = tags.filter((t: any) => t.name === "new-1" || t.name === "new-2");
      expect(newTags).toHaveLength(2);

      const junctionTagIds = junctions.map((j: any) => j.tagId);
      for (const nt of newTags) {
        expect(junctionTagIds).toContain((nt as any).id);
      }
    });

    it("should replace VIA with existing tag references (ID only)", async () => {
      const { tagAdapter, taskAdapter, junctionAdapter } = createViaDb();
      const taskTable = db.getTable(ViaTask);

      taskAdapter.seed([{ id: 1, title: "Task 1" }]);
      tagAdapter.seed([
        { id: 10, name: "tag-a" },
        { id: 20, name: "tag-b" },
      ]);
      junctionAdapter.seed([{ id: 100, taskId: 1, tagId: 10 }]);

      await taskTable.bulkReplace([
        {
          id: 1,
          title: "Task 1",
          tags: [{ id: 20 }],
        },
      ] as any);

      const junctions = await junctionAdapter.findMany({ filter: {}, controls: {} });
      expect(junctions).toHaveLength(1);
      expect(junctions[0]).toMatchObject({ taskId: 1, tagId: 20 });

      const tagB = await tagAdapter.findMany({ filter: { id: 20 }, controls: {} });
      expect(tagB[0]).toMatchObject({ id: 20, name: "tag-b" });
    });

    it("should replace VIA with empty array: removes all junctions", async () => {
      const { taskAdapter, junctionAdapter } = createViaDb();
      const taskTable = db.getTable(ViaTask);

      taskAdapter.seed([{ id: 1, title: "Task 1" }]);
      junctionAdapter.seed([
        { id: 100, taskId: 1, tagId: 10 },
        { id: 101, taskId: 1, tagId: 20 },
      ]);

      await taskTable.bulkReplace([
        {
          id: 1,
          title: "Task 1",
          tags: [],
        },
      ] as any);

      const junctions = await junctionAdapter.findMany({ filter: {}, controls: {} });
      expect(junctions).toHaveLength(0);
    });

    // ── VIA patch operators (bulkUpdate) ──────────────────────────────────

    it("should reject VIA relation in patch mode with plain array", async () => {
      const { taskAdapter } = createViaDb();
      const taskTable = db.getTable(ViaTask);
      taskAdapter.seed([{ id: 1, title: "Task 1" }]);

      await expect(
        taskTable.updateOne({
          id: 1,
          tags: [{ name: "nope" }],
        } as any),
      ).rejects.toThrow("Cannot patch M:N relation");
    });

    it("should accept VIA $insert: new tags + junction rows", async () => {
      const { tagAdapter, taskAdapter, junctionAdapter } = createViaDb();
      const taskTable = db.getTable(ViaTask);

      taskAdapter.seed([{ id: 1, title: "Task 1" }]);

      await taskTable.updateOne({
        id: 1,
        tags: { $insert: [{ name: "new-tag" }] },
      } as any);

      const tags = await tagAdapter.findMany({ filter: {}, controls: {} });
      expect(tags).toHaveLength(1);
      expect(tags[0]).toMatchObject({ name: "new-tag" });

      const junctions = await junctionAdapter.findMany({ filter: {}, controls: {} });
      expect(junctions).toHaveLength(1);
      expect(junctions[0]).toMatchObject({ taskId: 1, tagId: tags[0].id });
    });

    it("should accept VIA $remove: deletes junction rows", async () => {
      const { tagAdapter, taskAdapter, junctionAdapter } = createViaDb();
      const taskTable = db.getTable(ViaTask);

      taskAdapter.seed([{ id: 1, title: "Task 1" }]);
      tagAdapter.seed([
        { id: 10, name: "tag-a" },
        { id: 20, name: "tag-b" },
      ]);
      junctionAdapter.seed([
        { id: 100, taskId: 1, tagId: 10 },
        { id: 101, taskId: 1, tagId: 20 },
      ]);

      await taskTable.updateOne({
        id: 1,
        tags: { $remove: [{ id: 10 }] },
      } as any);

      const junctions = await junctionAdapter.findMany({ filter: {}, controls: {} });
      expect(junctions).toHaveLength(1);
      expect(junctions[0]).toMatchObject({ taskId: 1, tagId: 20 });
    });

    it("should accept VIA $replace: clear + rebuild junctions", async () => {
      const { tagAdapter, taskAdapter, junctionAdapter } = createViaDb();
      const taskTable = db.getTable(ViaTask);

      taskAdapter.seed([{ id: 1, title: "Task 1" }]);
      tagAdapter.seed([{ id: 10, name: "old-tag" }]);
      junctionAdapter.seed([{ id: 100, taskId: 1, tagId: 10 }]);

      await taskTable.updateOne({
        id: 1,
        tags: { $replace: [{ name: "replaced-tag" }] },
      } as any);

      const junctions = await junctionAdapter.findMany({ filter: {}, controls: {} });
      expect(junctions).toHaveLength(1);
      expect(junctions[0].taskId).toBe(1);

      // New tag should exist
      const tags = await tagAdapter.findMany({ filter: {}, controls: {} });
      const replacedTag = tags.find((t: any) => t.name === "replaced-tag");
      expect(replacedTag).toBeDefined();
      expect(junctions[0].tagId).toBe(replacedTag!.id);
    });
  });
});
