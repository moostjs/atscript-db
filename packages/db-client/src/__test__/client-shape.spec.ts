/**
 * Compile-only: a model generated from a `.as` interface satisfies
 * `AtscriptClientShape` and types the client (`vp lint` type-checks this).
 */
import { describe, it, expectTypeOf } from "vite-plus/test";

import { Client } from "../client";
import type { AtscriptClientShape, IdOf, InsertOf, NavOf, PatchOf } from "../types";
import type { CsAuthor, CsFeatured, CsPlain, CsPost } from "./fixtures/client-shape.as";

const never = (): boolean => Math.random() > 2;

describe("generated models as Client<typeof X>", () => {
  it("satisfy AtscriptClientShape, with and without navigation props", () => {
    expectTypeOf<typeof CsPost>().toMatchTypeOf<AtscriptClientShape>();
    expectTypeOf<typeof CsAuthor>().toMatchTypeOf<AtscriptClientShape>();
    expectTypeOf<typeof CsFeatured>().toMatchTypeOf<AtscriptClientShape>(); // `extends`
    expectTypeOf<typeof CsPlain>().toMatchTypeOf<AtscriptClientShape>(); // not a table
    expectTypeOf<IdOf<typeof CsPost>>().toEqualTypeOf<number>();
    expectTypeOf<NavOf<typeof CsPost>>().toHaveProperty("author");
  });

  it("type reads and writes", () => {
    if (never()) {
      const posts = new Client<typeof CsPost>("/api/posts");
      void new Client<typeof CsFeatured>("/api/featured").update({ id: 1, rank: { $inc: 1 } });
      expectTypeOf(posts.one(1)).resolves.toMatchTypeOf<{ title: string } | null>();
      void posts.update({ id: 1, views: { $inc: 1 }, tags: { $insert: ["x"] } });
      const post = {} as CsPost;
      void posts.insert(post);
      // @ts-expect-error unknown field
      void posts.update({ id: 1, nope: 1 });
      expectTypeOf<{ title: "t"; authorId: 1 }>().toMatchTypeOf<InsertOf<typeof CsPost>>();
      expectTypeOf<{ id: 1; title: 2 }>().not.toMatchTypeOf<PatchOf<typeof CsPost>>();
    }
  });
});
