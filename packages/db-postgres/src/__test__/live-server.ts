import { liveServer } from "../../../db/test-kit/live-server";

/**
 * The live PostgreSQL the `*.live.spec.ts` suites run against: an admin
 * connection from `ATSCRIPT_PG_TEST_URL` (or `POSTGRES_TEST_URI`), else a
 * local server. Each suite creates and drops its own database. Helpers never
 * throw a driver error as is, and never print the URL — see `liveServer`.
 */
export const pgServer = liveServer(
  ["ATSCRIPT_PG_TEST_URL", "POSTGRES_TEST_URI"],
  "postgresql://postgres:test@127.0.0.1:54371/postgres",
);

interface TAdminOptions {
  params?: unknown[];
  /** Run in this database instead of the admin URL's. */
  database?: string;
  connectTimeoutMs?: number;
}

/** One statement over a fresh admin connection. @throws a redacted `Error` */
async function run(sql: string, opts: TAdminOptions = {}): Promise<void> {
  try {
    const { Client } = (await import("pg")).default;
    const client = new Client({
      connectionString: opts.database ? pgServer.dbUrl(opts.database) : pgServer.url,
      // a short connect timeout only for the reachability probe — a slow (remote)
      // server must not make a setup statement fail
      connectionTimeoutMillis: opts.connectTimeoutMs ?? 15_000,
    });
    await client.connect();
    try {
      await client.query(sql, opts.params);
    } finally {
      await client.end();
    }
  } catch (error) {
    throw pgServer.error("PostgreSQL admin statement failed", error);
  }
}

/** {@link run}, answering whether it succeeded. */
export function pgAdmin(sql: string, opts?: TAdminOptions): Promise<boolean> {
  return run(sql, opts).then(
    () => true,
    () => false,
  );
}

/** Whether the live server answers; suites `describe.skipIf(!reachable)`. */
export function pgReachable(): Promise<boolean> {
  return pgAdmin("SELECT 1", { connectTimeoutMs: 5000 });
}

/** `DROP DATABASE IF EXISTS` (`WITH (FORCE)`: terminating its sessions); best effort. */
export async function dropPgDatabase(database: string, opts?: { force?: boolean }): Promise<void> {
  await pgAdmin(`DROP DATABASE IF EXISTS "${database}"${opts?.force ? " WITH (FORCE)" : ""}`);
}

/**
 * A fresh, empty `database` (dropped first, see {@link dropPgDatabase});
 * its connection URL.
 * @throws a redacted `Error` when it cannot be created
 */
export async function recreatePgDatabase(
  database: string,
  opts?: { force?: boolean },
): Promise<string> {
  await dropPgDatabase(database, opts);
  await run(`CREATE DATABASE "${database}"`);
  return pgServer.dbUrl(database);
}
