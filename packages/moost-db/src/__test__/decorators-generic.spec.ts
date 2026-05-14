import { describe, it, expectTypeOf } from "vite-plus/test";
import type { AtscriptDbTable, AtscriptDbReadable } from "@atscript/db";

import { TableController, ReadableController } from "../decorators";

/**
 * Regression coverage for BUGS.md BUG-2: `TableController` and
 * `ReadableController` used to accept a bare `AtscriptDbTable` /
 * `AtscriptDbReadable` (no generic). For a model carrying `@db.rel.to` /
 * `@db.rel.from` nav props, the table's `NavType` becomes narrower than the
 * bare default, and contravariant uses of `NavType` (e.g. inside `count()`)
 * break structural assignability — so `@TableController(myTable)` failed to
 * type-check whenever the table had relations.
 *
 * The fix makes both decorators generic over the table/readable, accepting
 * any specific instance. These compile-time assertions pin that contract:
 * reverting the generic on either decorator fails type-checking here.
 */

// Fabricate a table type with non-empty NavType (`{ comments: Comment[] }`)
// to mirror the shape produced for a model with `@db.rel.to` annotations.
type TableWithNavProps = AtscriptDbTable<
  // T — phantom annotated type, not used structurally below
  any,
  // DataType
  { id: string },
  // FlatType
  { id: string },
  // A — adapter
  any,
  // IdType
  string,
  // OwnProps
  { id: string },
  // NavType — non-empty, the shape that caused BUG-2
  { comments: Array<{ id: string }> }
>;

type ReadableWithNavProps = AtscriptDbReadable<
  any,
  { id: string },
  { id: string },
  any,
  string,
  { id: string },
  { comments: Array<{ id: string }> }
>;

describe("TableController — accepts tables with non-empty NavType", () => {
  it("compiles when given a typed table with nav props (BUG-2 regression)", () => {
    // The whole point is that this signature accepts the narrower table type.
    // No runtime call is made; the assertion is the call-signature compatibility.
    expectTypeOf(TableController<TableWithNavProps>)
      .parameter(0)
      .toMatchTypeOf<TableWithNavProps>();
  });
});

describe("ReadableController — accepts readables with non-empty NavType", () => {
  it("compiles when given a typed readable with nav props (BUG-2 regression)", () => {
    expectTypeOf(ReadableController<ReadableWithNavProps>)
      .parameter(0)
      .toMatchTypeOf<ReadableWithNavProps>();
  });
});
