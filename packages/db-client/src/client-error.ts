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

/** Thrown by `Client.action()` when the action name is not present in `/meta`. */
export class ActionNotFoundError extends Error {
  override name = "ActionNotFoundError";
  constructor(public readonly action: string) {
    super(`Action "${action}" is not declared on this controller`);
  }
}

/**
 * Thrown by `Client.action()` for actions that cannot be invoked through
 * the client — currently `processor: 'custom'` (UI-dispatched events,
 * which the application is responsible for handling) and `processor: 'navigate'`
 * when no browser environment and no `navigate` option are configured.
 */
export class ActionUnsupportedError extends Error {
  override name = "ActionUnsupportedError";
  constructor(
    public readonly action: string,
    public readonly processor: string,
    message: string,
  ) {
    super(message);
  }
}
