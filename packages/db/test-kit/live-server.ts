/**
 * What the PostgreSQL / MySQL live suites share about their server: the admin
 * URL (the first of `env` that is set, else `fallback`), a database's URL on
 * it, and redaction. Nothing a live helper reports may carry the connection
 * string, the host, the user or the password — a driver error can serialize
 * its whole config, so it is never rethrown as is: {@link TLiveServer.error}
 * keeps the redacted message only.
 *
 * Each adapter's `__test__/live-server.ts` adds the driver side (admin
 * statements, recreating a database).
 */
export interface TLiveServer {
  /** The admin connection URL. */
  readonly url: string;
  /**
   * `url` with `database` as its path (`""`: no database).
   * @throws a redacted `Error` when `url` is not a URL
   */
  dbUrl(database: string): string;
  /** `text` with the URL, host, user and password replaced by placeholders. */
  redact(text: string): string;
  /** An `Error` of `context` plus the redacted message of an `Error` `cause` (none of its properties). */
  error(context: string, cause?: unknown): Error;
}

/** `value` percent-decoded — as is when it is not valid percent-encoding (a literal `%`). */
function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function liveServer(env: readonly string[], fallback: string): TLiveServer {
  const name = env.find((key) => process.env[key]);
  const url = (name && process.env[name]) || fallback;
  const secrets: Array<[string, string]> = [[url, "<server-url>"]];
  try {
    const parsed = new URL(url);
    for (const [value, mask, min] of [
      [parsed.password, "<password>", 1],
      [parsed.username, "<user>", 3],
      [parsed.hostname, "<host>", 3],
    ] as const) {
      // a one- or two-letter user / host would mask every such letter pair
      if (value.length >= min) secrets.push([value, mask], [decoded(value), mask]);
    }
  } catch {
    // not a URL: only the raw string is masked (and `dbUrl` throws)
  }
  // longest first, so a password containing the user name is masked whole
  secrets.sort((a, b) => b[0].length - a[0].length);
  const redact = (text: string) =>
    secrets.reduce((out, [secret, mask]) => out.split(secret).join(mask), text);
  const error = (context: string, cause?: unknown) => {
    const message = cause instanceof Error ? cause.message : "";
    return new Error(message ? `${context}: ${redact(message)}` : context);
  };
  return {
    url,
    redact,
    error,
    dbUrl(database) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        // Node's ERR_INVALID_URL carries the input — never let it surface
        throw error(`${name ?? "the fallback server URL"} is not a valid URL`);
      }
      parsed.pathname = database ? `/${database}` : "";
      return parsed.toString();
    },
  };
}
