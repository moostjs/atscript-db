import { describe, it, expectTypeOf } from "vite-plus/test";
import type { TDbActionInfo } from "@atscript/db";

import type { DbActionOpts } from "../actions/types";

/**
 * `DbActionOpts` MUST stay structurally derived from `TDbActionInfo`. Adding
 * a field to `TDbActionInfo` should automatically propagate; renaming a field
 * should produce a type error in this assertion.
 */

describe("DbActionOpts type derivation", () => {
  it("equals Partial<Omit<TDbActionInfo, 'name' | 'level' | 'processor' | 'value'>>", () => {
    type Expected = Partial<Omit<TDbActionInfo, "name" | "level" | "processor" | "value">>;
    expectTypeOf<DbActionOpts>().toEqualTypeOf<Expected>();
  });
});
