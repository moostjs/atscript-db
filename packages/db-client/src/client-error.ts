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

/**
 * Wire-body shape for `ActionDisabledError` responses (HTTP 409). Extends
 * the base `ServerError` envelope with a `name` discriminator, the action
 * name, and the offending identifier(s). The bridge between `@atscript/moost-db`'s
 * server-side error and this typed client-side subclass is the wire JSON
 * body — neither package depends on the other.
 */
export interface ActionDisabledErrorBody extends ServerError {
  name: "ActionDisabledError";
  action: string;
  id?: Record<string, unknown>;
  ids?: Record<string, unknown>[];
}

/**
 * Typed marker thrown by `Client._send` when the server response body's
 * `name === 'ActionDisabledError'`. The transport / status / base body are
 * identical to a generic `ClientError`; this subclass adds typed accessors
 * so consumers can write `catch (e) { if (e instanceof ActionDisabledError) … }`
 * to access `action` / `id` / `ids` without indexing into `body`.
 */
export class ActionDisabledError extends ClientError {
  override name = "ActionDisabledError";

  /** The `@DbAction` name that rejected the request. */
  get action(): string {
    return (this.body as ActionDisabledErrorBody).action;
  }

  /** Present only for `'row'`-level rejections. */
  get id(): Record<string, unknown> | undefined {
    return (this.body as ActionDisabledErrorBody).id;
  }

  /** Present only for `'rows'`-level rejections (full list of failing IDs). */
  get ids(): Record<string, unknown>[] | undefined {
    return (this.body as ActionDisabledErrorBody).ids;
  }
}

/**
 * Wire-body shape for 409 OCC `version_mismatch` responses. Extends the base
 * `ServerError` envelope with a `kind` discriminator and the row's current
 * server-side version. The bridge between `@atscript/moost-db`'s server-side
 * `_disambiguateMismatch` and this typed client-side subclass is the wire
 * JSON body — neither package depends on the other.
 */
export interface VersionMismatchErrorBody extends ServerError {
  kind: "version_mismatch";
  currentVersion: number;
}

/**
 * Typed marker thrown by `Client._send` when the server response body's
 * `kind === 'version_mismatch'`. The transport / status / base body are
 * identical to a generic `ClientError`; this subclass adds a typed
 * `currentVersion` accessor so consumers can write
 * `catch (e) { if (e instanceof VersionMismatchError) … }` without casting.
 */
export class VersionMismatchError extends ClientError {
  override name = "VersionMismatchError";

  /** Row's current server-side version — clients refresh + retry against it. */
  get currentVersion(): number {
    return (this.body as VersionMismatchErrorBody).currentVersion;
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
