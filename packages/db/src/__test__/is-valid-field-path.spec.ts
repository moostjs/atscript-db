import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbSpace } from "../table/db-space";
import { MockAdapter, prepareFixtures } from "./test-utils";

let NoDepthSource: any;
let NoDepthMiddle: any;
let NoDepthTarget: any;
let Post: any;
let Author: any;
let Comment: any;

describe("AtscriptDbReadable.isValidFieldPath", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const src = await import("./fixtures/rel-no-depth-source.as");
    const mid = await import("./fixtures/rel-no-depth-middle.as");
    const tgt = await import("./fixtures/rel-no-depth-target.as");
    const post = await import("./fixtures/test-relations.as");
    const author = await import("./fixtures/rel-author.as");
    const comment = await import("./fixtures/rel-comment.as");
    NoDepthSource = src.NoDepthSource;
    NoDepthMiddle = mid.NoDepthMiddle;
    NoDepthTarget = tgt.NoDepthTarget;
    Post = post.Post;
    Author = author.Author;
    Comment = comment.Comment;
  });

  // ── Upstream fix regression pin ──────────────────────────────────────────

  // Pre-@atscript/typescript@0.1.60, `flattenAnnotatedType`'s shared
  // visitedIds cycle guard truncated sibling rel.to references to the same
  // target type — `target.*` was missing from flatMap when `middle.target`
  // was visited first. Fixed upstream; this test pins the fix.
  it("flatMap expands rel.to descendants on both sibling paths (upstream 0.1.60 fix)", () => {
    const db = new DbSpace(() => new MockAdapter());
    db.getTable(NoDepthMiddle);
    db.getTable(NoDepthTarget);
    const src = db.getTable(NoDepthSource);
    expect(src.navFields.has("target")).toBe(true);
    expect(src.flatMap.has("target.id")).toBe(true);
    expect(src.flatMap.has("target.name")).toBe(true);
    // The transitive path still expands too.
    expect(src.flatMap.has("middle.target.name")).toBe(true);
  });

  // ── isValidFieldPath contract ─────────────────────────────────────────────

  // Post-upstream-fix this hits the fast path (flatMap.has). The method
  // remains as defense-in-depth: real self-referential cycles still get
  // truncated by atscript's path-local guard, so e.g. `parent.parent.parent.name`
  // on a self-ref schema won't be in flatMap but should still validate.
  it("resolves rel.to nested paths via the validator method", () => {
    const db = new DbSpace(() => new MockAdapter());
    db.getTable(NoDepthMiddle);
    db.getTable(NoDepthTarget);
    const src = db.getTable(NoDepthSource);
    expect(src.isValidFieldPath("target.id")).toBe(true);
    expect(src.isValidFieldPath("target.name")).toBe(true);
    expect(src.isValidFieldPath("target.score")).toBe(true);
  });

  it("rejects unknown subfields on a rel.to target — still fails loud", () => {
    const db = new DbSpace(() => new MockAdapter());
    db.getTable(NoDepthMiddle);
    db.getTable(NoDepthTarget);
    const src = db.getTable(NoDepthSource);
    expect(src.isValidFieldPath("target.nonexistent")).toBe(false);
  });

  // ── Direct flatMap paths (regression pins) ─────────────────────────────────

  it("accepts top-level fields that exist directly on the table", () => {
    const db = new DbSpace(() => new MockAdapter());
    const src = db.getTable(NoDepthSource);
    expect(src.isValidFieldPath("id")).toBe(true);
    expect(src.isValidFieldPath("title")).toBe(true);
    expect(src.isValidFieldPath("targetId")).toBe(true);
  });

  it("rejects top-level fields that don't exist", () => {
    const db = new DbSpace(() => new MockAdapter());
    const src = db.getTable(NoDepthSource);
    expect(src.isValidFieldPath("doesNotExist")).toBe(false);
  });

  it("accepts nested rel.to paths that DID expand (fast path via flatMap)", () => {
    const db = new DbSpace(() => new MockAdapter());
    db.getTable(NoDepthTarget);
    const middle = db.getTable(NoDepthMiddle);
    // Middle is a fresh starting point — its `target` expands normally.
    expect(middle.flatMap.has("target.name")).toBe(true);
    expect(middle.isValidFieldPath("target.name")).toBe(true);
  });

  it("accepts rel.from nested paths (array refs expand unconditionally)", () => {
    const db = new DbSpace(() => new MockAdapter());
    db.getTable(Comment);
    db.getTable(Author);
    const post = db.getTable(Post);
    expect(post.flatMap.has("comments.body")).toBe(true);
    expect(post.isValidFieldPath("comments.body")).toBe(true);
  });

  // ── Negative cases ─────────────────────────────────────────────────────────

  it("rejects nested paths on non-nav fields", () => {
    const db = new DbSpace(() => new MockAdapter());
    const src = db.getTable(NoDepthSource);
    expect(src.isValidFieldPath("title.foo")).toBe(false);
  });

  it("rejects nested paths when the head segment doesn't exist at all", () => {
    const db = new DbSpace(() => new MockAdapter());
    const src = db.getTable(NoDepthSource);
    expect(src.isValidFieldPath("nonsense.foo")).toBe(false);
  });

  // ── Cycle guard ────────────────────────────────────────────────────────────

  it("does not infinite-loop on cyclic relations (Post.author → Author.posts → Post...)", () => {
    const db = new DbSpace(() => new MockAdapter());
    db.getTable(Author);
    db.getTable(Comment);
    const post = db.getTable(Post);
    // Eventually fails (no such leaf), but the test exists to prove we don't
    // blow the stack on the back-and-forth nav traversal.
    expect(post.isValidFieldPath("author.posts.author.posts.bogus")).toBe(false);
  });
});
