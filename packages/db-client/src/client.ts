import { buildUrl } from "@uniqu/url/builder";
import type { AggregateQuery, AggregateResult, Uniquery, UniqueryControls } from "@uniqu/core";
import type {
  TDbActionInfo,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "@atscript/db";

import { ActionNotFoundError, ActionUnsupportedError, ClientError } from "./client-error";
import type { ClientValidator, ValidatorMode } from "./validator";
import type { ClientOptions, DataOf, IdOf, MetaResponse, NavOf, OwnOf, PageResult } from "./types";

type Own<T> = OwnOf<T>;
type Nav<T> = NavOf<T>;
type Data<T> = DataOf<T>;
type Id<T> = IdOf<T>;

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
export class Client<T = Record<string, unknown>> {
  private readonly _path: string;
  private readonly _baseUrl: string;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _headers?: ClientOptions["headers"];
  private readonly _navigate?: ClientOptions["navigate"];
  private _metaPromise?: Promise<MetaResponse>;
  private _validatorPromise?: Promise<ClientValidator>;

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
   */
  async query(query?: Uniquery<Own<T>, Nav<T>>): Promise<Data<T>[]> {
    return this._get("query", query) as Promise<Data<T>[]>;
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
   */
  async pages(query?: Uniquery<Own<T>, Nav<T>>, page = 1, size = 10): Promise<PageResult<Data<T>>> {
    return this._get("pages", {
      ...query,
      controls: { ...query?.controls, $page: page, $size: size },
    } as Uniquery) as Promise<PageResult<Data<T>>>;
  }

  // ── GET /one/:id ───────────────────────────────────────────────────────────

  /**
   * `GET /one/:id` or `GET /one?k1=v1&k2=v2` — single record by primary key.
   *
   * Returns `null` on 404.
   */
  async one(
    id: Id<T>,
    query?: { controls?: UniqueryControls<Own<T>, Nav<T>> },
  ): Promise<Data<T> | null> {
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
      return this._getOrNull(`one${qs ? `?${qs}` : ""}`);
    }

    return this._getOrNull(
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
   * - `'backend'` → POST `pk` (or `pks`) as a JSON body to the action's path
   *   and return the parsed server response. The HTTP method is always POST.
   * - `'navigate'` → for `level: 'row'`, substitute `$1` in `value` with the
   *   PK (URL-encoded; composite PKs are URL-encoded per field and joined
   *   with `/`); for `level: 'rows'` or `'table'`, navigate to `value`
   *   verbatim. The default navigator (browser only) calls
   *   `window.location.assign(url)`. Provide `ClientOptions.navigate` to
   *   integrate with a SPA router.
   * - `'custom'` → throw {@link ActionUnsupportedError}; UI-dispatched events
   *   are the application's responsibility, not the client's.
   *
   * Throws {@link ActionNotFoundError} when the action is not present in `/meta`.
   *
   * For `level: 'rows'`, `pk` must be an array. If a non-array is supplied
   * for a `'rows'` action it is wrapped into a single-element array — the
   * server-side `@DbActionPKs()` resolver requires an array body.
   */
  async action(name: string, pk?: unknown): Promise<unknown> {
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
      const url = this._interpolateNavigateUrl(action, pk);
      await this._dispatchNavigate(action, url);
      return undefined;
    }

    const body = this._buildActionBody(action, pk);
    return this._postAction(action, body);
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

  private _buildActionBody(action: TDbActionInfo, pk: unknown): unknown {
    if (action.level === "table") return undefined;
    if (action.level !== "rows") return pk;
    if (Array.isArray(pk)) return pk;
    return pk === undefined ? [] : [pk];
  }

  private _interpolateNavigateUrl(action: TDbActionInfo, pk: unknown): string {
    if (action.level !== "row") return action.value;
    if (pk === undefined) return action.value;
    return action.value.replace(/\$1/g, encodeNavigatePk(pk));
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

  private async _getOrNull(endpoint: string): Promise<Data<T> | null> {
    try {
      return (await this._request("GET", endpoint)) as Data<T>;
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
 * Encode a row PK for substitution into a `processor: 'navigate'` URL template.
 * Scalars are URL-encoded directly; composite PK objects have each value
 * URL-encoded and joined with `/` in object-key order (which mirrors
 * `primaryKeys` for the table).
 */
function encodeNavigatePk(pk: unknown): string {
  if (pk === null || pk === undefined) return "";
  const values = typeof pk === "object" ? Object.values(pk as Record<string, unknown>) : [pk];
  return values.map((v) => encodeURIComponent(String(v))).join("/");
}
