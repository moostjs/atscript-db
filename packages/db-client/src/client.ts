import { buildUrl } from "@uniqu/url/builder";
import type { AggregateQuery, AggregateResult, Uniquery, UniqueryControls } from "@uniqu/core";
import type {
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "@atscript/db";

import { ClientError } from "./client-error";
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
  private _metaPromise?: Promise<MetaResponse>;
  private _validatorPromise?: Promise<ClientValidator>;

  constructor(path: string, opts?: ClientOptions) {
    this._path = path.endsWith("/") ? path.slice(0, -1) : path;
    this._baseUrl = opts?.baseUrl ?? "";
    this._fetch = opts?.fetch ?? globalThis.fetch.bind(globalThis);
    this._headers = opts?.headers;
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

    const headers: Record<string, string> = {
      ...(await this._resolveHeaders()),
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await this._fetch(url, init);
    if (!res.ok) {
      let errorBody: Record<string, unknown>;
      try {
        errorBody = (await res.json()) as Record<string, unknown>;
      } catch {
        errorBody = { message: res.statusText, statusCode: res.status };
      }
      throw new ClientError(res.status, errorBody as any);
    }

    return res.json();
  }
}
