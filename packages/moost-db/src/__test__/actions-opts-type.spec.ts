import { describe, it, expectTypeOf } from "vite-plus/test";
import type { AtscriptDbTable, TDbActionInfo } from "@atscript/db";

import type { DbActionOpts } from "../actions/types";

/**
 * `DbActionOpts<TRow, R>` mirrors `TDbActionInfo` for the structural fields,
 * EXCEPT `disabled` and `requiredFields` which differ in shape between
 * decorator opts (function / dev-supplied) and the wire (string / forwarded).
 * Plus four moost-db-only fields: `disabled`, `requiredFields`,
 * `onDisabledRows`, `table`.
 *
 * When `TRow = unknown` (no decorator generic), the gate options are loose
 * (any string[] for requiredFields, any[] for disabled rows). When `TRow`
 * is provided, the per-call narrowing kicks in via `Pick<FlatOf<TRow>, R[number]>`.
 */

describe("DbActionOpts type derivation", () => {
  it("structural fields mirror TDbActionInfo (excluding owned framework fields)", () => {
    type Structural = Partial<
      Omit<TDbActionInfo, "name" | "level" | "processor" | "value" | "disabled" | "requiredFields">
    >;
    expectTypeOf<DbActionOpts>().toMatchTypeOf<Structural>();
  });

  it("disabled (loose, TRow=unknown) is a batch function (any[] → boolean[])", () => {
    type DisabledField = NonNullable<DbActionOpts["disabled"]>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expectTypeOf<DisabledField>().toEqualTypeOf<(rows: any[]) => boolean[]>();
  });

  it("requiredFields (loose, TRow=unknown) is plain string[]", () => {
    type RF = NonNullable<DbActionOpts["requiredFields"]>;
    expectTypeOf<RF>().toEqualTypeOf<string[]>();
  });

  it("onDisabledRows is the literal union 'reject' | 'skip'", () => {
    type Mode = NonNullable<DbActionOpts["onDisabledRows"]>;
    expectTypeOf<Mode>().toEqualTypeOf<"reject" | "skip">();
  });

  it("table is an AtscriptDbTable", () => {
    type Tbl = NonNullable<DbActionOpts["table"]>;
    expectTypeOf<Tbl>().toMatchTypeOf<AtscriptDbTable<any>>();
  });

  it("shortcut is an optional string (mirrors TDbActionInfo.shortcut)", () => {
    expectTypeOf<DbActionOpts["shortcut"]>().toEqualTypeOf<string | undefined>();
  });

  it("promptText accepts string | [string, string] (mirrors TDbActionInfo.promptText)", () => {
    expectTypeOf<DbActionOpts["promptText"]>().toEqualTypeOf<
      string | [string, string] | undefined
    >();
  });

  it("name, level, processor, value are NOT keys of DbActionOpts", () => {
    expectTypeOf<keyof DbActionOpts>().not.toEqualTypeOf<"name">();
    expectTypeOf<"name" extends keyof DbActionOpts ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<"level" extends keyof DbActionOpts ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<"processor" extends keyof DbActionOpts ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<"value" extends keyof DbActionOpts ? true : false>().toEqualTypeOf<false>();
  });
});
