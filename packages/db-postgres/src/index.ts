import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "./postgres-adapter";
import { PgDriver } from "./pg-driver";
import type { TPostgresAdapterOptions } from "./types";

export { PostgresAdapter } from "./postgres-adapter";
export { PgDriver } from "./pg-driver";
export type { TPgDriverOptions } from "./pg-driver";
// NOTE: the build-time plugin (PostgresPlugin) is deliberately NOT re-exported here.
// It lives on the dedicated './plugin' subpath only: the plugin imports
// @atscript/core (the compiler, which carries rolldown + its native binding),
// so re-exporting it from this RUNTIME entry drags the whole compiler into
// every consumer's server bundle — and crashes prod containers that lack the
// platform-specific @rolldown/binding-* package at runtime.
export { buildWhere } from "./filter-builder";
export type { TSqlFragment } from "./filter-builder";
export type { TPgDriver, TPgRunResult, TPgConnection, TPostgresAdapterOptions } from "./types";

/**
 * Creates a {@link DbSpace} backed by a PostgreSQL connection pool.
 *
 * @param uri - PostgreSQL connection URI (e.g., `postgresql://user@localhost:5432/mydb`)
 * @param options - Additional pool options passed to pg. `textSearchConfigs`
 *   (not a pool option, since 0.1.175) maps a fulltext language to a text
 *   search configuration ({@link TPostgresAdapterOptions}).
 * @returns A `DbSpace` that creates `PostgresAdapter` instances per table.
 */
export function createAdapter(
  uri: string,
  options?: Record<string, unknown> & TPostgresAdapterOptions,
): DbSpace {
  const { textSearchConfigs, ...pool } = options ?? {};
  const driver = new PgDriver({ connectionString: uri, ...pool } as any);
  const adapterOptions: TPostgresAdapterOptions = { textSearchConfigs };
  return new DbSpace(() => new PostgresAdapter(driver, adapterOptions), {
    onClose: () => driver.close(),
  });
}
