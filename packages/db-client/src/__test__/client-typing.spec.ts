/**
 * Typing-only assertions for the `Client<T>` public surface. The tests don't
 * exercise runtime — they exist so the TS compiler errors out if the generic
 * inference regresses (e.g. someone widens `action()` back to `unknown` or
 * removes `$with` narrowing on `query()`).
 *
 * Every block is wrapped in a no-op `if (false)` so the call expressions
 * type-check but never reach `fetch()`.
 */
import { describe, it, expectTypeOf } from "vite-plus/test";

import { Client } from "../client";

// Synthetic Atscript-shaped type. Inlined here (not imported) to keep the
// brand fields explicit and stable across fixture regeneration.
declare class Post {
  id: number;
  title: string;
  body: string;
  static __is_atscript_annotated_type: true;
  static type: { __dataType?: Post };
  static __ownProps: { id: number; title: string; body: string };
  static __navProps: { author?: Author; tags?: Tag[] };
  static __pk: number;
}
declare class Author {
  id: number;
  name: string;
}
declare class Tag {
  id: number;
  label: string;
}

describe("Client<T> — generic typing (compile-only assertions)", () => {
  it("query() narrows the response type by the literal $with array", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Post>("/api/posts");

      const noWith = c.query();
      type NoWithRow = Awaited<typeof noWith>[number];
      // Own-prop fields are present on the row type even with no $with.
      expectTypeOf<NoWithRow>().toHaveProperty("id");
      expectTypeOf<NoWithRow>().toHaveProperty("title");
      expectTypeOf<NoWithRow>().toHaveProperty("body");

      const withAuthor = c.query({
        controls: { $with: [{ name: "author" }] as const },
      });
      // Own-prop fields remain present.
      type Row = Awaited<typeof withAuthor>[number];
      expectTypeOf<Row>().toHaveProperty("id");
      expectTypeOf<Row>().toHaveProperty("title");
      // Listed `$with` relation appears on the row type.
      expectTypeOf<Row>().toHaveProperty("author");
    }
  });

  it("one() narrows the same way as query() and accepts the typed PK", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Post>("/api/posts");

      const r = c.one(42, { controls: { $with: [{ name: "author" }] as const } });
      type Row = NonNullable<Awaited<typeof r>>;
      expectTypeOf<Row>().toHaveProperty("author");

      // PK must accept the typed `__pk` shape (number for Post).
      void c.one(123);
      // @ts-expect-error wrong PK type
      void c.one("a-string-pk");
    }
  });

  it("action() rejects scalar identifiers at compile time", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Post>("/api/posts");

      // OK — object identifier.
      void c.action("block", { id: 42 });
      // OK — array of identifier objects.
      void c.action("lock", [{ id: 1 }, { id: 2 }]);
      // OK — table-level (no identifier).
      void c.action("refresh");

      // Scalars / arrays of scalars MUST not compile.
      // @ts-expect-error scalar identifier rejected
      void c.action("block", 42);
      // @ts-expect-error string scalar rejected
      void c.action("block", "abc");
      // @ts-expect-error array of scalars rejected
      void c.action("lock", [1, 2, 3]);
      // @ts-expect-error null rejected
      void c.action("block", null);
    }
  });

  it("action()<R> propagates the asserted return shape", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Post>("/api/posts");

      const r = c.action<{ message: string; affected: number }>("block", { id: 42 });
      expectTypeOf(r).resolves.toEqualTypeOf<{ message: string; affected: number }>();

      const u = c.action("block", { id: 42 });
      expectTypeOf(u).resolves.toEqualTypeOf<unknown>();
    }
  });

  it("ungenericated Client<> still compiles with degraded inference", () => {
    if (!shouldRun()) {
      const c = new Client("/api/anything");
      // Falls back to AtscriptClientShape → Record<string, unknown> for Own<T>.
      // Smoke check: these all type-check without errors.
      void c.query();
      void c.action("foo", { id: 1 });
    }
  });
  it("filters accept relational predicates on nav keys only (since 0.1.147)", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Post>("/api/posts");
      void c.query({ filter: { author: { $some: { name: "x" } }, tags: { $none: {} } } });
      void c.count({ filter: { $or: [{ title: "a" }, { author: { $none: {} } }] } });
      void c.pages({ filter: { tags: { $some: { label: "bug" } } } });
      // @ts-expect-error — `title` is not a navigation relation
      void c.query({ filter: { title: { $some: {} } } });
      // @ts-expect-error — unknown key
      void c.query({ filter: { nope: { $some: {} } } });
    }
  });

  it("rows carry optional $actions / $disabledReasons", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Post>("/api/posts");
      const rows = c.query({ controls: { $actions: true } as const });
      type Row = Awaited<typeof rows>[number];
      expectTypeOf<Row["$actions"]>().toEqualTypeOf<string[] | undefined>();
      expectTypeOf<Row["$disabledReasons"]>().toEqualTypeOf<Record<string, string> | undefined>();
    }
  });

  it("Client<T, D>: $select accepts the declared decorations; rows carry them as optional (since 0.1.148)", () => {
    if (!shouldRun()) {
      interface PostDecorations {
        unreadCount?: number;
        ownerName?: string;
      }
      const c = new Client<typeof Post, PostDecorations>("/api/posts");
      void c.query({ controls: { $select: ["title", "ownerName"] } });
      void c.query({ controls: { $select: { unreadCount: 1, title: 1 } } });
      void c.pages({ controls: { $select: ["unreadCount"] } }, 1, 5);
      void c.one(1, { controls: { $select: ["ownerName"] } });
      void c.geoSearch([0, 0], { controls: { $select: ["unreadCount"] } });
      // @ts-expect-error — neither an own field nor a declared decoration
      void c.query({ controls: { $select: ["nope"] } });
      // filters stay over the own fields: a decoration is display-only
      // @ts-expect-error — `unreadCount` is not an own field
      void c.query({ filter: { unreadCount: 1 } });

      const rows = c.query({ controls: { $select: ["ownerName"] } });
      type Row = Awaited<typeof rows>[number];
      expectTypeOf<Row["ownerName"]>().toEqualTypeOf<string | undefined>();
      expectTypeOf<Row["unreadCount"]>().toEqualTypeOf<number | undefined>();
      expectTypeOf<Row>().toHaveProperty("title");

      const one = c.one(1);
      type OneRow = NonNullable<Awaited<typeof one>>;
      expectTypeOf<OneRow["ownerName"]>().toEqualTypeOf<string | undefined>();

      // Without D nothing changes: no decoration keys.
      const plain = new Client<typeof Post>("/api/posts");
      // @ts-expect-error — no declared decorations
      void plain.query({ controls: { $select: ["ownerName"] } });
    }
  });

  it("meta() carries the declared decorations (since 0.1.148)", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Post>("/api/posts");
      const meta = c.meta();
      type Meta = Awaited<typeof meta>;
      expectTypeOf<Meta["decorations"]>().not.toEqualTypeOf<never>();
      expectTypeOf<NonNullable<Meta["fields"][string]["decoration"]>>().toEqualTypeOf<true>();
    }
  });
});

// Non-inlinable false guard — keeps the body type-checked but unreachable at
// runtime, so `fetch` is never invoked from these tests.
function shouldRun(): true {
  return true;
}
