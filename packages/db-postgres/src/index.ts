import { DbSpace } from "@atscript/db";

import { PostgresAdapter } from "./postgres-adapter";
import { PgDriver } from "./pg-driver";

export { PostgresAdapter } from "./postgres-adapter";
export { PgDriver } from "./pg-driver";
export { PostgresPlugin } from "./plugin/index";
export { buildWhere } from "./filter-builder";
export type { TSqlFragment } from "./filter-builder";
export type { TPgDriver, TPgRunResult, TPgConnection } from "./types";

/**
 * Creates a {@link DbSpace} backed by a PostgreSQL connection pool.
 *
 * @param uri - PostgreSQL connection URI (e.g., `postgresql://user@localhost:5432/mydb`)
 * @param options - Additional pool options passed to pg.
 * @returns A `DbSpace` that creates `PostgresAdapter` instances per table.
 */
export function createAdapter(uri: string, options?: Record<string, unknown>): DbSpace {
  const driver = new PgDriver({ connectionString: uri, ...options } as any);
  return new DbSpace(() => new PostgresAdapter(driver));
}
