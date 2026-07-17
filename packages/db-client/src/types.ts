import type {
  FilterExpr,
  UniqueryControls,
  Uniquery,
  AggregateQuery,
  AggregateResult,
  TypedWithRelation,
} from "@uniqu/core";
import type {
  DbResponse,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
  TFieldMeta,
  TMetaResponse,
  TRelationInfo,
  TSearchIndexInfo,
} from "@atscript/db";

// ── Re-export uniqu types for consumer convenience ──────────────────────────

export type {
  FilterExpr,
  UniqueryControls,
  Uniquery,
  AggregateQuery,
  AggregateResult,
  TypedWithRelation,
};

// ── Re-export CRUD result types from @atscript/db ───────────────────────────

export type { TDbInsertResult, TDbInsertManyResult, TDbUpdateResult, TDbDeleteResult };

// ── Client Options ──────────────────────────────────────────────────────────

/** Options for creating a Client instance. */
export interface ClientOptions {
  /**
   * Custom fetch implementation. Defaults to `globalThis.fetch`.
   * Use this to inject auth headers, interceptors, or a custom HTTP client.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Default headers to include with every request.
   * Can be a static object or an async factory (e.g. for refreshing auth tokens).
   */
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);

  /**
   * Base URL prefix. Prepended to the client path for full URL construction.
   * @example "https://api.example.com"
   */
  baseUrl?: string;

  /**
   * Override for `processor: 'navigate'` action dispatch. When `Client.action()`
   * resolves a navigate action, this hook is invoked with the interpolated
   * URL. Default behaviour (browser only) calls `window.location.assign(url)`.
   *
   * Provide a custom navigator to integrate with a SPA router:
   * ```typescript
   * new Client('/api/users', { navigate: (url) => router.push(url) })
   * ```
   */
  navigate?: (url: string) => void | Promise<void>;

  /**
   * Tolerate unknown properties in write payloads during client preflight
   * validation. Enable when the served `/meta` type is a projection of the
   * full server-side type (e.g. an ARBAC read overlay strips write-only
   * fields) — the server stays authoritative. Off by default: strict
   * preflight catches typos.
   */
  lenientWrites?: boolean;
}

// ── Meta Response Types ─────────────────────────────────────────────────────
// Re-exported from @atscript/db — the core owns the `GET /meta` contract so
// the server controller and this client validator stay in lockstep.

/** Search index metadata from the server. */
export type SearchIndexInfo = TSearchIndexInfo;

/** Relation summary in meta response. */
export type RelationInfo = TRelationInfo;

/** Per-field capability flags. */
export type FieldMeta = TFieldMeta;

/** Enhanced meta response from the server (`GET /meta`). */
export type MetaResponse = TMetaResponse;

// ── Paginated Response ──────────────────────────────────────────────────────

/** Paginated response shape from `GET /pages`. */
export interface PageResult<T> {
  data: T[];
  page: number;
  itemsPerPage: number;
  pages: number;
  count: number;
}

/** Server error response shape (matches moost-db error transform). */
export interface ServerError {
  message: string;
  statusCode: number;
  errors?: Array<{ path: string; message: string; details?: unknown[] }>;
}

// ── Type Helpers ────────────────────────────────────────────────────────────

/**
 * Minimal brand shape every `Client<T>` generic must satisfy. All fields are
 * optional — plain interfaces and `Record<string, unknown>` satisfy this
 * constraint, so `new Client('/path')` (no generic) keeps working with
 * `unknown` / `Record<string, unknown>` fallbacks. Atscript-generated types
 * fill these brand fields and unlock per-method inference.
 */
export type AtscriptClientShape = {
  __pk?: unknown;
  __ownProps?: Record<string, unknown>;
  __navProps?: Record<string, unknown>;
  type?: { __dataType?: unknown };
};

/** Extract the data type from an Atscript annotated type `T`. */
export type DataOf<T> = T extends { type: { __dataType?: infer D } }
  ? unknown extends D
    ? T extends new (...a: any[]) => infer I
      ? I
      : Record<string, unknown>
    : D & Record<string, unknown>
  : Record<string, unknown>;

/** Extract own (non-nav) properties from an Atscript annotated type. */
export type OwnOf<T> = T extends { __ownProps: infer O } ? O : DataOf<T>;

/** Extract nav properties from an Atscript annotated type. */
export type NavOf<T> = T extends {
  __navProps: infer N extends Record<string, unknown>;
}
  ? N
  : Record<string, never>;

/** Extract primary key type from an Atscript annotated type. */
export type IdOf<T> = T extends { __pk: infer PK } ? PK : unknown;

/**
 * Narrow a read-method response type by the literal `$with` array in the
 * query, mirroring the backend's `DbResponse<Data, Nav, Q>` algebra. Nav
 * properties are stripped by default and re-added only for relations the
 * caller listed in `$with`. When `T` carries no nav-prop brand, `DbResponse`
 * short-circuits to the data type. `$actions` is always optional — the
 * server emits it only when the request set `?$actions=true`.
 */
export type ClientResponse<T, Q> = DbResponse<DataOf<T>, NavOf<T>, Q> & {
  /**
   * Server-evaluated per-row availability for `'row'` and `'rows'`-level
   * actions. Each entry is the `name` of an action that is NOT disabled for
   * this row.
   */
  $actions?: string[];
};
