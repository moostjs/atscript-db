import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { DbError } from "../db-error";
import { DbSpace } from "../table/db-space";
import { prepareFixtures, MockAdapter } from "./test-utils";
import type { DbQuery, TDbInsertManyResult } from "../types";

let AuthorType: any;
let PostType: any;
let CommentType: any;

// ── Tests ───────────────────────────────────────────────────────────────────

describe("FK Validation", () => {
  let sharedStore: Map<string, Array<Record<string, unknown>>>;

  beforeAll(async () => {
    await prepareFixtures();
    const author = await import("./fixtures/rel-author.as");
    const post = await import("./fixtures/test-relations.as");
    const comment = await import("./fixtures/rel-comment.as");
    AuthorType = author.Author;
    PostType = post.Post;
    CommentType = comment.Comment;
  });

  beforeEach(() => {
    sharedStore = new Map();
  });

  function createSpace() {
    return new DbSpace(() => {
      const adapter = new MockAdapter();
      adapter.store = sharedStore;
      return adapter;
    });
  }

  function seedData() {
    sharedStore.set("authors", [
      { id: 1, name: "Alice", createdAt: 1000 },
      { id: 2, name: "Bob", createdAt: 2000 },
    ]);
    sharedStore.set("posts", [
      { id: 10, title: "Post A", authorId: 1, status: "published", createdAt: 1000 },
      { id: 20, title: "Post B", authorId: 1, status: "draft", createdAt: 2000 },
    ]);
  }

  it("should reject insert with non-existent FK value", async () => {
    const space = createSpace();
    space.getTable(AuthorType);
    const posts = space.getTable(PostType);

    seedData();

    await expect(posts.insertOne({ title: "Bad Post", authorId: 999 })).rejects.toThrow(
      "FK constraint violation",
    );
  });

  it("should allow insert with valid FK value", async () => {
    const space = createSpace();
    space.getTable(AuthorType);
    const posts = space.getTable(PostType);

    seedData();

    const result = await posts.insertOne({ title: "Good Post", authorId: 1 });
    expect(result.insertedId).toBeDefined();
  });

  it("should reject insertMany when any record has invalid FK", async () => {
    const space = createSpace();
    space.getTable(AuthorType);
    const posts = space.getTable(PostType);

    seedData();

    await expect(
      posts.insertMany([
        { title: "Good Post", authorId: 1 },
        { title: "Bad Post", authorId: 999 },
      ] as any),
    ).rejects.toThrow("FK constraint violation");
  });

  it("should reject bulkUpdate with non-existent FK value", async () => {
    const space = createSpace();
    space.getTable(AuthorType);
    const posts = space.getTable(PostType);

    seedData();

    await expect(posts.updateOne({ id: 10, authorId: 999 } as any)).rejects.toThrow(
      "FK constraint violation",
    );
  });

  it("should allow bulkUpdate that does not touch FK fields", async () => {
    const space = createSpace();
    space.getTable(AuthorType);
    const posts = space.getTable(PostType);

    seedData();

    // Update only title — no FK validation needed
    const result = await posts.updateOne({ id: 10, title: "Updated Title" } as any);
    expect(result.matchedCount).toBe(1);
  });

  it("should reject replaceOne with non-existent FK value", async () => {
    const space = createSpace();
    space.getTable(AuthorType);
    const posts = space.getTable(PostType);

    seedData();

    await expect(
      posts.replaceOne({ id: 10, title: "Replaced", authorId: 999, status: "published" } as any),
    ).rejects.toThrow("FK constraint violation");
  });

  it("should not validate FK when adapter has native support", async () => {
    const nativeStore = new Map<string, Array<Record<string, unknown>>>();
    const space = new DbSpace(() => {
      const adapter = new MockAdapter();
      adapter.store = nativeStore;
      adapter.supportsNativeForeignKeys = () => true;
      return adapter;
    });

    space.getTable(AuthorType);
    const posts = space.getTable(PostType);

    nativeStore.set("authors", []);
    nativeStore.set("posts", []);

    // Should NOT throw — native adapter handles FK
    const result = await posts.insertOne({ title: "Post", authorId: 999 });
    expect(result.insertedId).toBeDefined();
  });

  it("should validate FK transitively (comment → post)", async () => {
    const space = createSpace();
    space.getTable(AuthorType);
    space.getTable(PostType);
    const comments = space.getTable(CommentType);

    seedData();

    // Valid: post 10 exists
    const result = await comments.insertOne({ body: "Good comment", postId: 10 });
    expect(result.insertedId).toBeDefined();

    // Invalid: post 999 does not exist
    await expect(comments.insertOne({ body: "Bad comment", postId: 999 })).rejects.toThrow(
      "FK constraint violation",
    );
  });

  // ── Deep insert FK validation (FROM children) ──────────────────────────

  it("should reject deep insert when FROM child has invalid FK to third table", async () => {
    const space = createSpace();
    space.getTable(AuthorType); // register author table
    const posts = space.getTable(PostType);
    // Note: CommentType is NOT explicitly registered — it will be lazily resolved
    // via _writeTableResolver during the nested insert

    seedData();

    // Deep insert: Post with nested Comment that has invalid authorId
    await expect(
      posts.insertOne({
        title: "Post with bad comment",
        authorId: 1,
        comments: [{ body: "Bad comment", authorId: 999 }],
      }),
    ).rejects.toThrow("FK constraint violation");
  });

  it("should allow deep insert when FROM child has valid FK to third table", async () => {
    const space = createSpace();
    space.getTable(AuthorType); // register author table
    const posts = space.getTable(PostType);

    seedData();

    // Deep insert: Post with nested Comment that has valid authorId.
    // Explicit id so MockAdapter stores it and child FK validation can find it.
    const result = await posts.insertOne({
      id: 30,
      title: "Post with good comment",
      authorId: 1,
      comments: [{ body: "Good comment", authorId: 1 }],
    });
    expect(result.insertedId).toBeDefined();
  });

  it("should reject deep insert even when FK target table is not pre-registered", async () => {
    const space = createSpace();
    // Only register posts — NOT authors or comments
    const posts = space.getTable(PostType);

    seedData();

    // The Comment table will be lazily resolved, and its FK to authors
    // should still be validated even though authors table isn't pre-registered.
    // The _writeTableResolver fallback should resolve the authors table on demand.
    await expect(
      posts.insertOne({
        title: "Post",
        authorId: 1,
        comments: [{ body: "Bad comment", authorId: 999 }],
      }),
    ).rejects.toThrow("FK constraint violation");
  });

  it("should prefix error paths with nav field name for nested FROM FK violations", async () => {
    const space = createSpace();
    space.getTable(AuthorType);
    const posts = space.getTable(PostType);

    seedData();

    try {
      await posts.insertOne({
        title: "Post with bad comment",
        authorId: 1,
        comments: [{ body: "Bad comment", authorId: 999 }],
      });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DbError);
      const err = error as DbError;
      expect(err.code).toBe("FK_VIOLATION");
      // Error paths must include the nav field prefix
      const paths = err.errors.map((e) => e.path);
      expect(paths).toContain("comments.authorId");
    }
  });

  // ── Transaction context (bug 04 + bug 07) ──────────────────────────────

  it("should run FK validation counts inside the transaction context", async () => {
    // FK counts must run inside the transaction so deep writes can see
    // uncommitted TO inserts. Counter allocation (the original cause of
    // multi-collection tx issues) is handled outside the session in the adapter.
    class TxTrackingAdapter extends MockAdapter {
      countTxStates: unknown[] = [];
      insertTxStates: unknown[] = [];

      protected override async _beginTransaction(): Promise<unknown> {
        return "mock-session";
      }

      override async count(query: DbQuery): Promise<number> {
        this.countTxStates.push(this._getTransactionState());
        return super.count(query);
      }

      override async insertMany(
        data: Array<Record<string, unknown>>,
      ): Promise<TDbInsertManyResult> {
        this.insertTxStates.push(this._getTransactionState());
        return super.insertMany(data);
      }
    }

    const store = new Map<string, Array<Record<string, unknown>>>();
    const adapters: TxTrackingAdapter[] = [];
    const space = new DbSpace(() => {
      const adapter = new TxTrackingAdapter();
      adapter.store = store;
      adapters.push(adapter);
      return adapter;
    });

    store.set("authors", [{ id: 1, name: "Alice", createdAt: 1000 }]);
    store.set("posts", []);

    space.getTable(AuthorType);
    const posts = space.getTable(PostType);

    await posts.insertOne({ title: "Test", authorId: 1 });

    // FK validation count runs INSIDE the transaction context
    const authorsAdapter = adapters.find((a) => a.countTxStates.length > 0);
    expect(authorsAdapter).toBeDefined();
    expect(authorsAdapter!.countTxStates).toEqual(["mock-session"]);

    // insertMany also runs INSIDE the transaction
    const postsAdapter = adapters.find((a) => a.insertTxStates.length > 0);
    expect(postsAdapter).toBeDefined();
    expect(postsAdapter!.insertTxStates).toEqual(["mock-session"]);
  });
});
