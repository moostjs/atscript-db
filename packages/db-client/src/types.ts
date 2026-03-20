import type {
  FilterExpr,
  UniqueryControls,
  Uniquery,
  AggregateQuery,
  TypedWithRelation,
} from "@uniqu/core";
import type { TSerializedAnnotatedType } from "@atscript/typescript/utils";

// ── Re-export uniqu types for consumer convenience ──────────────────────────

export type { FilterExpr, UniqueryControls, Uniquery, AggregateQuery, TypedWithRelation };

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

/** Search index metadata from the server. */
export interface SearchIndexInfo {
  name: string;
  description?: string;
  type?: "text" | "vector";
}

/** Relation summary in meta response. */
export interface RelationInfo {
  name: string;
  direction: "to" | "from" | "via";
  isArray: boolean;
}

/** Per-field capability flags. */
export interface FieldMeta {
  sortable: boolean;
  filterable: boolean;
}

/** Enhanced meta response from the server. */
export interface MetaResponse {
  searchable: boolean;
  vectorSearchable: boolean;
  searchIndexes: SearchIndexInfo[];
  primaryKeys: string[];
  readOnly: boolean;
  relations: RelationInfo[];
  fields: Record<string, FieldMeta>;
  type: TSerializedAnnotatedType;
}

// ── CRUD Result Types ───────────────────────────────────────────────────────

export interface InsertResult {
  insertedId: unknown;
}

export interface InsertManyResult {
  insertedCount: number;
  insertedIds: unknown[];
}

export interface UpdateResult {
  matchedCount: number;
  modifiedCount: number;
}

export interface DeleteResult {
  deletedCount: number;
}

/** Paginated response shape (matches moost-db /pages response). */
export interface PagesResponse<T> {
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

// ── SSR Interface ───────────────────────────────────────────────────────────

/**
 * Shared interface for both server-side `AtscriptDbTable` and client-side `Client`.
 * Enables SSR isomorphism: same code runs on server (direct DB) and browser (HTTP).
 *
 * ```typescript
 * const users: DbInterface<typeof User> = isServer ? serverTable : httpClient
 * await users.findMany({ filter: { active: true } })
 * ```
 */
export interface DbInterface<T = Record<string, unknown>> {
  findOne(query: Uniquery<OwnOf<T>, NavOf<T>>): Promise<DataOf<T> | null>;
  findMany(query?: Uniquery<OwnOf<T>, NavOf<T>>): Promise<DataOf<T>[]>;
  findById(
    id: IdOf<T>,
    query?: { controls?: UniqueryControls<OwnOf<T>, NavOf<T>> },
  ): Promise<DataOf<T> | null>;
  count(query?: Uniquery<OwnOf<T>, NavOf<T>>): Promise<number>;
  search(
    text: string,
    query?: Uniquery<OwnOf<T>, NavOf<T>>,
    indexName?: string,
  ): Promise<DataOf<T>[]>;
  aggregate(query: AggregateQuery): Promise<Record<string, unknown>[]>;

  insertOne(data: Partial<DataOf<T>>): Promise<InsertResult>;
  insertMany(data: Partial<DataOf<T>>[]): Promise<InsertManyResult>;
  updateOne(data: Partial<DataOf<T>>): Promise<UpdateResult>;
  bulkUpdate(data: Partial<DataOf<T>>[]): Promise<UpdateResult>;
  replaceOne(data: DataOf<T>): Promise<UpdateResult>;
  bulkReplace(data: DataOf<T>[]): Promise<UpdateResult>;
  deleteOne(id: IdOf<T>): Promise<DeleteResult>;
}
