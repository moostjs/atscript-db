import {
  isAnnotatedType,
  type FlatOf,
  type PrimaryKeyOf,
  type OwnPropsOf,
  type NavPropsOf,
  type TAtscriptAnnotatedType,
  type TAtscriptDataType,
  type TAtscriptTypeObject,
  type TMetadataMap,
  type Validator,
  type TValidatorOptions,
} from "@atscript/typescript/utils";

import type {
  AggregateQuery,
  FilterExpr,
  UniqueryControls,
  Uniquery,
  WithRelation,
} from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import { DbError } from "../db-error";
import type { TGenericLogger } from "../logger";
import { NoopLogger } from "../logger";
import type {
  PageResult,
  TDbDefaultValue,
  TDbFieldMeta,
  TDbForeignKey,
  TDbIndex,
  TDbRelation,
  TIdDescriptor,
  TSearchIndexInfo,
  TTableResolver,
  TWriteTableResolver,
} from "../types";
import { TableMetadata } from "./table-metadata";
import { type FieldMappingStrategy, DocumentFieldMapper } from "../strategies/field-mapping";
import { RelationalFieldMapper } from "../strategies/relational-field-mapper";
import type { TRelationLoaderHost } from "../rel/relation-loader";
import { findFKForRelation, findRemoteFK } from "../rel/relation-helpers";

/**
 * Extracts nav prop names from a query's `$with` array.
 * Returns `never` when `$with` is absent → all nav props stripped from response.
 */
type ExtractWith<Q> = Q extends { controls: { $with: Array<{ name: infer N extends string }> } }
  ? N
  : never;

/**
 * Computes the response type for a query:
 * - Strips all nav props from the base DataType
 * - Adds back only the nav props requested via `$with`
 *
 * When no `$with` is provided, result is `Omit<DataType, keyof NavType>`.
 * When `$with: [{ name: 'author' }]`, result includes `author` from DataType.
 * When the query type is not a literal (e.g. a variable typed as `Uniquery`),
 * falls back to `DataType` (all nav props optional, as declared).
 */
export type DbResponse<Data, Nav, Q> = [keyof Nav] extends [never]
  ? Data
  : Omit<Data, keyof Nav & string> & Pick<Data, ExtractWith<Q> & keyof Data & string>;

/**
 * Resolves the design type from an annotated type.
 * Encapsulates the `kind === ''` check and fallback logic that
 * otherwise trips up every adapter author.
 *
 * For union types (e.g., from flattened `{...} | {...}` objects):
 * - If all members resolve to the same type → returns that type (strong type)
 * - If members disagree → returns `'union'` (out of scope for type management)
 */
export function resolveDesignType(fieldType: TAtscriptAnnotatedType): string {
  if (fieldType.type.kind === "") {
    return (fieldType.type as any).designType ?? "string";
  }
  if (fieldType.type.kind === "object") {
    return "object";
  }
  if (fieldType.type.kind === "array") {
    return "array";
  }
  if (fieldType.type.kind === "union") {
    const items = (fieldType.type as { items: TAtscriptAnnotatedType[] }).items;
    if (items.length > 0) {
      const resolved = items.map((item) => resolveDesignType(item));
      if (resolved.every((type) => type === resolved[0])) {
        return resolved[0];
      }
    }
    return "union";
  }
  return "string";
}

/**
 * Resolves `@db.default.*` annotations from a metadata map into a {@link TDbDefaultValue}.
 * Used both during normal field descriptor construction and for FK target field resolution.
 */
export function resolveDefaultFromMetadata(
  metadata: TMetadataMap<any>,
): TDbDefaultValue | undefined {
  const defaultValue = metadata.get("db.default") as string | undefined;
  if (defaultValue !== undefined) {
    return { kind: "value", value: defaultValue };
  }
  if (metadata.has("db.default.increment")) {
    const startValue = metadata.get("db.default.increment");
    return {
      kind: "fn",
      fn: "increment",
      start: typeof startValue === "number" ? startValue : undefined,
    };
  }
  if (metadata.has("db.default.uuid")) {
    return { kind: "fn", fn: "uuid" };
  }
  if (metadata.has("db.default.now")) {
    return { kind: "fn", fn: "now" };
  }
  return undefined;
}

/**
 * Checks whether an id value is type-compatible with a field's design type.
 * Used by `findById` to skip primary-key lookup when the id clearly can't match,
 * falling through to unique-property search instead.
 */
function isIdCompatible(id: unknown, fieldType: TAtscriptAnnotatedType): boolean {
  const dt = resolveDesignType(fieldType);
  switch (dt) {
    case "number": {
      if (typeof id === "number") {
        return true;
      }
      if (typeof id === "string") {
        return id !== "" && !Number.isNaN(Number(id));
      }
      return false;
    }
    case "boolean": {
      return typeof id === "boolean";
    }
    case "object":
    case "array": {
      return typeof id === "object" && id !== null;
    }
    default: {
      // 'string' and unknown design types
      return typeof id === "string";
    }
  }
}

/**
 * Shared read-only database abstraction driven by Atscript annotations.
 *
 * Contains all field metadata computation, read operations, query translation,
 * relation loading, and result reconstruction. Extended by both
 * {@link AtscriptDbTable} (adds write operations) and {@link AtscriptDbView}
 * (adds view plan/DDL).
 */
export class AtscriptDbReadable<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
  _FlatType = FlatOf<T>,
  A extends BaseDbAdapter = BaseDbAdapter,
  IdType = PrimaryKeyOf<T>,
  OwnProps = OwnPropsOf<T>,
  NavType extends Record<string, unknown> = NavPropsOf<T>,
> {
  /** Resolved table/collection/view name. */
  public readonly tableName: string;

  /** Database schema/namespace from `@db.schema` (if set). */
  public readonly schema: string | undefined;

  /** Sync method from `@db.sync.method` ('drop' | 'recreate' | undefined). */
  protected readonly _syncMethod: "drop" | "recreate" | undefined;

  /** Previous table/view name from `@db.table.renamed` or `@db.view.renamed`. */
  public readonly renamedFrom: string | undefined;

  // ── Metadata ─────────────────────────────────────────────────────────────

  /** Computed metadata for this table/view. Built lazily on first access. */
  protected readonly _meta: TableMetadata;

  /** Strategy for mapping between logical field shapes and physical storage. */
  protected readonly _fieldMapper: FieldMappingStrategy;

  protected _writeTableResolver?: TWriteTableResolver;

  constructor(
    protected readonly _type: T,
    protected readonly adapter: A,
    protected readonly logger: TGenericLogger = NoopLogger,
    protected readonly _tableResolver?: TTableResolver,
  ) {
    if (!isAnnotatedType(_type)) {
      throw new Error("Atscript Annotated Type expected");
    }
    if (_type.type.kind !== "object") {
      throw new Error("Database type must be an object type");
    }

    const adapterName = adapter.getAdapterTableName?.(_type);
    const dbTable = _type.metadata.get("db.table") as string | undefined;
    const dbViewName = _type.metadata.get("db.view") as string | undefined;
    const fallbackName = _type.id || "";

    this.tableName = adapterName || dbTable || dbViewName || fallbackName;
    if (!this.tableName) {
      throw new Error("@db.table or @db.view annotation expected");
    }

    this.schema = _type.metadata.get("db.schema") as string | undefined;
    this._syncMethod = _type.metadata.get("db.sync.method") as "drop" | "recreate" | undefined;
    this.renamedFrom =
      (_type.metadata.get("db.table.renamed") as string | undefined) ??
      (_type.metadata.get("db.view.renamed") as string | undefined);

    this._meta = new TableMetadata(adapter.supportsNestedObjects());
    this._fieldMapper = adapter.supportsNestedObjects()
      ? new DocumentFieldMapper()
      : new RelationalFieldMapper();

    // Establish bidirectional relationship
    adapter.registerReadable(this, logger);
  }

  /** Ensures metadata is built. Called before any metadata access. */
  protected _ensureBuilt(): void {
    if (!this._meta.isBuilt) {
      this._meta.build(this.type, this.adapter, this.logger);
    }
  }

  // ── Public getters ────────────────────────────────────────────────────────

  /** Whether this readable is a view (overridden in AtscriptDbView). */
  public get isView(): boolean {
    return false;
  }

  /** Returns the underlying adapter with its concrete type preserved. */
  public getAdapter(): A {
    return this.adapter;
  }

  /** The raw annotated type. */
  public get type(): TAtscriptAnnotatedType<TAtscriptTypeObject> {
    return this._type as TAtscriptAnnotatedType<TAtscriptTypeObject>;
  }

  /** Lazily-built flat map of all fields (dot-notation paths → annotated types). */
  public get flatMap(): Map<string, TAtscriptAnnotatedType> {
    this._ensureBuilt();
    return this._meta.flatMap;
  }

  /** All computed indexes from `@db.index.*` annotations. */
  public get indexes(): Map<string, TDbIndex> {
    this._ensureBuilt();
    return this._meta.indexes;
  }

  /** Primary key field names from `@meta.id`. */
  public get primaryKeys(): readonly string[] {
    this._ensureBuilt();
    return this._meta.primaryKeys;
  }

  /** Original `@meta.id` field names as declared in the schema (before adapter manipulation). */
  public get originalMetaIdFields(): readonly string[] {
    this._ensureBuilt();
    return this._meta.originalMetaIdFields;
  }

  /** Dimension fields from `@db.column.dimension`. */
  public get dimensions(): readonly string[] {
    this._ensureBuilt();
    return this._meta.dimensions;
  }

  /** Measure fields from `@db.column.measure`. */
  public get measures(): readonly string[] {
    this._ensureBuilt();
    return this._meta.measures;
  }

  /** Sync method for structural changes: 'drop' (lossy), 'recreate' (lossless), or undefined (manual). */
  public get syncMethod(): "drop" | "recreate" | undefined {
    return this._syncMethod;
  }

  /** Logical → physical column name mapping from `@db.column`. */
  public get columnMap(): ReadonlyMap<string, string> {
    this._ensureBuilt();
    return this._meta.columnMap;
  }

  /** Default values from `@db.default.*`. */
  public get defaults(): ReadonlyMap<string, TDbDefaultValue> {
    this._ensureBuilt();
    return this._meta.defaults;
  }

  /** Fields excluded from DB via `@db.ignore`. */
  public get ignoredFields(): ReadonlySet<string> {
    this._ensureBuilt();
    return this._meta.ignoredFields;
  }

  /** Navigational fields (`@db.rel.to` / `@db.rel.from`) — not stored as columns. */
  public get navFields(): ReadonlySet<string> {
    this._ensureBuilt();
    return this._meta.navFields;
  }

  /** Single-field unique index properties. */
  public get uniqueProps(): ReadonlySet<string> {
    this._ensureBuilt();
    return this._meta.uniqueProps;
  }

  /** Foreign key constraints from `@db.rel.FK` annotations. */
  public get foreignKeys(): ReadonlyMap<string, TDbForeignKey> {
    this._ensureBuilt();
    return this._meta.foreignKeys;
  }

  /** Navigational relation metadata from `@db.rel.to` / `@db.rel.from`. */
  public get relations(): ReadonlyMap<string, TDbRelation> {
    this._ensureBuilt();
    return this._meta.relations;
  }

  /** The underlying database adapter instance. */
  public get dbAdapter(): A {
    return this.adapter;
  }

  /**
   * Enables or disables verbose (debug-level) DB call logging for this table/view.
   * When disabled (default), no log strings are constructed — zero overhead.
   */
  public setVerbose(enabled: boolean): void {
    this.adapter.setVerbose(enabled);
  }

  /** Precomputed logical dot-path → physical column name map. */
  public get pathToPhysical(): ReadonlyMap<string, string> {
    this._ensureBuilt();
    return this._meta.pathToPhysical;
  }

  /** Precomputed physical column name → logical dot-path map (inverse). */
  public get physicalToPath(): ReadonlyMap<string, string> {
    this._ensureBuilt();
    return this._meta.physicalToPath;
  }

  /** Descriptor for the primary ID field(s). */
  public getIdDescriptor(): TIdDescriptor {
    this._ensureBuilt();
    return {
      fields: [...this._meta.primaryKeys],
      isComposite: this._meta.primaryKeys.length > 1,
    };
  }

  /**
   * Pre-computed field metadata for adapter use.
   */
  public get fieldDescriptors(): readonly TDbFieldMeta[] {
    this._ensureBuilt();
    return this._meta.fieldDescriptors;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  /**
   * Creates a new validator with custom options.
   */
  public createValidator(opts?: Partial<TValidatorOptions>): Validator<T, DataType> {
    return this._type.validator(opts) as Validator<T, DataType>;
  }

  // ── Read operations ────────────────────────────────────────────────────────

  /**
   * Finds a single record matching the query.
   * The return type automatically excludes nav props unless they are
   * explicitly requested via `$with`.
   */
  public async findOne<Q extends Uniquery<OwnProps, NavType>>(
    query: Q,
  ): Promise<DbResponse<DataType, NavType, Q> | null> {
    this._ensureBuilt();
    const withRelations = (query.controls as UniqueryControls)?.$with as WithRelation[] | undefined;
    const translatedQuery = this._fieldMapper.translateQuery(query as Uniquery, this._meta);
    const result = await this.adapter.findOne(translatedQuery);
    if (!result) {
      return null;
    }
    const row = this._fieldMapper.reconstructFromRead(result, this._meta);
    if (withRelations?.length) {
      await this.loadRelations([row], withRelations);
    }
    return row as DbResponse<DataType, NavType, Q>;
  }

  /**
   * Finds all records matching the query.
   * The return type automatically excludes nav props unless they are
   * explicitly requested via `$with`.
   */
  public async findMany<Q extends Uniquery<OwnProps, NavType>>(
    query: Q,
  ): Promise<Array<DbResponse<DataType, NavType, Q>>> {
    this._ensureBuilt();
    const withRelations = (query.controls as UniqueryControls)?.$with as WithRelation[] | undefined;
    const translatedQuery = this._fieldMapper.translateQuery(query as Uniquery, this._meta);
    const results = await this.adapter.findMany(translatedQuery);
    const rows = results.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    if (withRelations?.length) {
      await this.loadRelations(rows, withRelations);
    }
    return rows as Array<DbResponse<DataType, NavType, Q>>;
  }

  /**
   * Counts records matching the query.
   */
  public async count(query?: Uniquery<OwnProps, NavType>): Promise<number> {
    this._ensureBuilt();
    query ??= { filter: {}, controls: {} } as Uniquery<OwnProps, NavType>;
    return this.adapter.count(this._fieldMapper.translateQuery(query as Uniquery, this._meta));
  }

  /**
   * Finds records and total count in a single logical call.
   */
  public async findManyWithCount<Q extends Uniquery<OwnProps, NavType>>(
    query: Q,
  ): Promise<{ data: Array<DbResponse<DataType, NavType, Q>>; count: number }> {
    this._ensureBuilt();
    const withRelations = (query.controls as UniqueryControls)?.$with as WithRelation[] | undefined;
    const translated = this._fieldMapper.translateQuery(query as Uniquery, this._meta);
    const result = await this.adapter.findManyWithCount(translated);
    const rows = result.data.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    if (withRelations?.length) {
      await this.loadRelations(rows, withRelations);
    }
    return {
      data: rows as Array<DbResponse<DataType, NavType, Q>>,
      count: result.count,
    };
  }

  /**
   * Returns a page of records with pagination metadata.
   *
   * Converts page/size to skip/limit internally, delegates to findManyWithCount,
   * and wraps the result with pagination info.
   */
  public async readPage<Q extends Uniquery<OwnProps, NavType>>(
    query: Q,
    page = 1,
    size = 10,
  ): Promise<PageResult<Array<DbResponse<DataType, NavType, Q>>>> {
    page = Math.max(page, 1);
    size = Math.max(size, 1);
    const skip = (page - 1) * size;

    const paginatedQuery = {
      ...query,
      controls: { ...query.controls, $skip: skip, $limit: size },
    } as Q;

    const result = await this.findManyWithCount(paginatedQuery);

    return {
      data: result.data,
      count: result.count,
      page,
      itemsPerPage: size,
      pages: Math.ceil(result.count / size),
    };
  }

  // ── Aggregation ─────────────────────────────────────────────────────────

  /**
   * Executes an aggregate query with GROUP BY and aggregate functions.
   *
   * Validates:
   * - Plain fields in $select are a subset of $groupBy
   * - When dimensions/measures are defined (strict mode): $groupBy fields
   *   must be dimensions, aggregate $field values must be measures (or '*')
   *
   * Translates field names, delegates to adapter.aggregate(),
   * then reverse-maps and applies fromStorage formatters on results.
   */
  public async aggregate(query: AggregateQuery): Promise<Array<Record<string, unknown>>> {
    this._ensureBuilt();
    const { $groupBy, $select } = query.controls;

    // Validate: plain fields in $select must be in $groupBy
    if ($select) {
      const groupBySet = new Set($groupBy);
      for (const item of $select) {
        if (typeof item === "string" && !groupBySet.has(item)) {
          throw new DbError("INVALID_QUERY", [
            {
              path: "$select",
              message: `Plain field "${item}" in $select must also appear in $groupBy`,
            },
          ]);
        }
      }
    }

    // Strict mode: validate dimensions/measures if any are defined
    const { dimensions, measures } = this._meta;
    if (dimensions.length > 0 || measures.length > 0) {
      const dimSet = new Set(dimensions);
      const measSet = new Set(measures);

      for (const field of $groupBy) {
        if (!dimSet.has(field)) {
          throw new DbError("INVALID_QUERY", [
            { path: "$groupBy", message: `Field "${field}" is not a dimension` },
          ]);
        }
      }

      if ($select) {
        for (const item of $select) {
          if (typeof item !== "string" && item.$field !== "*" && !measSet.has(item.$field)) {
            throw new DbError("INVALID_QUERY", [
              { path: "$select", message: `Aggregate field "${item.$field}" is not a measure` },
            ]);
          }
        }
      }
    }

    // Translate and delegate
    const dbQuery = this._fieldMapper.translateAggregateQuery(query, this._meta);
    const results = await this.adapter.aggregate(dbQuery);

    // Reverse-map physical → logical field names, apply fromStorage formatters
    return results.map((row) => {
      const mapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        const logical = this._meta.physicalToPath.get(key) ?? key;
        const fmt = this._meta.fromStorageFormatters?.get(key);
        mapped[logical] = fmt && value !== null && value !== undefined ? fmt(value) : value;
      }
      return mapped;
    });
  }

  // ── Search ──────────────────────────────────────────────────────────────

  /** Whether the underlying adapter supports text search. */
  public isSearchable(): boolean {
    return this.adapter.isSearchable();
  }

  /** Returns available search indexes from the adapter. */
  public getSearchIndexes(): TSearchIndexInfo[] {
    return this.adapter.getSearchIndexes();
  }

  /**
   * Full-text search with query translation and result reconstruction.
   */
  public async search<Q extends Uniquery<OwnProps, NavType>>(
    text: string,
    query: Q,
    indexName?: string,
  ): Promise<Array<DbResponse<DataType, NavType, Q>>> {
    this._ensureBuilt();
    const withRelations = (query.controls as UniqueryControls)?.$with as WithRelation[] | undefined;
    const translated = this._fieldMapper.translateQuery(query as Uniquery, this._meta);
    const results = await this.adapter.search(text, translated, indexName);
    const rows = results.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    if (withRelations?.length) {
      await this.loadRelations(rows, withRelations);
    }
    return rows as Array<DbResponse<DataType, NavType, Q>>;
  }

  /**
   * Full-text search with count for paginated search results.
   */
  public async searchWithCount<Q extends Uniquery<OwnProps, NavType>>(
    text: string,
    query: Q,
    indexName?: string,
  ): Promise<{ data: Array<DbResponse<DataType, NavType, Q>>; count: number }> {
    this._ensureBuilt();
    const withRelations = (query.controls as UniqueryControls)?.$with as WithRelation[] | undefined;
    const translated = this._fieldMapper.translateQuery(query as Uniquery, this._meta);
    const result = await this.adapter.searchWithCount(text, translated, indexName);
    const rows = result.data.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    if (withRelations?.length) {
      await this.loadRelations(rows, withRelations);
    }
    return {
      data: rows as Array<DbResponse<DataType, NavType, Q>>,
      count: result.count,
    };
  }

  // ── Vector Search ─────────────────────────────────────────────────────

  /** Whether the underlying adapter supports vector similarity search. */
  public isVectorSearchable(): boolean {
    return this.adapter.isVectorSearchable();
  }

  /**
   * Vector similarity search with query translation and result reconstruction.
   *
   * Overloads:
   * - `vectorSearch(vector, query?)` — uses default vector index
   * - `vectorSearch(indexName, vector, query?)` — targets a specific vector index
   */
  public async vectorSearch<Q extends Uniquery<OwnProps, NavType>>(
    vectorOrIndex: number[] | string,
    maybeVectorOrQuery?: number[] | Q,
    maybeQuery?: Q,
  ): Promise<Array<DbResponse<DataType, NavType, Q>>> {
    const { vector, query, indexName } = this._resolveVectorSearchArgs<Q>(
      vectorOrIndex,
      maybeVectorOrQuery,
      maybeQuery,
    );
    this._ensureBuilt();
    const withRelations = (query?.controls as UniqueryControls)?.$with as
      | WithRelation[]
      | undefined;
    const translated = this._fieldMapper.translateQuery((query || {}) as Uniquery, this._meta);
    const results = await this.adapter.vectorSearch(vector, translated, indexName);
    const rows = results.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    if (withRelations?.length) {
      await this.loadRelations(rows, withRelations);
    }
    return rows as Array<DbResponse<DataType, NavType, Q>>;
  }

  /**
   * Vector similarity search with count for paginated results.
   *
   * Overloads:
   * - `vectorSearchWithCount(vector, query?)` — uses default vector index
   * - `vectorSearchWithCount(indexName, vector, query?)` — targets a specific vector index
   */
  public async vectorSearchWithCount<Q extends Uniquery<OwnProps, NavType>>(
    vectorOrIndex: number[] | string,
    maybeVectorOrQuery?: number[] | Q,
    maybeQuery?: Q,
  ): Promise<{ data: Array<DbResponse<DataType, NavType, Q>>; count: number }> {
    const { vector, query, indexName } = this._resolveVectorSearchArgs<Q>(
      vectorOrIndex,
      maybeVectorOrQuery,
      maybeQuery,
    );
    this._ensureBuilt();
    const withRelations = (query?.controls as UniqueryControls)?.$with as
      | WithRelation[]
      | undefined;
    const translated = this._fieldMapper.translateQuery((query || {}) as Uniquery, this._meta);
    const result = await this.adapter.vectorSearchWithCount(vector, translated, indexName);
    const rows = result.data.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    if (withRelations?.length) {
      await this.loadRelations(rows, withRelations);
    }
    return {
      data: rows as Array<DbResponse<DataType, NavType, Q>>,
      count: result.count,
    };
  }

  /** Resolves overloaded vector search arguments into canonical form. */
  private _resolveVectorSearchArgs<Q>(
    vectorOrIndex: number[] | string,
    maybeVectorOrQuery?: number[] | Q,
    maybeQuery?: Q,
  ): { vector: number[]; query: Q | undefined; indexName: string | undefined } {
    if (Array.isArray(vectorOrIndex)) {
      // vectorSearch(vector, query?)
      return {
        vector: vectorOrIndex,
        query: maybeVectorOrQuery as Q | undefined,
        indexName: undefined,
      };
    }
    // vectorSearch(indexName, vector, query?)
    return { vector: maybeVectorOrQuery as number[], query: maybeQuery, indexName: vectorOrIndex };
  }

  // ── Find by ID ──────────────────────────────────────────────────────────

  /**
   * Finds a single record by any type-compatible identifier — primary key
   * or single-field unique index.
   * The return type excludes nav props unless `$with` is provided in controls.
   *
   * ```typescript
   * // Without relations — nav props stripped from result
   * const user = await table.findById('123')
   *
   * // With relations — only requested nav props appear
   * const user = await table.findById('123', { controls: { $with: [{ name: 'posts' }] } })
   * ```
   */
  public async findById<
    Q extends { controls?: UniqueryControls<OwnProps, NavType> } = Record<string, never>,
  >(id: IdType, query?: Q): Promise<DbResponse<DataType, NavType, Q> | null> {
    this._ensureBuilt();
    const filter = this._resolveIdFilter(id);
    if (!filter) {
      return null;
    }
    return (await this.findOne({
      filter,
      controls: query?.controls || {},
    } as Uniquery<OwnProps, NavType>)) as DbResponse<DataType, NavType, Q> | null;
  }

  /**
   * Resolves an id value into a filter expression.
   */
  protected _resolveIdFilter(id: unknown): FilterExpr | null {
    const orFilters: FilterExpr[] = [];

    const pkFields = this.primaryKeys;
    if (pkFields.length === 1) {
      const filter = this._tryFieldFilter(pkFields[0], id);
      if (filter) {
        orFilters.push(filter);
      }
    } else if (pkFields.length > 1 && typeof id === "object" && id !== null) {
      const idObj = id as Record<string, unknown>;
      const compositeFilter: FilterExpr = {};
      let valid = true;
      for (const field of pkFields) {
        const fieldType = this.flatMap.get(field);
        if (fieldType && !isIdCompatible(idObj[field], fieldType)) {
          valid = false;
          break;
        }
        try {
          compositeFilter[field] = fieldType
            ? this.adapter.prepareId(idObj[field], fieldType)
            : idObj[field];
        } catch {
          valid = false;
          break;
        }
      }
      if (valid) {
        orFilters.push(compositeFilter);
      }
    }

    // Try single-field unique indexes
    for (const prop of this.uniqueProps) {
      const filter = this._tryFieldFilter(prop, id);
      if (filter) {
        orFilters.push(filter);
      }
    }

    // Try compound unique indexes when id is an object
    if (typeof id === "object" && id !== null && orFilters.length === 0) {
      const idObj = id as Record<string, unknown>;
      for (const index of this._meta.indexes.values()) {
        if (index.type !== "unique" || index.fields.length < 2) {
          continue;
        }
        const compoundFilter: FilterExpr = {};
        let valid = true;
        for (const indexField of index.fields) {
          const fieldName = indexField.name;
          if (idObj[fieldName] === undefined) {
            valid = false;
            break;
          }
          const fieldType = this.flatMap.get(fieldName);
          if (fieldType && !isIdCompatible(idObj[fieldName], fieldType)) {
            valid = false;
            break;
          }
          try {
            compoundFilter[fieldName] = fieldType
              ? this.adapter.prepareId(idObj[fieldName], fieldType)
              : idObj[fieldName];
          } catch {
            valid = false;
            break;
          }
        }
        if (valid) {
          orFilters.push(compoundFilter);
        }
      }
    }

    if (orFilters.length === 0) {
      return null;
    }
    if (orFilters.length === 1) {
      return orFilters[0];
    }
    return { $or: orFilters } as FilterExpr;
  }

  /**
   * Attempts to build a single-field filter `{ field: preparedId }`.
   */
  private _tryFieldFilter(field: string, id: unknown): FilterExpr | null {
    const fieldType = this.flatMap.get(field);
    if (fieldType && !isIdCompatible(id, fieldType)) {
      return null;
    }
    try {
      const prepared = fieldType ? this.adapter.prepareId(id, fieldType) : id;
      return { [field]: prepared } as FilterExpr;
    } catch {
      return null;
    }
  }

  // ── Relation loading ($with) ─────────────────────────────────────────────

  /**
   * Public entry point for relation loading. Used by adapters for nested $with delegation.
   */
  public async loadRelations(
    rows: Array<Record<string, unknown>>,
    withRelations: WithRelation[],
  ): Promise<void> {
    const { loadRelationsImpl } = await import("../rel/relation-loader");
    return loadRelationsImpl(rows, withRelations, this as any as TRelationLoaderHost);
  }

  /**
   * Finds the FK entry that connects a `@db.rel.to` relation to its target.
   * Thin wrapper — delegates to relation-loader for shared use with db-table.ts write path.
   */
  protected _findFKForRelation(
    relation: TDbRelation,
  ): { localFields: string[]; targetFields: string[] } | undefined {
    return findFKForRelation(relation, this._meta.foreignKeys);
  }

  /**
   * Finds a FK on a remote table that points back to this table.
   * Thin wrapper — delegates to relation-loader for shared use with db-table.ts write path.
   */
  protected _findRemoteFK(
    targetTable: { foreignKeys: ReadonlyMap<string, TDbForeignKey> },
    thisTableName: string,
    alias?: string,
  ): TDbForeignKey | undefined {
    return findRemoteFK(targetTable, thisTableName, alias);
  }
}
