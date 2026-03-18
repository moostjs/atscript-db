import type { ServerError } from "./types";

/**
 * Error thrown by `Client` when the server responds with a non-2xx status code.
 * Captures the HTTP status and the structured error body from moost-db.
 */
export class ClientError extends Error {
  override name = "ClientError";

  constructor(
    /** HTTP status code (e.g. 400, 404, 409, 500). */
    public readonly status: number,
    /** Structured error response from the server. */
    public readonly body: ServerError,
  ) {
    super(body.message || `HTTP ${status}`);
  }

  /** Shortcut to structured validation/DB errors from the server. */
  get errors() {
    return this.body.errors ?? [];
  }
}
