import type {
  FilterExpr,
  SelectExpr,
  UniqueryControls,
  Uniquery,
  AggregateQuery,
  AggregateResult,
  BucketExpr,
  BucketUnit,
  CalendarBucketLabel,
  TypedWithRelation,
  ValidGroupBy,
  WeekStart,
} from "@uniqu/core";
import type {
  DbPatch,
  DbResponse,
  DbRow,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbInsertIgnoreResult,
  TDbInsertManyIgnoreResult,
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
  SelectExpr,
  UniqueryControls,
  Uniquery,
  AggregateQuery,
  AggregateResult,
  BucketExpr,
  BucketUnit,
  CalendarBucketLabel,
  TypedWithRelation,
  ValidGroupBy,
  WeekStart,
};

// ── Re-export CRUD result types from @atscript/db ───────────────────────────

export type {
  TDbInsertResult,
  TDbInsertManyResult,
  TDbInsertIgnoreResult,
  TDbInsertManyIgnoreResult,
  TDbUpdateResult,
  TDbDeleteResult,
};

// ── Write payload aliases (since 0.1.128) ───────────────────────────────────

export type { DbPatch, DbRow };

/**
 * Write payload for `insert()` / `update()`: every key optional, optional
 * columns additionally accept `null` (explicit NULL). `$cas` is accepted on
 * `update()` / `replace()` through the open index signature.
 */
export type PatchOf<T> = DbPatch<DataOf<T>>;

/** Write payload for `replace()`: full row; optional columns additionally accept `null`. */
export type RowOf<T> = DbRow<DataOf<T>>;

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

/**
 * `$select` controls of a read over `T` whose controller declares the display-only
 * fields `D` (`@DbDecorations`): `$select` also accepts `keyof D`; filter, sort
 * and every other control stay over the own fields. Since 0.1.148.
 */
export type DecoratedControls<T, D> = Omit<UniqueryControls<OwnOf<T>, NavOf<T>>, "$select"> & {
  $select?: SelectExpr<OwnOf<T> & D>;
};

/** A read query over `T` — {@link DecoratedControls} for the controls. Since 0.1.148. */
export type DecoratedQuery<T, D> = Omit<Uniquery<OwnOf<T>, NavOf<T>>, "controls"> & {
  controls?: DecoratedControls<T, D>;
};

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
 * short-circuits to the data type. `$actions` / `$disabledReasons` are always
 * optional — the server emits them only when the request set `?$actions=true`.
 */
export type ClientResponse<T, Q> = DbResponse<DataOf<T>, NavOf<T>, Q> & {
  /**
   * Server-evaluated per-row availability for `'row'` and `'rows'`-level
   * actions. Each entry is the `name` of an action that is NOT disabled for
   * this row.
   */
  $actions?: string[];
  /**
   * Action name → human-readable reason, for actions disabled on this row
   * whose `disabled` predicate returned a reason string. Present only on
   * rows with at least one such reason; keys never appear in `$actions`.
   *
   * @since 0.1.141
   */
  $disabledReasons?: Record<string, string>;
};

// ── Query targets (since 0.1.147) ───────────────────────────────────────────

/**
 * "Every row matching this query" — the target of
 * `Client.actionOnQuery()` / `countActionTarget()`, for a `'rows'` action
 * whose `/meta` entry carries `queryTarget`. The same filter / search /
 * index the user's `/query` used; the server resolves it under the caller's
 * read scope and the action's own gate.
 *
 * @since 0.1.147
 */
export interface TDbQueryTarget<T = AtscriptClientShape> {
  filter?: Uniquery<OwnOf<T>, NavOf<T>>["filter"];
  /** `$search` term. */
  search?: string;
  /** `$index` — the search index `search` uses. */
  index?: string;
  /** Identifiers to leave out (any identification of the controller the request goes to). */
  exclude?: Record<string, unknown>[];
  /** Fail with 409 `TARGET_CHANGED` when the target no longer matches exactly this many rows. */
  expectCount?: number;
  /** Client-side cap (never above the action's `queryTarget.maxRows`). */
  maxRows?: number;
}
