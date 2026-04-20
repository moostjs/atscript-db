import type {
  FilterExpr,
  UniqueryControls,
  Uniquery,
  AggregateQuery,
  AggregateResult,
  TypedWithRelation,
} from "@uniqu/core";
import type {
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
