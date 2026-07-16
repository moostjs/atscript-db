/**
 * Test fixtures for `@atscript/moost-db` — importable via
 * `@atscript/moost-db/testing`.
 *
 * The token-based controller binding (`@TableController(Model)`) resolves its
 * `DbSpace` from the ambient registry at instantiation time, so tests no
 * longer need to connect a database before importing controller modules —
 * they just register a space first:
 *
 * ```ts
 * import { beforeAll } from "vite-plus/test"
 * import { provideTestDbSpace, resetTestDbSpaces } from "@atscript/moost-db/testing"
 *
 * beforeAll(() => {
 *   provideTestDbSpace([User, Post])   // in-memory space, registered as "default"
 * })
 * afterAll(() => resetTestDbSpaces())
 * ```
 */
import type { DbSpace } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { provideDbSpace } from "./db-space-registry";

/** Clears the ambient space registry. Call in `afterAll`/`afterEach` teardown. */
export { clearDbSpaces as resetTestDbSpaces } from "./db-space-registry";

export interface TTestDbSpaceOptions {
  /** Registry name — defaults to the default space. */
  name?: string;
  /** Use an existing space instead of creating an in-memory one. */
  space?: DbSpace;
}

/**
 * Creates an in-memory {@link DbSpace} (via `@atscript/db-memory`), registers
 * it in the ambient registry for token-based controller binding, and
 * pre-creates tables/views for the given models so relations and FK lookups
 * resolve. Returns the space for direct seeding/assertions.
 *
 * No schema sync is needed — the memory adapter has no DDL.
 */
export function provideTestDbSpace(
  models?: readonly TAtscriptAnnotatedType[],
  options?: TTestDbSpaceOptions,
): DbSpace {
  const space = options?.space ?? createAdapter();
  provideDbSpace(space, options?.name);
  for (const model of models ?? []) {
    space.get(model);
  }
  return space;
}
