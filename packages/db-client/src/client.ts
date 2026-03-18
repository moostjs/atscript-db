import { buildUrl } from "@uniqu/url/builder";
import type { Uniquery, UniqueryControls, AggregateQuery } from "@uniqu/core";

import { ClientError } from "./client-error";
import type {
  ClientOptions,
  DataOf,
  DbInterface,
  DeleteResult,
  IdOf,
  InsertManyResult,
  InsertResult,
  MetaResponse,
  NavOf,
  OwnOf,
  PagesResponse,
  UpdateResult,
} from "./types";

/**
 * Browser-compatible HTTP client for moost-db REST endpoints.
 *
 * Two usage modes (same class, different generic):
 * ```typescript
 * // Untyped — broad Record<string, unknown> typing
 * const users = new Client('/db/tables/users')
 *
 * // Type-safe — Atscript type as generic parameter
 * const users = new Client<typeof User>('/db/tables/users')
 * ```
 */
export class Client<T = Record<string, unknown>> implements DbInterface<T> {
  private readonly _path: string;
  private readonly _baseUrl: string;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _headers?: ClientOptions["headers"];
  private _metaPromise?: Promise<MetaResponse>;

  constructor(path: string, opts?: ClientOptions) {
    // Normalize path: strip trailing slash
    this._path = path.endsWith("/") ? path.slice(0, -1) : path;
    this._baseUrl = opts?.baseUrl ?? "";
    this._fetch = opts?.fetch ?? globalThis.fetch.bind(globalThis);
    this._headers = opts?.headers;
  }

  // ── Read Methods ──────────────────────────────────────────────────────────

  async findOne(query: Uniquery<OwnOf<T>, NavOf<T>>): Promise<DataOf<T> | null> {
    const controls = { ...query?.controls, $limit: 1 };
    const results = (await this._get("query", { ...query, controls })) as DataOf<T>[];
    return results[0] ?? null;
  }

  async findMany(query?: Uniquery<OwnOf<T>, NavOf<T>>): Promise<DataOf<T>[]> {
    return this._get("query", query) as Promise<DataOf<T>[]>;
  }

  async findById(
    id: IdOf<T>,
    query?: { controls?: UniqueryControls<OwnOf<T>, NavOf<T>> },
  ): Promise<DataOf<T> | null> {
    if (id !== null && typeof id === "object") {
      // Composite PK — send as query params
      const params = this._idToParams(id as Record<string, unknown>);
      if (query?.controls) {
        const controlStr = buildUrl({ controls: query.controls as UniqueryControls });
        if (controlStr) {
          for (const [k, v] of new URLSearchParams(controlStr)) {
            params.set(k, v);
          }
        }
      }
      const qs = params.toString();
      try {
        return (await this._request("GET", `one${qs ? `?${qs}` : ""}`)) as DataOf<T>;
      } catch (e) {
        if (e instanceof ClientError && e.status === 404) return null;
        throw e;
      }
    }
    // Single PK
    const controlStr = query?.controls
      ? buildUrl({ controls: query.controls as UniqueryControls })
      : "";
    try {
      return (await this._request(
        "GET",
        `one/${encodeURIComponent(String(id))}${controlStr ? `?${controlStr}` : ""}`,
      )) as DataOf<T>;
    } catch (e) {
      if (e instanceof ClientError && e.status === 404) return null;
      throw e;
    }
  }

  async count(query?: Uniquery<OwnOf<T>, NavOf<T>>): Promise<number> {
    const controls = { ...query?.controls, $count: true };
    return this._get("query", { ...query, controls }) as Promise<number>;
  }

  async findManyWithCount(
    query: Uniquery<OwnOf<T>, NavOf<T>>,
  ): Promise<{ data: DataOf<T>[]; count: number }> {
    const controls = query?.controls ?? {};
    const limit = ((controls as Record<string, unknown>).$limit as number | undefined) || 1000;
    const skip = ((controls as Record<string, unknown>).$skip as number | undefined) || 0;
    const page = Math.floor(skip / limit) + 1;
    const result = (await this._get("pages", {
      ...query,
      controls: { ...controls, $page: page, $size: limit } as UniqueryControls,
    })) as PagesResponse<DataOf<T>>;
    return { data: result.data, count: result.count };
  }

  async pages(query?: Uniquery<OwnOf<T>, NavOf<T>>): Promise<PagesResponse<DataOf<T>>> {
    return this._get("pages", query) as Promise<PagesResponse<DataOf<T>>>;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async search(
    text: string,
    query?: Uniquery<OwnOf<T>, NavOf<T>>,
    indexName?: string,
  ): Promise<DataOf<T>[]> {
    const controls: Record<string, unknown> = { ...query?.controls, $search: text };
    if (indexName) controls.$index = indexName;
    return this._get("query", { ...query, controls } as Uniquery) as Promise<DataOf<T>[]>;
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────

  async aggregate(query: AggregateQuery): Promise<Record<string, unknown>[]> {
    return this._get("query", query as unknown as Uniquery) as Promise<Record<string, unknown>[]>;
  }

  // ── Write Methods ─────────────────────────────────────────────────────────

  async insertOne(data: Partial<DataOf<T>>): Promise<InsertResult> {
    return this._request("POST", "", data) as Promise<InsertResult>;
  }

  async insertMany(data: Partial<DataOf<T>>[]): Promise<InsertManyResult> {
    return this._request("POST", "", data) as Promise<InsertManyResult>;
  }

  async updateOne(data: Partial<DataOf<T>>): Promise<UpdateResult> {
    return this._request("PATCH", "", data) as Promise<UpdateResult>;
  }

  async bulkUpdate(data: Partial<DataOf<T>>[]): Promise<UpdateResult> {
    return this._request("PATCH", "", data) as Promise<UpdateResult>;
  }

  async replaceOne(data: DataOf<T>): Promise<UpdateResult> {
    return this._request("PUT", "", data) as Promise<UpdateResult>;
  }

  async bulkReplace(data: DataOf<T>[]): Promise<UpdateResult> {
    return this._request("PUT", "", data) as Promise<UpdateResult>;
  }

  async deleteOne(id: IdOf<T>): Promise<DeleteResult> {
    if (id !== null && typeof id === "object") {
      return this._request(
        "DELETE",
        `?${this._idToParams(id as Record<string, unknown>).toString()}`,
      ) as Promise<DeleteResult>;
    }
    return this._request("DELETE", encodeURIComponent(String(id))) as Promise<DeleteResult>;
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  async meta(): Promise<MetaResponse> {
    if (!this._metaPromise) {
      this._metaPromise = this._request("GET", "meta") as Promise<MetaResponse>;
    }
    return this._metaPromise;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _idToParams(id: Record<string, unknown>): URLSearchParams {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(id)) {
      params.set(k, String(v));
    }
    return params;
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

  private async _request(method: string, endpoint: string, body?: unknown): Promise<unknown> {
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
