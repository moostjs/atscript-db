import { DbSpace } from "@atscript/db";

import { MemoryAdapter } from "./memory-adapter";

// Public adapter surface: `MemoryAdapter`, `MemoryProviderFn`, `setMemoryProvider`.
export * from "./memory-adapter";

// The reusable in-memory query engine, re-exported BY NAME (never `export *`)
// so its internal dot-path helpers stay private:
// - `buildMemoryPredicate` (from `memory-filter`) — the JS-native
//   `(filter) => (row) => boolean` compiler, the parallel to db-mongo's exported
//   `buildMongoFilter`. Its module also declares `getPath`/`hasPath`/`valuesEqual`,
//   which are internals — a blanket `export *` would leak them.
// - `sortRows` / `projectRow` (from `memory-engine`) — the pure `$sort` and
//   `$select` engine the `MemoryAdapter` delegates to. Their module also declares
//   `compareLeaves`/`setPath`/`deletePath`, likewise kept internal by naming.
// Together these three are the whole engine a non-adapter consumer needs.
export { buildMemoryPredicate } from "./memory-filter";
export { sortRows, projectRow } from "./memory-engine";

/**
 * Creates a {@link DbSpace} backed by an in-memory {@link MemoryAdapter}.
 *
 * Tables default to STORED mode (an instance-level `Map`). To make one table
 * read-only and read-through from a runtime closure, call `setMemoryProvider`
 * (re-exported from {@link ./memory-adapter}) on the space AFTER the table's
 * adapter has been built.
 */
export function createAdapter(): DbSpace {
  return new DbSpace(() => new MemoryAdapter());
}
