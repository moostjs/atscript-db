import { describe, it, expectTypeOf } from "vite-plus/test";
import type { AtscriptDbTable, TDbActionInfo } from "@atscript/db";

import type { DbActionOpts } from "../actions/types";

/**
 * `DbActionOpts<TRow>` mirrors `TDbActionInfo` for the structural fields,
 * EXCEPT `disabled` and `requiredFields` which differ in shape between
 * decorator opts (function / dev-supplied) and the wire (string / forwarded).
 * Plus four moost-db-only fields: `disabled`, `requiredFields`,
 * `onDisabledRows`, `table`.
 *
 * Renaming a field on `TDbActionInfo` (other than the four overridden ones)
 * SHOULD produce a type error in these assertions.
 */

describe("DbActionOpts type derivation", () => {
  it("structural fields mirror TDbActionInfo (excluding owned framework fields)", () => {
    type Structural = Partial<
      Omit<TDbActionInfo, "name" | "level" | "processor" | "value" | "disabled" | "requiredFields">
    >;
    // The base `Partial<Omit<…>>` portion is structurally a subset of
    // `DbActionOpts` — every key in `Structural` must be assignable.
    expectTypeOf<DbActionOpts>().toMatchTypeOf<Structural>();
  });

  it("disabled is a function (TRow → boolean), not a string", () => {
    type DisabledField = NonNullable<DbActionOpts<{ status: string }>["disabled"]>;
    expectTypeOf<DisabledField>().toEqualTypeOf<(row: { status: string }) => boolean>();
  });

  it("requiredFields is plain string[] in v1", () => {
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
