import { describe, it, expectTypeOf } from "vite-plus/test";
import type { TAtscriptDataType } from "@atscript/typescript/utils";

import type { DbPatch, DbRow, FilterExpr, FlatOf, NullableOptional, OwnPropsOf } from "../types";
import type { AtscriptDbReadable } from "../table/db-readable";
import type { AtscriptDbTable } from "../table/db-table";
import type { AtscriptDbView } from "../table/db-view";
import type { GuardSource } from "./fixtures/guard-paths.as";

/**
 * Finding 5 (nullable typing, since 0.1.128): optional columns store SQL NULL /
 * Mongo null and the runtime validator accepts `null` for optional props, but
 * the generated `__flat` / `__ownProps` statics say `T | undefined` only. Layer
 * 2 wraps the readable / view / table generic defaults in `NullableOptional`
 * and types write payloads as `DbPatch` / `DbRow` (null on optional columns),
 * so `{ note: null }` / `{ note: { $ne: null } }` type-check on reads and
 * writes regardless of the generator (Layer 1, atscript follow-up: `| null`
 * in `renderFlatMap`).
 */

type Flat = NullableOptional<FlatOf<typeof GuardSource>>;
type Own = NullableOptional<OwnPropsOf<typeof GuardSource>>;
type Row = TAtscriptDataType<typeof GuardSource>;

declare const readable: AtscriptDbReadable<typeof GuardSource>;
declare const view: AtscriptDbView<typeof GuardSource>;
declare const table: AtscriptDbTable<typeof GuardSource>;

describe("NullableOptional", () => {
  it("adds null to optional props only and is idempotent", () => {
    expectTypeOf<Flat["note"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<Flat["score"]>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<Flat["archived"]>().toEqualTypeOf<boolean | null | undefined>();
    expectTypeOf<Flat["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Flat["id"]>().toEqualTypeOf<number>();
    expectTypeOf<NullableOptional<Flat>>().toEqualTypeOf<Flat>();
    expectTypeOf<keyof Own>().toEqualTypeOf<keyof OwnPropsOf<typeof GuardSource>>();
  });
});

describe("FilterExpr over NullableOptional flat shapes", () => {
  it("accepts null in bare / $eq / $ne / $in positions for optional string, number and boolean props", () => {
    const bare: FilterExpr<Flat> = { note: null, score: null, archived: null };
    const eq: FilterExpr<Flat> = { note: { $eq: null } };
    const ne: FilterExpr<Flat> = { note: { $ne: null }, score: { $ne: null } };
    const inOp: FilterExpr<Flat> = { note: { $in: [null, "x"] } };
    expectTypeOf(bare).toMatchTypeOf<FilterExpr<Flat>>();
    expectTypeOf(eq).toMatchTypeOf<FilterExpr<Flat>>();
    expectTypeOf(ne).toMatchTypeOf<FilterExpr<Flat>>();
    expectTypeOf(inOp).toMatchTypeOf<FilterExpr<Flat>>();
  });

  it("keeps string operators on `string | null` and rejects null on required props", () => {
    const regex: FilterExpr<Flat> = { note: { $regex: /^a/ } };
    const gt: FilterExpr<Flat> = { score: { $gt: 1 } };
    expectTypeOf(regex).toMatchTypeOf<FilterExpr<Flat>>();
    expectTypeOf(gt).toMatchTypeOf<FilterExpr<Flat>>();
    // @ts-expect-error — `title` is required: null is not a valid value
    const bad: FilterExpr<Flat> = { title: null };
    // @ts-expect-error — `id` is required: null is not a valid value
    const badId: FilterExpr<Flat> = { id: { $eq: null } };
    void bad;
    void badId;
  });

  it("records the pre-existing FieldOpsFor distribution weakening (not introduced by NullableOptional)", () => {
    // `FieldOpsFor<V>` distributes over `V = number | undefined` already, so the
    // `undefined` branch yields `{}` and `{ $gt: 'x' }` on a numeric optional
    // prop compiles today. Adding `null` does not change that — do not "fix"
    // it here; it belongs to @uniqu/core.
    const weak: FilterExpr<FlatOf<typeof GuardSource>> = { score: { $gt: "x" as never } };
    const weakNullable: FilterExpr<Flat> = { score: { $gt: "x" as never } };
    expectTypeOf(weak).toMatchTypeOf<FilterExpr<FlatOf<typeof GuardSource>>>();
    expectTypeOf(weakNullable).toMatchTypeOf<FilterExpr<Flat>>();
  });
});

describe("readable / view methods accept null filters through the generic defaults", () => {
  it("findMany / findOne / count on a readable", async () => {
    // Type-only: never executed.
    const run = async () => {
      await readable.findMany({ filter: { note: null } });
      await readable.findMany({
        filter: { score: { $ne: null } },
        controls: { $sort: { note: 1 } },
      });
      await readable.findOne({ filter: { archived: null } });
      await readable.count({ filter: { note: { $in: [null] } } });
      // @ts-expect-error — required prop never accepts null
      await readable.findMany({ filter: { title: null } });
    };
    expectTypeOf(run).returns.resolves.toBeVoid();
  });

  it("findMany on a view", async () => {
    const run = async () => {
      await view.findMany({ filter: { note: null } });
      // @ts-expect-error — required prop never accepts null
      await view.findMany({ filter: { title: null } });
    };
    expectTypeOf(run).returns.resolves.toBeVoid();
  });

  it("reads and writes on a table (the table generic defaults are wrapped too)", async () => {
    const run = async () => {
      await table.findMany({ filter: { note: null } });
      await table.findOne({ filter: { score: { $ne: null } } });
      await table.updateMany({ note: null }, { title: "x" });
      await table.updateOne({ id: 1, note: null });
      await table.replaceOne({ id: 1, title: "t", note: null } as DbRow<Row>);
      // @ts-expect-error — required prop never accepts null
      await table.findMany({ filter: { title: null } });
      // @ts-expect-error — required prop never accepts null in a patch
      await table.updateOne({ id: 1, title: null });
    };
    expectTypeOf(run).returns.resolves.toBeVoid();
  });
});

describe("DbPatch / DbRow write payload types", () => {
  it("DbPatch: every key optional, null on optional columns only", () => {
    const ok: DbPatch<Row> = { id: 1, note: null, score: null };
    const bare: DbPatch<Row> = {};
    expectTypeOf(ok).toMatchTypeOf<DbPatch<Row>>();
    expectTypeOf(bare).toMatchTypeOf<DbPatch<Row>>();
    // @ts-expect-error — `title` is required: null is not a valid value
    const bad: DbPatch<Row> = { id: 1, title: null };
    void bad;
  });

  it("DbRow: required keys stay required, null on optional columns only", () => {
    const ok: DbRow<Row> = { id: 1, title: "t", note: null } as DbRow<Row>;
    expectTypeOf(ok).toMatchTypeOf<DbRow<Row>>();
    // @ts-expect-error — `title` is required: null is not a valid value
    const bad: DbRow<Row> = { id: 1, title: null } as { id: number; title: null };
    void bad;
  });
});
