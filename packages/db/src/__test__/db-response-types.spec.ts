import { describe, it, expectTypeOf } from "vite-plus/test";

import type { NavPropsOf } from "../types";
import type { AtscriptDbTable } from "../table/db-table";
import type { DbResponse } from "../table/db-readable";
import type { Author } from "./fixtures/rel-author.as";
import type { UsersTable } from "./fixtures/test-table.as";

declare const usersTable: AtscriptDbTable<typeof UsersTable>;
declare const authorTable: AtscriptDbTable<typeof Author>;

type Returns<F extends (...args: any) => any> = Awaited<ReturnType<F>>;

// ── DbResponse alias ────────────────────────────────────────────────────────

describe("DbResponse — type alias", () => {
  it("preserves all fields when the table has no nav props", () => {
    type Q = { filter: { email: string } };
    type Result = DbResponse<UsersTable, NavPropsOf<typeof UsersTable>, Q>;

    expectTypeOf<Result>().toEqualTypeOf<UsersTable>();
    expectTypeOf<Result>().toHaveProperty("email").toEqualTypeOf<string>();
  });

  it("strips nav props when no $with is requested", () => {
    type Q = { filter: { id: number } };
    type Result = DbResponse<Author, NavPropsOf<typeof Author>, Q>;

    expectTypeOf<Result>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<Result>().toHaveProperty("name").toEqualTypeOf<string>();
    expectTypeOf<Result>().not.toHaveProperty("posts");
  });

  it("includes nav props when explicitly requested via $with", () => {
    type Q = { controls: { $with: [{ name: "posts" }] } };
    type Result = DbResponse<Author, NavPropsOf<typeof Author>, Q>;

    expectTypeOf<Result>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<Result>().toHaveProperty("posts");
  });
});

// Per-method assertions are inlined because `expectTypeOf` with a generic `R`
// loses `keyof R` precision — so we can't factor them into a helper.

describe("Reading methods — nav-prop-free table returns full data", () => {
  type Q = { filter: { email: string } };

  it("findOne", () => {
    type R = NonNullable<Returns<typeof usersTable.findOne<Q>>>;
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().toHaveProperty("email").toEqualTypeOf<string>();
    expectTypeOf<R>().toHaveProperty("status").toEqualTypeOf<string>();
  });

  it("findById", () => {
    type R = NonNullable<Returns<typeof usersTable.findById>>;
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().toHaveProperty("email").toEqualTypeOf<string>();
  });

  it("findMany", () => {
    type R = Returns<typeof usersTable.findMany<Q>>[number];
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().toHaveProperty("email").toEqualTypeOf<string>();
  });

  it("findManyWithCount", () => {
    type R = Returns<typeof usersTable.findManyWithCount<Q>>;
    expectTypeOf<R>().toHaveProperty("count").toEqualTypeOf<number>();
    expectTypeOf<R["data"][number]>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R["data"][number]>().toHaveProperty("email").toEqualTypeOf<string>();
  });

  it("search", () => {
    type R = Returns<typeof usersTable.search<Q>>[number];
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().toHaveProperty("email").toEqualTypeOf<string>();
  });

  it("searchWithCount", () => {
    type R = Returns<typeof usersTable.searchWithCount<Q>>;
    expectTypeOf<R>().toHaveProperty("count").toEqualTypeOf<number>();
    expectTypeOf<R["data"][number]>().toHaveProperty("email").toEqualTypeOf<string>();
  });

  it("vectorSearch", () => {
    type R = Returns<typeof usersTable.vectorSearch<Q>>[number];
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().toHaveProperty("email").toEqualTypeOf<string>();
  });

  it("vectorSearchWithCount", () => {
    type R = Returns<typeof usersTable.vectorSearchWithCount<Q>>;
    expectTypeOf<R>().toHaveProperty("count").toEqualTypeOf<number>();
    expectTypeOf<R["data"][number]>().toHaveProperty("email").toEqualTypeOf<string>();
  });
});

describe("Reading methods — strip nav props when $with is omitted", () => {
  type Q = { filter: { id: number } };

  it("findOne", () => {
    type R = NonNullable<Returns<typeof authorTable.findOne<Q>>>;
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().toHaveProperty("name").toEqualTypeOf<string>();
    expectTypeOf<R>().not.toHaveProperty("posts");
  });

  it("findById", () => {
    type R = NonNullable<Returns<typeof authorTable.findById>>;
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().toHaveProperty("name").toEqualTypeOf<string>();
    expectTypeOf<R>().not.toHaveProperty("posts");
  });

  it("findMany", () => {
    type R = Returns<typeof authorTable.findMany<Q>>[number];
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().not.toHaveProperty("posts");
  });

  it("findManyWithCount", () => {
    type R = Returns<typeof authorTable.findManyWithCount<Q>>;
    expectTypeOf<R>().toHaveProperty("count").toEqualTypeOf<number>();
    expectTypeOf<R["data"][number]>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R["data"][number]>().not.toHaveProperty("posts");
  });

  it("search", () => {
    type R = Returns<typeof authorTable.search<Q>>[number];
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().not.toHaveProperty("posts");
  });

  it("searchWithCount", () => {
    type R = Returns<typeof authorTable.searchWithCount<Q>>;
    expectTypeOf<R>().toHaveProperty("count").toEqualTypeOf<number>();
    expectTypeOf<R["data"][number]>().not.toHaveProperty("posts");
  });

  it("vectorSearch", () => {
    type R = Returns<typeof authorTable.vectorSearch<Q>>[number];
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().not.toHaveProperty("posts");
  });

  it("vectorSearchWithCount", () => {
    type R = Returns<typeof authorTable.vectorSearchWithCount<Q>>;
    expectTypeOf<R>().toHaveProperty("count").toEqualTypeOf<number>();
    expectTypeOf<R["data"][number]>().not.toHaveProperty("posts");
  });
});

describe("Reading methods — include requested nav props via $with", () => {
  type Q = { controls: { $with: [{ name: "posts" }] }; filter: {} };

  it("findOne includes the requested nav prop", () => {
    type R = NonNullable<Returns<typeof authorTable.findOne<Q>>>;
    expectTypeOf<R>().toHaveProperty("id").toEqualTypeOf<number>();
    expectTypeOf<R>().toHaveProperty("posts");
  });

  it("findMany includes the requested nav prop", () => {
    type R = Returns<typeof authorTable.findMany<Q>>[number];
    expectTypeOf<R>().toHaveProperty("posts");
  });

  it("findManyWithCount includes the requested nav prop", () => {
    type R = Returns<typeof authorTable.findManyWithCount<Q>>["data"][number];
    expectTypeOf<R>().toHaveProperty("posts");
  });

  it("search includes the requested nav prop", () => {
    type R = Returns<typeof authorTable.search<Q>>[number];
    expectTypeOf<R>().toHaveProperty("posts");
  });

  it("vectorSearch includes the requested nav prop", () => {
    type R = Returns<typeof authorTable.vectorSearch<Q>>[number];
    expectTypeOf<R>().toHaveProperty("posts");
  });
});
