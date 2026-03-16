import { DbSpace } from "@atscript/db";
import { BetterSqlite3Driver } from "./better-sqlite3-driver";
import { SqliteAdapter } from "./sqlite-adapter";

export { SqliteAdapter } from "./sqlite-adapter";
export { BetterSqlite3Driver } from "./better-sqlite3-driver";
export { buildWhere } from "./filter-builder";
export type { TSqlFragment } from "./filter-builder";
export type { TSqliteDriver, TSqliteRunResult } from "./types";

export function createAdapter(connection: string, options?: Record<string, unknown>): DbSpace {
  const driver = new BetterSqlite3Driver(connection, options);
  return new DbSpace(() => new SqliteAdapter(driver));
}
