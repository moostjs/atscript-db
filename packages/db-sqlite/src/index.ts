import { DbSpace } from "@atscript/db";
import { BetterSqlite3Driver, type TBetterSqlite3DriverOptions } from "./better-sqlite3-driver";
import { SqliteAdapter } from "./sqlite-adapter";
import type { SqliteAdapterOptions } from "./tx-gate";

export { SqliteAdapter } from "./sqlite-adapter";
export { BetterSqlite3Driver } from "./better-sqlite3-driver";
export type { TBetterSqlite3DriverOptions } from "./better-sqlite3-driver";
export { buildWhere } from "./filter-builder";
export type { TSqlFragment } from "./filter-builder";
export type { TSqliteDriver, TSqliteRunResult } from "./types";
export { SqliteTxGate, SqliteTxState, getSqliteTxGate } from "./tx-gate";
export type { SqliteAdapterOptions, SqliteTxWaitOptions } from "./tx-gate";

/** `createAdapter` options: driver options plus the transaction-gate options (since 0.1.128). */
export type TCreateSqliteAdapterOptions = TBetterSqlite3DriverOptions & SqliteAdapterOptions;

export function createAdapter(connection: string, options?: TCreateSqliteAdapterOptions): DbSpace {
  const { transactionWaitTimeoutMs, transactionWaitWarnMs, ...driverOptions } = options ?? {};
  const driver = new BetterSqlite3Driver(connection, driverOptions);
  const adapterOptions: SqliteAdapterOptions = { transactionWaitTimeoutMs, transactionWaitWarnMs };
  return new DbSpace(() => new SqliteAdapter(driver, adapterOptions));
}
