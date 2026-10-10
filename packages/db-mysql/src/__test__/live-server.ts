import { liveServer } from "../../../db/test-kit/live-server";

/**
 * The live MySQL the `*.live.spec.ts` suites run against: an admin connection
 * from `ATSCRIPT_MYSQL_TEST_URL` (or `MYSQL_TEST_URI`), else a local server.
 * Each suite creates and drops its own database(s). Helpers never throw a
 * driver error as is, and never print the URL — see `liveServer`.
 */
export const mysqlServer = liveServer(
  ["ATSCRIPT_MYSQL_TEST_URL", "MYSQL_TEST_URI"],
  "mysql://root:test@127.0.0.1:33071",
);

/** `database`'s connection URL on the live server. */
export const mysqlDbUrl = (database: string): string => mysqlServer.dbUrl(database);

/** One statement over a fresh admin connection (no database). @throws a redacted `Error` */
async function run(sql: string, connectTimeoutMs = 15_000): Promise<void> {
  try {
    const mysql = await import("mysql2/promise");
    // a short connect timeout only for the reachability probe — a slow (remote)
    // server must not make a setup statement fail
    const conn = await mysql.createConnection({
      uri: mysqlServer.dbUrl(""),
      connectTimeout: connectTimeoutMs,
    });
    try {
      await conn.query(sql);
    } finally {
      await conn.end();
    }
  } catch (error) {
    throw mysqlServer.error("MySQL admin statement failed", error);
  }
}

/** {@link run}, answering whether it succeeded. */
export function mysqlAdmin(sql: string): Promise<boolean> {
  return run(sql).then(
    () => true,
    () => false,
  );
}

/** Whether the live server answers; suites `describe.skipIf(!reachable)`. */
export function mysqlReachable(): Promise<boolean> {
  return run("SELECT 1", 5000).then(
    () => true,
    () => false,
  );
}

/** `DROP DATABASE IF EXISTS`; best effort. */
export async function dropMysqlDatabase(database: string): Promise<void> {
  await mysqlAdmin(`DROP DATABASE IF EXISTS \`${database}\``);
}

/**
 * A fresh, empty `database` (dropped first); its connection URL.
 * @throws a redacted `Error` when it cannot be created
 */
export async function recreateMysqlDatabase(database: string): Promise<string> {
  await dropMysqlDatabase(database);
  await run(`CREATE DATABASE \`${database}\``);
  return mysqlDbUrl(database);
}
