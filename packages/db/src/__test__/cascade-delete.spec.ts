import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { DbSpace } from "../table/db-space";
import { prepareFixtures, MockAdapter } from "./test-utils";

let AuthorType: any;
let PostType: any;
let CommentType: any;
let CycleAType: any;
let CycleBType: any;

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Cascade Delete", () => {
  // Shared store across all adapters in a DbSpace
  let sharedStore: Map<string, Array<Record<string, unknown>>>;

  beforeAll(async () => {
    await prepareFixtures();
    const author = await import("./fixtures/rel-author.as");
    const post = await import("./fixtures/test-relations.as");
    const comment = await import("./fixtures/rel-comment.as");
    const cycleA = await import("./fixtures/cycle-a.as");
    const cycleB = await import("./fixtures/cycle-b.as");
    AuthorType = author.Author;
    PostType = post.Post;
    CommentType = comment.Comment;
    CycleAType = cycleA.CycleA;
    CycleBType = cycleB.CycleB;
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
    // Author 1 has posts 10, 20
    // Post 10 has comments 100, 101
    // Post 20 has comments 200
    sharedStore.set("authors", [
      { id: 1, name: "Alice", createdAt: 1000 },
      { id: 2, name: "Bob", createdAt: 2000 },
    ]);
    sharedStore.set("posts", [
      { id: 10, title: "Post A", authorId: 1, status: "published", createdAt: 1000 },
      { id: 20, title: "Post B", authorId: 1, status: "draft", createdAt: 2000 },
      { id: 30, title: "Post C", authorId: 2, status: "published", createdAt: 3000 },
    ]);
    sharedStore.set("comments", [
      { id: 100, body: "Comment 1", postId: 10, createdAt: 1000 },
      { id: 101, body: "Comment 2", postId: 10, createdAt: 1001 },
      { id: 200, body: "Comment 3", postId: 20, createdAt: 2000 },
      { id: 300, body: "Comment 4", postId: 30, createdAt: 3000 },
    ]);
  }

  it("should cascade delete children when parent is deleted (deleteOne)", async () => {
    const space = createSpace();
    const posts = space.getTable(PostType);
    space.getTable(CommentType);
    space.getTable(AuthorType); // register for FK discovery

    seedData();

    // Delete post 10 → should cascade-delete comments 100, 101
    await posts.deleteOne(10);

    expect(sharedStore.get("posts")!.map((p) => p.id)).toEqual([20, 30]);
    expect(sharedStore.get("comments")!.map((c) => c.id)).toEqual([200, 300]);
  });

  it("should cascade delete children when parent is deleted (deleteMany)", async () => {
    const space = createSpace();
    const posts = space.getTable(PostType);
    space.getTable(CommentType);
    space.getTable(AuthorType);

    seedData();

    // Delete posts by author 1 → should cascade-delete their comments
    await posts.deleteMany({ authorId: 1 });

    expect(sharedStore.get("posts")!.map((p) => p.id)).toEqual([30]);
    expect(sharedStore.get("comments")!.map((c) => c.id)).toEqual([300]);
  });

  it("should cascade transitively (grandparent → parent → child)", async () => {
    const space = createSpace();
    const authors = space.getTable(AuthorType);
    space.getTable(PostType);
    space.getTable(CommentType);

    seedData();

    // Delete author 1 → cascade posts 10, 20 → cascade comments 100, 101, 200
    await authors.deleteOne(1);

    expect(sharedStore.get("authors")!.map((a) => a.id)).toEqual([2]);
    expect(sharedStore.get("posts")!.map((p) => p.id)).toEqual([30]);
    expect(sharedStore.get("comments")!.map((c) => c.id)).toEqual([300]);
  });

  it("should not cascade when no children exist", async () => {
    const space = createSpace();
    const posts = space.getTable(PostType);
    space.getTable(CommentType);
    space.getTable(AuthorType);

    seedData();

    // Delete post 30 which has one comment (300)
    await posts.deleteOne(30);

    expect(sharedStore.get("posts")!.map((p) => p.id)).toEqual([10, 20]);
    expect(sharedStore.get("comments")!.map((c) => c.id)).toEqual([100, 101, 200]);
  });

  it("should not cascade with native FK adapter", async () => {
    // Create a space with an adapter that claims native FK support
    const nativeStore = new Map<string, Array<Record<string, unknown>>>();
    const space = new DbSpace(() => {
      const adapter = new MockAdapter();
      adapter.store = nativeStore;
      // Override to simulate native FK support
      adapter.supportsNativeForeignKeys = () => true;
      return adapter;
    });

    const posts = space.getTable(PostType);
    space.getTable(CommentType);
    space.getTable(AuthorType);

    nativeStore.set("posts", [
      { id: 10, title: "Post A", authorId: 1, status: "published", createdAt: 1000 },
    ]);
    nativeStore.set("comments", [{ id: 100, body: "Comment 1", postId: 10, createdAt: 1000 }]);

    // Delete post — with native FK, no application-level cascade
    await posts.deleteOne(10);

    expect(nativeStore.get("posts")!).toHaveLength(0);
    // Comment should NOT be deleted (native adapter handles it)
    expect(nativeStore.get("comments")!).toHaveLength(1);
  });

  it("should handle deleteOne with non-existent record gracefully", async () => {
    const space = createSpace();
    const posts = space.getTable(PostType);
    space.getTable(CommentType);
    space.getTable(AuthorType);

    seedData();

    // Delete a non-existent post — no cascade, no errors
    const result = await posts.deleteOne(999);
    expect(result.deletedCount).toBe(0);

    // Everything untouched
    expect(sharedStore.get("posts")!).toHaveLength(3);
    expect(sharedStore.get("comments")!).toHaveLength(4);
  });

  it("should detect cascade cycles and stop instead of infinite recursion", async () => {
    // CycleA.bId → CycleB (cascade), CycleB.aId → CycleA (cascade)
    const space = createSpace();
    const tableA = space.getTable(CycleAType);
    space.getTable(CycleBType);

    sharedStore.set("cycle_a", [{ id: 1, name: "A1", bId: 10 }]);
    sharedStore.set("cycle_b", [{ id: 10, name: "B1", aId: 1 }]);

    // Delete A1 → cascades to B1 → would cascade back to A1, but cycle detection stops it
    await tableA.deleteOne(1);

    expect(sharedStore.get("cycle_a")!).toHaveLength(0);
    expect(sharedStore.get("cycle_b")!).toHaveLength(0);
  });

  it("should not interfere between independent cascade chains", async () => {
    // Two independent deletes should each get a fresh visited set
    const space = createSpace();
    const authors = space.getTable(AuthorType);
    space.getTable(PostType);
    space.getTable(CommentType);

    seedData();

    // First delete: author 1
    await authors.deleteOne(1);
    expect(sharedStore.get("authors")!.map((a) => a.id)).toEqual([2]);

    // Second delete: author 2 — should work even though 'authors' was visited in the first chain
    await authors.deleteOne(2);
    expect(sharedStore.get("authors")!).toHaveLength(0);
    expect(sharedStore.get("posts")!).toHaveLength(0);
  });
});
