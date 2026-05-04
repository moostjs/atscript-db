import { buildUrl } from "@uniqu/url/builder";
import type { AggregateQuery, AggregateResult, Uniquery, UniqueryControls } from "@uniqu/core";
import {
  deserializeAnnotatedType,
  type TAtscriptAnnotatedType,
  type TSerializedAnnotatedType,
} from "@atscript/typescript/utils";
import type {
  TDbActionInfo,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "@atscript/db";

import {
  ActionDisabledError,
  ActionNotFoundError,
  ActionUnsupportedError,
  ClientError,
  type ActionDisabledErrorBody,
} from "./client-error";
import type { ClientValidator, ValidatorMode } from "./validator";
import type {
  AtscriptClientShape,
  ClientOptions,
  ClientResponse,
  DataOf,
  IdOf,
  MetaResponse,
  NavOf,
  OwnOf,
  PageResult,
} from "./types";

type Own<T> = OwnOf<T>;
type Nav<T> = NavOf<T>;
type Data<T> = DataOf<T>;
type Id<T> = IdOf<T>;
type Response<T, Q> = ClientResponse<T, Q>;

/**
 * HTTP client for moost-db REST endpoints.
 *
 * Each method maps 1:1 to a controller endpoint:
 * - `query()` → `GET /query`
 * - `count()` → `GET /query` with `$count`
 * - `aggregate()` → `GET /query` with `$groupBy`
 * - `pages()` → `GET /pages`
 * - `one()`   → `GET /one/:id` or `GET /one?compositeKeys`
 * - `insert()`  → `POST /`
 * - `update()`  → `PATCH /`
 * - `replace()` → `PUT /`
 * - `remove()`  → `DELETE /:id` or `DELETE /?compositeKeys`
 * - `meta()`  → `GET /meta`
 *
 * ```typescript
 * const users = new Client<typeof User>('/api/users')
 * const all = await users.query()
 * const page = await users.pages({ filter: { active: true } }, 1, 20)
 * ```
 */
export class Client<T extends AtscriptClientShape = AtscriptClientShape> {
  private readonly _path: string;
  private readonly _baseUrl: string;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _headers?: ClientOptions["headers"];
  private readonly _navigate?: ClientOptions["navigate"];
  private _metaPromise?: Promise<MetaResponse>;
  private _validatorPromise?: Promise<ClientValidator>;
  /** Cached deserialized form schemas keyed by form name. */
  private _formCache = new Map<string, Promise<TAtscriptAnnotatedType>>();

  constructor(path: string, opts?: ClientOptions) {
    this._path = path.endsWith("/") ? path.slice(0, -1) : path;
    this._baseUrl = opts?.baseUrl ?? "";
    this._fetch = opts?.fetch ?? globalThis.fetch.bind(globalThis);
    this._headers = opts?.headers;
    this._navigate = opts?.navigate;
  }

  // ── GET /query ─────────────────────────────────────────────────────────────

  /**
   * `GET /query` — query records with typed filter, sort, select, and relations.
   *
   * The response type narrows by the literal `$with` array in `query` —
   * relations not listed in `$with` are stripped from the row type.
   */
  async query<Q extends Uniquery<Own<T>, Nav<T>> = Uniquery<Own<T>, Nav<T>>>(
    query?: Q,
  ): Promise<Response<T, Q>[]> {
    return this._get("query", query) as Promise<Response<T, Q>[]>;
  }

  // ── GET /query ($count) ────────────────────────────────────────────────────

  /**
   * `GET /query` with `$count: true` — returns record count.
   */
  async count(query?: { filter?: Uniquery<Own<T>, Nav<T>>["filter"] }): Promise<number> {
    return this._get("query", {
      ...query,
      controls: { $count: true },
    } as Uniquery) as Promise<number>;
  }

  // ── GET /query ($groupBy) ──────────────────────────────────────────────────

  /**
   * `GET /query` with `$groupBy` — aggregate query with typed dimension/measure fields.
   */
  async aggregate<Q extends AggregateQuery<Own<T>>>(
    query: Q,
  ): Promise<
    Q["controls"]["$select"] extends readonly (string | { $fn: string; $field: string })[]
      ? AggregateResult<Own<T>, Q["controls"]["$select"]>[]
      : Record<string, unknown>[]
  > {
    return this._get("query", query as unknown as Uniquery) as Promise<any>;
  }

  // ── GET /pages ─────────────────────────────────────────────────────────────

  /**
   * `GET /pages` — paginated query with typed filter and relations.
   *
   * Response rows narrow by the literal `$with` array — same algebra as
   * {@link query}.
   */
  async pages<Q extends Uniquery<Own<T>, Nav<T>> = Uniquery<Own<T>, Nav<T>>>(
    query?: Q,
    page = 1,
    size = 10,
  ): Promise<PageResult<Response<T, Q>>> {
    return this._get("pages", {
      ...query,
      controls: { ...query?.controls, $page: page, $size: size },
    } as Uniquery) as Promise<PageResult<Response<T, Q>>>;
  }

  // ── GET /one/:id ───────────────────────────────────────────────────────────

  /**
   * `GET /one/:id` or `GET /one?k1=v1&k2=v2` — single record by primary key.
   *
   * Returns `null` on 404. Response narrows by the literal `$with` array in
   * `query.controls` — same algebra as {@link query}.
   */
  async one<
    Q extends { controls?: UniqueryControls<Own<T>, Nav<T>> } = {
      controls?: UniqueryControls<Own<T>, Nav<T>>;
    },
  >(id: Id<T>, query?: Q): Promise<Response<T, Q> | null> {
    const controlStr = query?.controls
      ? buildUrl({ controls: query.controls as UniqueryControls })
      : "";

    if (id !== null && typeof id === "object") {
      const params = this._idToParams(id as Record<string, unknown>);
      if (controlStr) {
        for (const [k, v] of new URLSearchParams(controlStr)) {
          params.set(k, v);
        }
      }
      const qs = params.toString();
      return this._getOrNull<Q>(`one${qs ? `?${qs}` : ""}`);
    }

    return this._getOrNull<Q>(
      `one/${encodeURIComponent(String(id))}${controlStr ? `?${controlStr}` : ""}`,
    );
  }

  // ── POST / ─────────────────────────────────────────────────────────────────

  /**
   * `POST /` — insert one record.
   */
  async insert(data: Partial<Data<T>>): Promise<TDbInsertResult>;
  /**
   * `POST /` — insert many records.
   */
  async insert(data: Partial<Data<T>>[]): Promise<TDbInsertManyResult>;
  async insert(data: Partial<Data<T>> | Partial<Data<T>>[]): Promise<unknown> {
    await this._validateData(data, "insert");
    return this._request("POST", "", data);
  }

  // ── PATCH / ────────────────────────────────────────────────────────────────

  /**
   * `PATCH /` — partial update one or many records by primary key.
   */
  async update(data: Partial<Data<T>> | Partial<Data<T>>[]): Promise<TDbUpdateResult> {
    await this._validateData(data, "patch");
    return this._request("PATCH", "", data) as Promise<TDbUpdateResult>;
  }

  // ── PUT / ──────────────────────────────────────────────────────────────────

  /**
   * `PUT /` — full replace one or many records by primary key.
   */
  async replace(data: Data<T> | Data<T>[]): Promise<TDbUpdateResult> {
    await this._validateData(data, "replace");
    return this._request("PUT", "", data) as Promise<TDbUpdateResult>;
  }

  // ── DELETE /:id ────────────────────────────────────────────────────────────

  /**
   * `DELETE /:id` or `DELETE /?k1=v1&k2=v2` — remove a record by primary key.
   */
  async remove(id: Id<T>): Promise<TDbDeleteResult> {
    if (id !== null && typeof id === "object") {
      return this._request(
        "DELETE",
        `?${this._idToParams(id as Record<string, unknown>).toString()}`,
      ) as Promise<TDbDeleteResult>;
    }
    return this._request("DELETE", encodeURIComponent(String(id))) as Promise<TDbDeleteResult>;
  }

  // ── GET /meta ──────────────────────────────────────────────────────────────

  /**
   * `GET /meta` — table/view metadata (cached after first call).
   */
  async meta(): Promise<MetaResponse> {
    if (!this._metaPromise) {
      this._metaPromise = (this._request("GET", "meta") as Promise<MetaResponse>).catch((err) => {
        this._metaPromise = undefined;
        throw err;
      });
    }
    return this._metaPromise;
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Invoke a declared action by name. Resolves the action descriptor from the
   * cached `/meta` response, then dispatches based on `processor`:
   *
   * - `'backend'` → POST the identifier as a JSON body to the action's path
   *   and return the parsed server response. The HTTP method is always POST.
   * - `'navigate'` → for `level: 'row'`, substitute `$1` in `value` with the
   *   identifier values, walking `meta.preferredId` field order (each value
   *   URL-encoded, compound IDs joined with `/`); for `level: 'rows'` or
   *   `'table'`, navigate to `value` verbatim. The default navigator (browser
   *   only) calls `window.location.assign(url)`. Provide
   *   `ClientOptions.navigate` to integrate with a SPA router.
   * - `'custom'` → throw {@link ActionUnsupportedError}; UI-dispatched events
   *   are the application's responsibility, not the client's.
   *
   * Throws {@link ActionNotFoundError} when the action is not present in `/meta`.
   *
   * **Identifier shape (server contract).** `id` is always an object (single)
   * or array of objects (multi) — never a scalar. Each object's field set
   * must exactly match one legitimate identification on the table (PK or any
   * `@db.index.unique` group). Even single-field PK tables send `{ id: 'abc' }`,
   * not `'abc'`. `level: 'table'` actions take no identifier (`undefined`).
   *
   * The TypeScript signature widens to `Partial<Own<T>>` because the server's
   * exact-match validation cannot be expressed at the type level. Mismatched
   * field sets produce HTTP 400; obvious type errors (scalars, `null`) are
   * caught at compile time when `T` is typed.
   *
   * **Form input.** When the action's `inputForm` field is set, the server
   * expects a structured payload in the envelope's `input` field. Pass it as
   * the third argument; the schema can be fetched ahead of time via
   * {@link getActionForm} to drive a UI form. Body shape on the wire is
   * `{ ids?, input? }` — `ids` carries `id` (object or array per level),
   * `input` carries the form payload.
   *
   * @typeParam R Caller-asserted return shape from the action handler. The
   *              server returns whatever the handler emits (commonly
   *              `{ message?: string, ... }`); the client cannot validate.
   */
  async action<R = unknown>(
    name: string,
    id?: Partial<Own<T>> | Partial<Own<T>>[],
    input?: unknown,
  ): Promise<R> {
    const meta = await this.meta();
    const action = meta.actions.find((a) => a.name === name);
    if (!action) throw new ActionNotFoundError(name);

    if (action.processor === "custom") {
      throw new ActionUnsupportedError(
        name,
        "custom",
        `Action "${name}" has processor "custom" — applications must dispatch custom actions themselves; the client cannot.`,
      );
    }

    if (action.processor === "navigate") {
      const url = this._interpolateNavigateUrl(action, id, meta.preferredId);
      await this._dispatchNavigate(action, url);
      return undefined as R;
    }

    const body = this._buildActionBody(action, id, input);
    return this._postAction(action, body) as Promise<R>;
  }

  /**
   * Fetches and caches the deserialized form schema for an action's
   * `@InputForm()` parameter. Returns `null` when the action has no form
   * declared, or doesn't exist on `/meta`. Callers typically pass the
   * returned annotated type to a form-renderer (e.g. `@atscript/ui` form
   * components) and then submit the collected payload through
   * {@link action}'s `input` argument.
   */
  async getActionForm(actionName: string): Promise<TAtscriptAnnotatedType | null> {
    const meta = await this.meta();
    const action = meta.actions.find((a) => a.name === actionName);
    if (!action?.inputForm) return null;
    return this._loadActionForm(action.inputForm);
  }

  private _loadActionForm(formName: string): Promise<TAtscriptAnnotatedType> {
    let p = this._formCache.get(formName);
    if (!p) {
      p = (
        this._request(
          "GET",
          `meta/form/${encodeURIComponent(formName)}`,
        ) as Promise<TSerializedAnnotatedType>
      )
        .then((schema) => deserializeAnnotatedType(schema))
        .catch((err) => {
          this._formCache.delete(formName);
          throw err;
        });
      this._formCache.set(formName, p);
    }
    return p;
  }

  // ── Validation (client utility) ────────────────────────────────────────────

  /**
   * Returns a lazily-initialized {@link ClientValidator} backed by the `/meta` type.
   * Useful for accessing `flatMap` and `navFields` (e.g. for form generation).
   */
  getValidator(): Promise<ClientValidator> {
    return this._getValidator();
  }

  private async _validateData(data: unknown, mode: ValidatorMode): Promise<void> {
    const validator = await this._getValidator();
    validator.validate(data, mode);
  }

  private _getValidator(): Promise<ClientValidator> {
    if (!this._validatorPromise) {
      this._validatorPromise = Promise.all([this.meta(), import("./validator")])
        .then(([m, { createClientValidator }]) => createClientValidator(m))
        .catch((err) => {
          this._validatorPromise = undefined;
          throw err;
        });
    }
    return this._validatorPromise;
  }

  // ── Action helpers ─────────────────────────────────────────────────────────

  private _buildActionBody(action: TDbActionInfo, id: unknown, input: unknown): unknown {
    const envelope: { ids?: unknown; input?: unknown } = {};
    switch (action.level) {
      case "rows":
        if (id === undefined) {
          envelope.ids = [];
        } else if (!Array.isArray(id)) {
          throw new TypeError(
            `client.action("${action.name}"): rows-level actions require an array of identifier objects; received ${describeShape(id)}.`,
          );
        } else {
          envelope.ids = id;
        }
        break;
      case "row":
        if (id === null || typeof id !== "object" || Array.isArray(id)) {
          throw new TypeError(
            `client.action("${action.name}"): row-level actions require an identifier object; received ${describeShape(id)}.`,
          );
        }
        envelope.ids = id;
        break;
      case "table":
        // Bare table-level action with no input → no body sent at all.
        if (input === undefined) return undefined;
        break;
    }
    if (input !== undefined) envelope.input = input;
    return envelope;
  }

  private _interpolateNavigateUrl(
    action: TDbActionInfo,
    id: unknown,
    preferredId: readonly string[],
  ): string {
    if (action.level !== "row") return action.value;
    if (id === undefined) return action.value;
    if (id === null || typeof id !== "object" || Array.isArray(id)) {
      throw new TypeError(
        `client.action("${action.name}"): row-level navigate actions require an identifier object; received ${describeShape(id)}.`,
      );
    }
    return action.value.replace(
      /\$1/g,
      encodeNavigateId(id as Record<string, unknown>, preferredId),
    );
  }

  private async _dispatchNavigate(action: TDbActionInfo, url: string): Promise<void> {
    if (this._navigate) {
      await this._navigate(url);
      return;
    }
    const loc = (globalThis as { location?: { assign?: (url: string) => void } }).location;
    if (loc?.assign) {
      loc.assign(url);
      return;
    }
    throw new ActionUnsupportedError(
      action.name,
      "navigate",
      `Action "${action.name}" is processor: 'navigate' but no browser is available and no \`navigate\` option was provided to Client.`,
    );
  }

  private async _postAction(action: TDbActionInfo, body: unknown): Promise<unknown> {
    const url = `${this._baseUrl}${action.value}`;
    const init = await this._buildInit("POST", body);
    return this._send(url, init, true);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _idToParams(id: Record<string, unknown>): URLSearchParams {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(id)) {
      params.set(k, String(v));
    }
    return params;
  }

  private async _getOrNull<Q>(endpoint: string): Promise<Response<T, Q> | null> {
    try {
      return (await this._request("GET", endpoint)) as Response<T, Q>;
    } catch (e) {
      if (e instanceof ClientError && e.status === 404) return null;
      throw e;
    }
  }

  private async _get(endpoint: string, query?: Uniquery): Promise<unknown> {
    const qs = query ? buildUrl(query) : "";
    return this._request("GET", `${endpoint}${qs ? `?${qs}` : ""}`);
  }

  private async _resolveHeaders(): Promise<Record<string, string>> {
    if (!this._headers) return {};
    if (typeof this._headers === "function") {
      return await this._headers();
    }
    return this._headers;
  }

  private async _request(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    endpoint: string,
    body?: unknown,
  ): Promise<unknown> {
    const sep = endpoint && !endpoint.startsWith("?") ? "/" : "";
    const url = `${this._baseUrl}${this._path}${sep}${endpoint}`;
    const init = await this._buildInit(method, body);
    return this._send(url, init, false);
  }

  private async _buildInit(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
  ): Promise<RequestInit> {
    const headers: Record<string, string> = { ...(await this._resolveHeaders()) };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return init;
  }

  private async _send(url: string, init: RequestInit, allowEmpty: boolean): Promise<unknown> {
    const res = await this._fetch(url, init);
    if (!res.ok) {
      let errorBody: Record<string, unknown>;
      try {
        errorBody = (await res.json()) as Record<string, unknown>;
      } catch {
        errorBody = { message: res.statusText, statusCode: res.status };
      }
      if (errorBody.name === "ActionDisabledError") {
        throw new ActionDisabledError(res.status, errorBody as unknown as ActionDisabledErrorBody);
      }
      throw new ClientError(res.status, errorBody as never);
    }
    if (!allowEmpty) return res.json();
    if (res.status === 204 || res.headers.get("content-length") === "0") return undefined;
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
}

/**
 * Render a single identifier field for substitution into a navigate-URL
 * template or human-readable string. `null` / `undefined` collapse to `""`
 * (NOT the literal `"undefined"` / `"null"` that `String()` would produce).
 */
export function formatIdentifierField(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

/**
 * Render a row identifier as a `/`-joined string in `preferredId`
 * declaration order — NOT object-key insertion order (which is unstable
 * across callers). Raw form, no URL-encoding; for prompt text, error
 * messages, log lines, etc.
 */
export function formatIdentifier(
  id: Record<string, unknown> | undefined,
  preferredId: readonly string[],
): string {
  if (id === undefined) return "";
  return preferredId.map((f) => formatIdentifierField(id[f])).join("/");
}

/**
 * URL-encoded form of `formatIdentifier` — for `processor: 'navigate'`
 * `$1` substitution. Each field is `encodeURIComponent`'d, then joined
 * with a literal `/`. Missing fields render as empty segments (e.g.
 * `acme//jane`), not the literal `"undefined"`.
 */
export function encodeNavigateId(
  id: Record<string, unknown>,
  preferredId: readonly string[],
): string {
  return preferredId.map((f) => encodeURIComponent(formatIdentifierField(id[f]))).join("/");
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
