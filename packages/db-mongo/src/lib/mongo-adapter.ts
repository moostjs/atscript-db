import type {
  TAtscriptAnnotatedType,
  TMetadataMap,
  TValidatorOptions,
  Validator,
} from "@atscript/typescript/utils";
import {
  ALL_AGGREGATE_FNS,
  ALL_VIEW_CAPABILITIES,
  ALL_BUCKET_UNITS,
  BaseDbAdapter,
  DbError,
  getPath,
  uniqueKeyTuple,
  type DbQuery,
  type FilterExpr,
  type TDbInsertResult,
  type TDbInsertManyResult,
  type TDbInsertIgnoreSlot,
  type TDbUpdateResult,
  type TDbUpdateOptions,
  type TDbDeleteResult,
  type TSearchIndexInfo,
  type TDbRelation,
  type TDbForeignKey,
  type TTableResolver,
  type WithRelation,
  type TColumnDiff,
  type TDbObjectKind,
  type TPrimaryKeyChange,
  type TSyncColumnResult,
  type TDbCollation,
  type TExistingTableOption,
  type TMetadataOverrides,
  type TableMetadata,
  type TDbFieldMeta,
  type TFieldOps,
  computeInsights,
  defaultFulltextIndex,
  containsRelationFilter,
  type AtscriptDbView,
  type TReadColumnsKind,
} from "@atscript/db";
import type {
  AggregateOptions,
  AggregationCursor,
  ClientSession,
  CollationOptions,
  Collection,
  Db,
  Document,
  Filter,
  MongoClient,
} from "mongodb";
import { MongoBulkWriteError, MongoServerError, ObjectId } from "mongodb";
import type { AggregateFn, BucketUnit } from "@uniqu/core";
import type { TViewCapability } from "@atscript/db";
import { dedupeProjection } from "./projection-dedupe";
import { hasNullsPlacement, sortStages } from "./mongo-sort";
import { isArrayPath, joinPath } from "./path-utils";
import { wrapInvalidQuery } from "./mongo-errors";
import { CollectionPatcher, type TCollectionPatcherContext } from "./collection-patcher";
import {
  buildMongoFilter,
  buildMongoQuery,
  collationOfAdapter,
  mongoFilterStages,
  planStages,
  type TMongoFilterOptions,
} from "./mongo-filter";
import {
  DEFAULT_INDEX_NAME,
  mongoCollationOf,
  mongoIndexKey,
  type TPlainIndex,
  type TSearchIndex,
  type TMongoIndex,
  type TMongoSearchIndexDefinition,
  type TSearchFieldMapping,
} from "./mongo-types";
import { mongoViewRead, stagesReadAny } from "./mongo-view-read";
import type { TMongoRelationHost } from "./mongo-relations";
import { loadRelationsImpl } from "./mongo-relations";
import type { TMongoGeoHost, TMongoSearchHost } from "./mongo-search";
import {
  buildAggregateSearchStage,
  searchImpl,
  searchWithCountImpl,
  vectorSearchImpl,
  vectorSearchWithCountImpl,
  geoSearchImpl,
  geoSearchWithCountImpl,
  getSearchIndexesImpl,
  isVectorSearchableImpl,
} from "./mongo-search";
import type { TMongoSchemaSyncHost } from "./mongo-schema-sync";
import {
  tableExistsImpl,
  ensureTableImpl,
  syncIndexesImpl,
  syncColumnsImpl,
  dropColumnsImpl,
  renameTableImpl,
  recreateTableImpl,
  dropTableImpl,
  dropViewByNameImpl,
  dropTableByNameImpl,
  getDesiredTableOptionsImpl,
  getExistingTableOptionsImpl,
  getObjectKindImpl,
  hasRowsImpl,
  DESTRUCTIVE_OPTION_KEYS,
} from "./mongo-schema-sync";
import { validateMongoIdPlugin } from "./validate-plugins";

// Public mongo-types surface. `mongoIndexKey`/`INDEX_PREFIX` let raw-`mongodb`-driver
// consumers resolve the physical index name schema-sync provisions
// (`atscript__<type>__<cleanName>`) — the logical `.as` name makes `$search` return
// zero documents on Atlas. See adapters-mongo.md#managed-index-prefix--physical-index-names.
export { INDEX_PREFIX, mongoIndexKey } from "./mongo-types";
export type {
  TPlainIndex,
  TSearchIndex,
  TMongoIndex,
  TMongoSearchIndexDefinition,
} from "./mongo-types";

// ── ObjectId value mapping ───────────────────────────────────────────────────

/** Mirrors the `mongo.objectId` primitive's pattern — only definite hex ids convert. */
const OBJECT_ID_HEX = /^[a-fA-F0-9]{24}$/;

/** True for `mongo.objectId`-typed fields and arrays of them (tag-based, same as `prepareId`). */
function isObjectIdColumn(fieldType: TAtscriptAnnotatedType): boolean {
  const t = fieldType.type as {
    kind?: string;
    tags?: ReadonlySet<string>;
    of?: TAtscriptAnnotatedType;
  };
  if (t.kind === "array") {
    return !!t.of && isObjectIdColumn(t.of);
  }
  return t.tags?.has("objectId") === true && t.tags?.has("mongo");
}

function objectIdToStorage(value: unknown): unknown {
  if (typeof value === "string" && OBJECT_ID_HEX.test(value)) {
    return new ObjectId(value);
  }
  if (Array.isArray(value)) {
    return value.map(objectIdToStorage);
  }
  // ObjectId instances (e.g. from prepareId), non-hex strings, operator scraps pass through.
  return value;
}

function objectIdFromStorage(value: unknown): unknown {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  if (Array.isArray(value)) {
    return value.map(objectIdFromStorage);
  }
  return value;
}

/**
 * Documents per `_id $in` write when a mutation filter holds relational
 * predicates (see {@link MongoAdapter.supportsRelationFilters}).
 */
const REL_WRITE_BATCH = 1000;

// ── Adapter ──────────────────────────────────────────────────────────────────

/** Whether a bulk-write error carries a write-concern failure besides (or instead of) write errors. */
function hasWriteConcernError(error: MongoBulkWriteError): boolean {
  const e = error as unknown as {
    writeConcernError?: unknown;
    result?: { getWriteConcernError?: () => unknown; writeConcernErrors?: unknown[] };
  };
  return Boolean(
    e.writeConcernError ||
    e.result?.getWriteConcernError?.() ||
    e.result?.writeConcernErrors?.length,
  );
}

/**
 * Options of a {@link MongoAdapter} (and of `createAdapter`).
 *
 * @since 0.1.151
 */
export interface TMongoAdapterOptions {
  /**
   * Opt-in: answer the count of an UNFILTERED read (`count()` and the total
   * of `findManyWithCount()` with an empty filter) from the collection's
   * metadata (`estimatedDocumentCount`) instead of counting every document.
   * `true` applies to every table, a list to the named tables (collection
   * names). Views, filtered counts and counts inside a transaction always
   * count exactly. The estimate can drift from the exact count after an
   * unclean shutdown, and on a sharded cluster it includes orphaned documents.
   * Default: exact counts.
   */
  estimatedCount?: boolean | readonly string[];
  /**
   * Read a managed view through its own pipeline on the entry collection,
   * without the `$lookup` + `$unwind` stages of the joins the read does not
   * need (default `true`) — see the views guide, "Performance". `false`
   * always reads the stored view.
   * @since 0.1.153
   */
  viewJoinPruning?: boolean;
}

export class MongoAdapter extends BaseDbAdapter {
  private _collection?: Collection<any>;

  /** MongoDB-specific indexes (search, vector) — separate from table.indexes. */
  protected _mongoIndexes = new Map<string, TMongoIndex>();

  /** Vector search filter associations built during flattening (index key → filter fields). */
  protected _vectorFilters = new Map<string, Set<string>>();

  /** Default similarity thresholds per vector index (from @db.search.vector.threshold). */
  protected _vectorThresholds = new Map<string, number>();

  /** Cached search index lookup. */
  protected _searchIndexesMap?: Map<string, TMongoIndex>;

  /**
   * Search-field mappings recorded during `onFieldScanned`, applied in
   * `onAfterFlatten`. Deferred because resolving a nested field's container
   * shape (`document` vs `embeddedDocuments`) needs `this._table.flatMap`, which
   * is only safe to read once the metadata build is marked complete — i.e. in
   * `onAfterFlatten`, not mid-scan (the `flatMap` getter would re-enter `build`).
   */
  protected _pendingSearchFields: Array<{
    indexName: string | undefined;
    field: string;
    mappings: TSearchFieldMapping[];
  }> = [];

  /** Physical field names with @db.default.increment → optional start value. */
  protected _incrementFields = new Map<string, number | undefined>();

  /** Physical field names that have a non-binary collation (nocase/unicode). */
  private _collateFields?: Map<string, TDbCollation>;

  /** Capped collection options from @db.mongo.capped. */
  protected _cappedOptions?: { size: number; max?: number };

  /** Whether the schema explicitly defines _id (via @db.mongo.collection or manual _id field). */
  protected _hasExplicitId = false;

  /** Unique fields accumulated during onFieldScanned, returned via getMetadataOverrides. */
  private _pendingUniqueFields: string[] = [];

  constructor(
    protected readonly db: Db,
    protected readonly client?: MongoClient,
    protected readonly options: TMongoAdapterOptions = {},
  ) {
    super();
    this.viewJoinPruning = options.viewJoinPruning !== false;
  }

  // ── Transaction support ──────────────────────────────────────────────────

  private get _client() {
    return this.client;
  }

  /** Every adapter over this client (or database handle) shares one session (since 0.1.128). */
  protected override _transactionOwner(): unknown {
    return this.client ?? this.db;
  }

  /**
   * Same store = same client (or database handle) AND the same database: a
   * `$lookup` only reads collections of the pipeline's own database, and one
   * client may serve several (since 0.1.147).
   */
  override sharesStoreWith(other: BaseDbAdapter): boolean {
    return (
      other instanceof MongoAdapter &&
      other._transactionOwner() === this._transactionOwner() &&
      other.db.databaseName === this.db.databaseName
    );
  }

  /**
   * Per-client cache: whether transactions are unavailable (standalone MongoDB).
   * Shared across all adapter instances for the same client so topology is probed once.
   */
  private static readonly _txDisabledClients = new WeakSet<MongoClient>();

  private get _txDisabled(): boolean {
    return this.client ? MongoAdapter._txDisabledClients.has(this.client) : true;
  }

  private set _txDisabled(value: boolean) {
    if (value && this.client) {
      MongoAdapter._txDisabledClients.add(this.client);
    }
  }

  /**
   * Uses MongoDB's Convenient Transaction API (`session.withTransaction()`).
   * This handles txnNumber management and automatic retry for
   * `TransientTransactionError` / `UnknownTransactionCommitResult`.
   */
  override async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this._getTransactionState()) {
      return fn();
    }
    if (this._txDisabled || !this._client) {
      return fn();
    }
    try {
      const topology = (this._client as any).topology;
      if (topology) {
        const desc = topology.description ?? topology.s?.description;
        const type = desc?.type;
        if (type === "Single" || type === "Unknown") {
          this._txDisabled = true;
          return fn();
        }
      }
    } catch {
      this._txDisabled = true;
      return fn();
    }

    const session = this._client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await this._runInTransactionContext(session, fn);
      });
      return result;
    } finally {
      try {
        await session.endSession();
      } catch {
        /* preserve original error */
      }
    }
  }

  private static readonly _noSession: Record<string, never> = Object.freeze({}) as Record<
    string,
    never
  >;

  /** Returns `{ session }` opts if inside a transaction, empty object otherwise. */
  protected _getSessionOpts(): { session: ClientSession } | Record<string, never> {
    // Branded by owner: another adapter family's transaction is never handed out here.
    const session = this._getTransactionState() as ClientSession | undefined;
    return session ? { session } : MongoAdapter._noSession;
  }

  // ── Collection access ────────────────────────────────────────────────────

  get collection(): Collection<any> {
    if (!this._collection) {
      this._collection = this.db.collection(this.resolveTableName(false));
    }
    return this._collection;
  }

  aggregatePipeline(pipeline: Document[], options?: AggregateOptions): AggregationCursor {
    return this.collection.aggregate(pipeline, { ...options, ...this._getSessionOpts() });
  }

  override async aggregate(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    const {
      aggregateOptions,
      buildAggregatePipeline,
      buildCountPipeline,
      buildMatchedProbe,
      emptyGroupRow,
      emptyGroupStages,
    } = await import("../agg");
    // The one group of an ungrouped aggregate over no rows, after `$having` / `$skip` / `$limit`.
    // It exists only when ZERO input rows matched: an empty result may also mean
    // the real group was filtered out by `$having` / `$skip` / `$limit`.
    const emptyGroup = async (forCount: boolean) => {
      const row = emptyGroupRow(query);
      if (!row) return undefined;
      if (!query.controls?.$having) {
        // An ungrouped `$group` over ANY input row emits its one group, which
        // only `$skip` can then drop — and `$skip` drops the empty group the
        // same way. So an empty result alone tells: no round trip.
        return !forCount && query.controls?.$skip ? undefined : row;
      }
      const stages = emptyGroupStages(query, row, forCount);
      const probe = buildMatchedProbe(query, searchStage, this._predicateFilterOpts);
      const run = (pipeline: Document[]) =>
        wrapInvalidQuery(() => this.aggregatePipeline(pipeline).toArray());
      // `$having` is evaluated by the server on the empty group — alongside
      // the probe (one round trip), or after it inside a transaction.
      const [matched, applied] = this.isInTransaction()
        ? [await run(probe), undefined]
        : await Promise.all([run(probe), stages ? run(stages) : undefined]);
      if (matched.length > 0) return undefined;
      if (!stages) return row;
      return (applied ?? (await run(stages)))[0];
    };

    // Grouped-search contract: see `resolveAggregateSearch`. Resolved here
    // because it needs the adapter's index map, and shared by both builders so
    // rows and count can never describe different populations.
    const searchStage = buildAggregateSearchStage(this as any as TMongoSearchHost, query.controls);

    // A pruned view read (no search: a `$search` stage must come first)
    const run = (pipeline: Document[], label: string) => {
      const pruned = searchStage ? undefined : this._viewRead(query, "aggregate", pipeline);
      if (pruned) {
        return this._readPipeline(query, pipeline, label, pruned, aggregateOptions(pipeline));
      }
      this._log(label, pipeline);
      return wrapInvalidQuery(() =>
        this.aggregatePipeline(pipeline, aggregateOptions(pipeline)).toArray(),
      );
    };

    if (query.controls?.$count) {
      const pipeline = buildCountPipeline(query, searchStage, this._predicateFilterOpts);
      const result = await run(pipeline, "aggregate (count)");
      // An ungrouped aggregate over no rows is still one group (the row query's rule).
      return result.length > 0 ? result : [{ count: (await emptyGroup(true)) ? 1 : 0 }];
    }

    const pipeline = buildAggregatePipeline(query, searchStage, this._predicateFilterOpts);
    const rows = await run(pipeline, "aggregate");
    // An ungrouped aggregate over no rows is still one group (SQL's rule).
    const empty = rows.length === 0 ? await emptyGroup(false) : undefined;
    return empty ? [empty] : rows;
  }

  // ── ID handling ──────────────────────────────────────────────────────────

  get idType(): "string" | "number" | "objectId" {
    const idProp = (this._table.type as any).type.props.get("_id");
    const idTags = idProp?.type.tags;
    if ((idTags as Set<string>)?.has("objectId") && (idTags as Set<string>)?.has("mongo")) {
      return "objectId";
    }
    if (idProp?.type.kind === "") {
      return idProp.type.designType as "string" | "number";
    }
    return "objectId"; // fallback
  }

  override prepareId(id: unknown, _fieldType: unknown): unknown {
    const fieldType = _fieldType as TAtscriptAnnotatedType;
    const tags = fieldType.type.tags;
    if ((tags as Set<string>)?.has("objectId") && (tags as Set<string>)?.has("mongo")) {
      return id instanceof ObjectId ? id : new ObjectId(id as string);
    }
    if (fieldType.type.kind === "") {
      const dt = (fieldType.type as any).designType;
      if (dt === "number") {
        return Number(id);
      }
    }
    return String(id);
  }

  /**
   * Convenience method that uses `idType` to transform an ID value.
   * For use in controllers that don't have access to the field type.
   */
  prepareIdFromIdType<D = string | number | ObjectId>(id: string | number | ObjectId): D {
    switch (this.idType) {
      case "objectId": {
        return (id instanceof ObjectId ? id : new ObjectId(id as string)) as D;
      }
      case "number": {
        return Number(id) as D;
      }
      case "string": {
        return String(id) as D;
      }
      default: {
        throw new Error('Unknown "_id" type');
      }
    }
  }

  // ── Adapter capability overrides ─────────────────────────────────────────

  override supportsNestedObjects(): boolean {
    return true;
  }

  override supportsNativePatch(): boolean {
    return true;
  }

  /** Every unit, over MongoDB's bundled time zone database (see `agg.ts` `bucketExpression`). */
  override calendarBucketUnits(): ReadonlySet<BucketUnit> {
    return ALL_BUCKET_UNITS;
  }

  /** Every aggregate function: `countDistinct`, `first` and `last` included. */
  override aggregateFns(): ReadonlySet<AggregateFn> {
    return ALL_AGGREGATE_FNS;
  }

  /** Arithmetic in an aggregate `$select` (`{ $expr }`, `{ $fn, $expr }`). */
  override supportsAggregateExpressions(): boolean {
    return true;
  }

  /**
   * `$nulls` placement (since 0.1.153): a placed `$sort` / `$rowOrder` key
   * gets a null-or-missing flag ordered before it (`mongo-sort.ts`) — reads
   * then run as a pipeline with a blocking sort instead of `find().sort()`.
   */
  override supportsNullsPlacement(): boolean {
    return true;
  }

  /** Computed view columns and first-row joins. */
  override viewCapabilities(): ReadonlySet<TViewCapability> {
    return ALL_VIEW_CAPABILITIES;
  }

  /**
   * See BaseDbAdapter.viewRenderRevision. 2 = 0.1.137 (null-guarded field filters, nested document paths).
   * BUMP whenever `buildViewPipeline` output changes for an unchanged view definition.
   */
  override viewRenderRevision(): string {
    return "2";
  }

  override getValidatorPlugins(): ReturnType<BaseDbAdapter["getValidatorPlugins"]> {
    return [validateMongoIdPlugin];
  }

  /**
   * Mongo can filter on JSON-stored fields natively — arrays via implicit
   * `$in` and embedded documents via dot-paths — so JSON storage is not a
   * filterability blocker the way it is for SQL adapters.
   * `canSortField` keeps the conservative default (no sort on JSON storage):
   * sort-by-min/max-element on arrays is a footgun for generic UI sort headers.
   *
   * The `@db.encrypted` veto is core-supplied and absolute: ciphertext
   * envelopes cannot be filtered, no matter how permissive Mongo is.
   */
  override canFilterField(fd: TDbFieldMeta): boolean {
    return !fd.encrypted;
  }

  /**
   * Converts `db.geoPoint` tuples to/from GeoJSON Point storage:
   * write `[lng, lat]` → `{ type: 'Point', coordinates: [lng, lat] }`,
   * unwrap back to the tuple on read. Non-tuple values (e.g. `$geoWithin`
   * operator objects flowing through filter translation) pass through.
   *
   * Converts `mongo.objectId` values between wire hex strings and native
   * ObjectId storage. Filters, writes, and reads all flow through these
   * formatters, so id envelopes (`@DbActionID` row loading), FK filters
   * (`{ leadId: '<hex>' }`), and inserted documents match natively stored
   * ObjectIds — and reads return the hex strings the declared type promises.
   * Top-level fields only: nested values skip the write/read formatter passes,
   * so a nested formatter would coerce filters against un-coerced storage.
   */
  override formatValue(field: TDbFieldMeta) {
    if (field.isGeoPoint) {
      return {
        toStorage: (value: unknown) =>
          Array.isArray(value) &&
          value.length === 2 &&
          typeof value[0] === "number" &&
          typeof value[1] === "number"
            ? { type: "Point", coordinates: value }
            : value,
        fromStorage: (value: unknown) => {
          const v = value as { type?: string; coordinates?: unknown } | null;
          return v && typeof v === "object" && v.type === "Point" && Array.isArray(v.coordinates)
            ? v.coordinates
            : value;
        },
      };
    }
    if (!field.path.includes(".") && isObjectIdColumn(field.type)) {
      return { toStorage: objectIdToStorage, fromStorage: objectIdFromStorage };
    }
    return undefined;
  }

  // Uses default 'db.__topLevelArray' tag from base adapter

  override getAdapterTableName(_type: unknown): string | undefined {
    // @db.mongo.collection may inject _id but doesn't provide a name;
    // the table name comes from @db.table (handled by AtscriptDbTable).
    return undefined;
  }

  // ── Native relation loading ─────────────────────────────────────────────

  override supportsNativeRelations(): boolean {
    return true;
  }

  /**
   * Relational predicates (`{ nav: { $some | $none: … } }`) render as
   * correlated `$lookup` stages, so a read whose filter holds one runs as an
   * aggregation pipeline (find / count / findManyWithCount / grouped
   * aggregate / search / geo); predicate-free reads keep their plain
   * `find` / `countDocuments` path.
   *
   * Writes (`updateMany` / `replaceMany` / `deleteMany` and the single-row
   * variants, whose scope may carry a predicate) first resolve the matching
   * `_id`s through that pipeline, then write by `_id` in batches of
   * {@link REL_WRITE_BATCH} — re-checking the predicate-free part of the
   * filter. Inside an active transaction both steps share its session and
   * are atomic; without one there is a window between resolving and writing
   * in which a related document can change, so a written document may no
   * longer satisfy the predicate (or a newly matching one is missed).
   *
   * Collation: such a pipeline runs without an operation-wide `collation`
   * (it would govern the join keys and every related field too); each
   * table's `'nocase'` fields are compared case-insensitively explicitly
   * ({@link TMongoFilterOptions.collation}) — on reads and on these writes.
   *
   * @since 0.1.147
   */
  override supportsRelationFilters(_mode: "read" | "write"): boolean {
    return true;
  }

  /**
   * The `@db.column.collate` of a field (physical or logical path), or
   * `undefined` for a byte-wise one — how predicate pipelines render this
   * table's `'nocase'` comparisons ({@link TMongoFilterOptions.collation}).
   *
   * @since 0.1.147
   */
  fieldCollation(field: string): TDbCollation | undefined {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- trigger lazy init (onAfterFlatten)
    this._table.flatMap;
    return this._collateFields?.get(field);
  }

  /** Filter-rendering options of a pipeline with relational predicates on this table. */
  private get _predicateFilterOpts(): TMongoFilterOptions {
    return { collation: collationOfAdapter(this) };
  }

  /**
   * Operation options of a read: the request collation for a predicate-free
   * filter ({@link _getCollationOpts}); none with relational predicates —
   * those pipelines render collation per field ({@link _predicateFilterOpts}).
   */
  private _readOpts(query: DbQuery): Record<string, unknown> {
    return containsRelationFilter(query.filter)
      ? this._getSessionOpts()
      : { ...this._getCollationOpts(query), ...this._getSessionOpts() };
  }

  // oxlint-disable-next-line max-params -- matches BaseDbAdapter.loadRelations() signature
  override async loadRelations(
    rows: Array<Record<string, unknown>>,
    withRelations: WithRelation[],
    relations: ReadonlyMap<string, TDbRelation>,
    foreignKeys: ReadonlyMap<string, TDbForeignKey>,
    tableResolver?: TTableResolver,
  ): Promise<void> {
    return loadRelationsImpl(
      this as any as TMongoRelationHost,
      rows,
      withRelations,
      relations,
      foreignKeys,
      tableResolver,
    );
  }

  /** Returns the context object used by CollectionPatcher. */
  getPatcherContext(): TCollectionPatcherContext {
    return {
      flatMap: this._table.flatMap,
      prepareId: (id: any) => this.prepareIdFromIdType(id),
      createValidator: (opts?: Partial<TValidatorOptions>) =>
        this._table.createValidator(opts) as Validator<any>,
    };
  }

  // ── Native patch ─────────────────────────────────────────────────────────

  // oxlint-disable-next-line max-params
  override async nativePatch(
    filter: FilterExpr,
    patch: unknown,
    ops?: TFieldOps,
    expectedVersion?: number,
    opts?: TDbUpdateOptions,
  ): Promise<TDbUpdateResult> {
    const mongoFilter = await this._buildCasFilter(filter, expectedVersion, "nativePatch");
    if (!mongoFilter) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const versionColumn = this._versionColumnFor(opts, expectedVersion);
    // Inject auto-bump into ops.inc so the patcher emits it as a `version = version + 1`
    // aggregation expression alongside any user-supplied $inc / $mul ops.
    const effectiveOps =
      versionColumn !== undefined ? { ...ops, inc: { ...ops?.inc, [versionColumn]: 1 } } : ops;
    const patcher = new CollectionPatcher(this.getPatcherContext(), patch, effectiveOps);
    const { updateFilter, updateOptions } = patcher.preparePatch();
    this._log("updateOne (patch)", mongoFilter, updateFilter);
    return this._wrapUpdate(() =>
      this.collection.updateOne(mongoFilter, updateFilter, {
        ...updateOptions,
        ...this._getSessionOpts(),
      }),
    );
  }

  // ── Annotation scanning hooks ────────────────────────────────────────────

  override onBeforeFlatten(_type: unknown): void {
    const type = _type as TAtscriptAnnotatedType;
    const typeMeta = type.metadata;

    // @db.mongo.capped → store for collectionCreateOptions
    const capped = typeMeta.get("db.mongo.capped") as { size: number; max?: number } | undefined;
    if (capped) {
      this._cappedOptions = { size: capped.size, max: capped.max };
    }

    const dynamicText = typeMeta.get("db.mongo.search.dynamic");
    if (dynamicText) {
      this._setSearchIndex(
        "dynamic_text",
        "_",
        { mappings: { dynamic: true }, analyzer: dynamicText.analyzer },
        { fuzzy: normalizeSearchFuzzy(dynamicText.fuzzy) },
      );
    }
    for (const textSearch of typeMeta.get("db.mongo.search.static") || []) {
      this._setSearchIndex(
        "search_text",
        textSearch.indexName,
        { mappings: { fields: {} }, analyzer: textSearch.analyzer },
        {
          fuzzy: normalizeSearchFuzzy(textSearch.fuzzy),
          strategy: normalizeSearchStrategy(textSearch.strategy),
        },
      );
    }
  }

  override onFieldScanned(
    field: string,
    _type: unknown,
    metadata: TMetadataMap<AtscriptMetadata>,
  ): void {
    // Track _id presence (set by @db.mongo.collection or explicit _id field)
    if (field === "_id") {
      this._hasExplicitId = true;
    }
    // @meta.id on non-_id fields:
    // - Always add a unique index so findById can resolve by this field
    //   (registered in onAfterFlatten, on the stored path)
    // - Only remove from primaryKeys if the schema explicitly defines _id
    //   (via @db.mongo.collection). Otherwise keep it as PK for replace/update.
    if (field !== "_id" && metadata.has("meta.id")) {
      this._pendingUniqueFields.push(field);
    }
    // @db.index.fulltext is registered ONLY by core (`_addIndexField("fulltext", …)`),
    // which `syncIndexesImpl` converts to the single `atscript__fulltext__<name>`
    // text index. Re-scanning it here into `_mongoIndexes` as a separate
    // `atscript__text__<name>` index produced a SECOND text index — MongoDB allows
    // only one per collection, so sync threw IndexOptionsConflict (code 85).
    // Search dispatch derives the default text index from `table.indexes`, not
    // `_mongoIndexes`, so no adapter-level registration is needed.
    // @db.mongo.search.text — plain word matching (string mapping). Recorded
    // now, applied in onAfterFlatten (nested fields need a complete flatMap).
    for (const index of metadata.get("db.mongo.search.text") || []) {
      this._pendingSearchFields.push({
        indexName: index.indexName,
        field,
        mappings: [
          index.analyzer ? { type: "string", analyzer: index.analyzer } : { type: "string" },
        ],
      });
    }
    // @db.mongo.search.autocomplete — prefix/typeahead, double-mapped as string
    // so exact-word hits still rank.
    for (const ac of metadata.get("db.mongo.search.autocomplete") || []) {
      const autocomplete: TSearchFieldMapping = {
        type: "autocomplete",
        tokenization: (ac.tokenization as TSearchFieldMapping["tokenization"]) || "edgeGram",
        minGrams: ac.minGrams ?? 2,
        maxGrams: ac.maxGrams ?? 15,
        foldDiacritics: ac.foldDiacritics ?? true,
      };
      const companion: TSearchFieldMapping = ac.analyzer
        ? { type: "string", analyzer: ac.analyzer }
        : { type: "string" };
      this._pendingSearchFields.push({
        indexName: ac.indexName,
        field,
        mappings: [autocomplete, companion],
      });
    }
    // @db.search.vector (generic)
    const vectorIndex = metadata.get("db.search.vector");
    if (vectorIndex) {
      const indexName = vectorIndex.indexName || field;
      this._setSearchIndex(
        "vector",
        indexName,
        {
          fields: [
            {
              type: "vector",
              path: field,
              similarity: (vectorIndex.similarity || "cosine") as
                | "cosine"
                | "euclidean"
                | "dotProduct",
              numDimensions: vectorIndex.dimensions,
            },
          ],
        },
        { paths: [field] },
      );
      // @db.search.vector.threshold
      const threshold = metadata.get("db.search.vector.threshold");
      if (threshold !== undefined) {
        this._vectorThresholds.set(mongoIndexKey("vector", indexName), threshold);
      }
    }
    // @db.search.filter (generic) — each entry is a plain string (the index name)
    // A vector index may have several filter fields (and a field filter several indexes).
    for (const indexName of metadata.get("db.search.filter") || []) {
      const key = mongoIndexKey("vector", indexName);
      let fields = this._vectorFilters.get(key);
      if (!fields) {
        fields = new Set();
        this._vectorFilters.set(key, fields);
      }
      fields.add(field);
    }
  }

  override getMetadataOverrides(meta: TableMetadata): TMetadataOverrides {
    const uniqueFields = this._pendingUniqueFields;

    if (this._hasExplicitId) {
      // Schema defines _id explicitly (via @db.mongo.collection or manual field).
      // _id is the primary key; remove non-_id @meta.id fields from PKs (they become
      // one `__pk` unique index — a composite one is unique as a whole, no field alone).
      return {
        addPrimaryKeys: ["_id"],
        removePrimaryKeys: meta.originalMetaIdFields.filter((f) => f !== "_id"),
        addUniqueFields: uniqueFields.length === 1 ? uniqueFields : undefined,
        addUniqueKeys: uniqueFields.length > 1 ? [[...uniqueFields]] : undefined,
      };
    }

    // Schema does NOT define _id. The user's @meta.id field is the primary key
    // for replace/update operations. Inject a synthetic _id as unique field so
    // that findById can resolve ObjectId strings via _resolveIdFilter.
    //
    // For composite PKs, individual @meta.id fields are NOT individually unique —
    // only the combination is. Don't promote them to uniqueProps, otherwise
    // _extractRecordFilter resolves a partial composite PK via the single-field
    // unique fallback instead of rejecting it.
    const effectiveUnique = uniqueFields.filter(
      (f) => meta.primaryKeys.length <= 1 || !meta.primaryKeys.includes(f),
    );
    effectiveUnique.push("_id");
    return {
      injectFields: [
        {
          path: "_id",
          type: {
            __is_atscript_annotated_type: true,
            type: { kind: "", designType: "string", tags: new Set(["objectId", "mongo"]) },
            metadata: new Map(),
          } as any,
        },
      ],
      addUniqueFields: effectiveUnique,
    };
  }

  override onAfterFlatten(): void {
    // The `__pk` unique index of each non-_id `@meta.id` field — on the
    // STORED key: a `@db.column` rename is the document's key, so an index on
    // the logical name would see `null` in every document.
    const meta = this._table.getMetadata();
    for (const field of this._pendingUniqueFields) {
      this._addMongoIndexField("unique", "__pk", meta.documentPath(field));
    }

    // Apply deferred search-field mappings now that flatMap is complete and
    // safe to read (build is marked done before this hook runs). Nested fields
    // are resolved into `document` / `embeddedDocuments` container nodes here.
    for (const pending of this._pendingSearchFields) {
      this._addFieldToSearchIndex(
        "search_text",
        pending.indexName,
        pending.field,
        pending.mappings,
      );
    }
    this._pendingSearchFields = [];

    // MongoDB allows ONE text index per collection: a second fulltext index
    // name with TEXT members cannot exist physically, yet `$text` would search
    // the first while the visibility gate checked the second's fields.
    // (Integer-only fulltext indexes have no physical artifact and stay valid.)
    const textBearing = [...this._table.indexes.values()].filter(
      (i) => i.type === "fulltext" && i.fields.some((f) => !f.integer),
    );
    if (textBearing.length > 1) {
      throw new Error(
        `MongoDB allows one text index per collection: "${this._table.tableName}" declares ` +
          `${textBearing.length} @db.index.fulltext names with text fields ` +
          `(${textBearing.map((i) => `"${i.name}"`).join(", ")}). Merge them into one name; ` +
          `integer-only fulltext indexes may be declared separately.`,
      );
    }

    // Integer fulltext members: every static Atlas text index maps them as
    // numbers so the `equals` clause can reach them (and `paths` — the
    // visibility gate — lists them). `dynamic_text` indexes numbers already.
    for (const fulltext of this._table.indexes.values()) {
      if (fulltext.type !== "fulltext" || !fulltext.fields.some((f) => f.integer)) continue;
      const logical = this._indexLogicalPaths(fulltext);
      for (const index of this._mongoIndexes.values()) {
        if (index.type !== "search_text") continue;
        fulltext.fields.forEach((f, i) => {
          if (f.integer) {
            this._addFieldToSearchIndex("search_text", index.name, logical[i]!, [
              { type: "number" },
            ]);
          }
        });
      }
    }

    // Associate vector filter fields with their vector indexes
    for (const [key, fields] of this._vectorFilters.entries()) {
      const index = this._mongoIndexes.get(key);
      if (index && index.type === "vector") {
        for (const path of fields) {
          index.definition.fields?.push({ type: "filter", path });
        }
      }
    }

    for (const fd of this._table.fieldDescriptors) {
      // Non-binary collations for query-time collation injection — keyed by
      // the logical path too: request insights name logical fields.
      if (fd.collate && fd.collate !== "binary") {
        this._collateFields ??= new Map();
        this._collateFields.set(fd.path, fd.collate);
        this._collateFields.set(fd.physicalName, fd.collate);
      }
      // @db.default.increment → auto-increment on insert (optional start value)
      const def = fd.defaultValue;
      if (def?.kind === "fn" && def.fn === "increment") {
        this._incrementFields.set(fd.physicalName, def.start);
      }
    }
  }

  // ── Search index management ──────────────────────────────────────────────

  /** Returns MongoDB-specific search index map (internal). */
  getMongoSearchIndexes(): Map<string, TMongoIndex> {
    if (!this._searchIndexesMap) {
      // Trigger flattening to ensure indexes are built
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- trigger lazy init
      this._table.flatMap;

      this._searchIndexesMap = new Map();
      let defaultIndex: TMongoIndex | undefined;

      // Generic fulltext indexes from table.indexes. The default is the first
      // one with a TEXT member (else the first); every other one is addressable
      // by its name through `$index` (an integer-only index has no physical text
      // artifact and answers exact-number terms only).
      const fulltexts = [...this._table.indexes.values()].filter((i) => i.type === "fulltext");
      const defaultFulltext = defaultFulltextIndex(fulltexts);
      for (const index of fulltexts) {
        // Integer members are matched by exact number (getNumericSearchKeys),
        // never part of the text index.
        const converted: TMongoIndex = {
          key: index.key,
          name: index.name,
          type: "text",
          fields: Object.fromEntries(
            index.fields.filter((f) => !f.integer).map((f) => [f.name, "text" as const]),
          ),
          weights: Object.fromEntries(
            index.fields.filter((f) => f.weight && !f.integer).map((f) => [f.name, f.weight!]),
          ),
        };
        if (index === defaultFulltext) {
          defaultIndex = converted;
        } else if (!this._searchIndexesMap.has(index.name)) {
          this._searchIndexesMap.set(index.name, converted);
        }
      }

      for (const index of this._mongoIndexes.values()) {
        switch (index.type) {
          case "text": {
            if (!defaultIndex) {
              defaultIndex = index;
            }
            break;
          }
          case "dynamic_text": {
            defaultIndex = index;
            break;
          }
          case "search_text": {
            if (!defaultIndex || defaultIndex.type === "text") {
              defaultIndex = index;
            }
            this._searchIndexesMap.set(index.name, index);
            break;
          }
          case "vector": {
            this._searchIndexesMap.set(index.name, index);
            break;
          }
          default:
        }
      }

      if (defaultIndex && !this._searchIndexesMap.has(DEFAULT_INDEX_NAME)) {
        this._searchIndexesMap.set(DEFAULT_INDEX_NAME, defaultIndex);
      }
    }
    return this._searchIndexesMap;
  }

  /**
   * Stored paths of the integer members matched by exact number next to a
   * text search on `index` (since 0.1.150). A classic text index contributes
   * the integer members of its own `@db.index.fulltext` (per index, as on the
   * SQL adapters); an Atlas index the integer members it maps (every fulltext
   * integer member is mapped, so they are in its reported `paths`).
   */
  getNumericSearchKeys(index: TMongoIndex): readonly string[] {
    // Trigger flattening so the index list is built.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- trigger lazy init
    this._table.flatMap;
    const keys = new Set<string>();
    if (index.type === "text") {
      const source = this._table.indexes.get(index.key);
      if (source?.type === "fulltext") {
        for (const f of source.fields) if (f.integer) keys.add(f.name);
      }
    } else {
      for (const fulltext of this._table.indexes.values()) {
        if (fulltext.type !== "fulltext") continue;
        for (const f of fulltext.fields) if (f.integer) keys.add(f.name);
      }
    }
    return [...keys];
  }

  /** Returns a specific MongoDB search index by name. */
  getMongoSearchIndex(name = DEFAULT_INDEX_NAME): TMongoIndex | undefined {
    return this.getMongoSearchIndexes().get(name);
  }

  /** Returns the default similarity threshold for a vector index (from @db.search.vector.threshold). */
  getVectorThreshold(indexName?: string): number | undefined {
    const key = mongoIndexKey("vector", indexName || DEFAULT_INDEX_NAME);
    return this._vectorThresholds.get(key);
  }

  // ── Search overrides ────────────────────────────────────────────────────

  override getSearchIndexes(): TSearchIndexInfo[] {
    return getSearchIndexesImpl(this as any as TMongoSearchHost);
  }
  override isVectorSearchable(): boolean {
    return isVectorSearchableImpl(this as any as TMongoSearchHost);
  }
  override async search(text: string, query: DbQuery, indexName?: string) {
    return searchImpl(this as any as TMongoSearchHost, text, query, indexName);
  }
  override async searchWithCount(text: string, query: DbQuery, indexName?: string) {
    return searchWithCountImpl(this as any as TMongoSearchHost, text, query, indexName);
  }
  override async vectorSearch(vector: number[], query: DbQuery, indexName?: string) {
    return vectorSearchImpl(this as any as TMongoSearchHost, vector, query, indexName);
  }
  override async vectorSearchWithCount(vector: number[], query: DbQuery, indexName?: string) {
    return vectorSearchWithCountImpl(this as any as TMongoSearchHost, vector, query, indexName);
  }

  // ── Geo search ───────────────────────────────────────────────────────────

  override isGeoSearchable(): boolean {
    return true;
  }
  override async geoSearch(point: [number, number], query: DbQuery, indexName?: string) {
    return geoSearchImpl(this as any as TMongoGeoHost, point, query, indexName);
  }
  override async geoSearchWithCount(point: [number, number], query: DbQuery, indexName?: string) {
    return geoSearchWithCountImpl(this as any as TMongoGeoHost, point, query, indexName);
  }

  /**
   * A page and the total count. A predicate-free filter runs as a `find` plus
   * a `countDocuments` (each index-backed, no `$facet` holding every matching
   * document) — concurrently, or one after the other inside a transaction
   * (a session runs one operation at a time). Relational predicates need the
   * `$lookup` pipeline, so they keep the single `$facet` aggregation.
   */
  override async findManyWithCount(
    query: DbQuery,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    if (!containsRelationFilter(query.filter)) {
      const counted = () => wrapInvalidQuery(() => this.count(query));
      if (this.isInTransaction()) {
        const data = await this.findMany(query);
        return { data, count: await counted() };
      }
      const [data, count] = await Promise.all([this.findMany(query), counted()]);
      return { data, count };
    }
    const pipeline: Document[] = [
      ...mongoFilterStages(query.filter, this._predicateFilterOpts),
      { $facet: { data: pageStages(query.controls), meta: [{ $count: "count" }] } },
    ];

    const pruned = this._viewRead(query, "rows", pipeline);
    const result = await this._readPipeline(
      query,
      pipeline,
      "aggregate (findManyWithCount)",
      pruned,
    );
    return {
      data: result[0]?.data || [],
      count: result[0]?.meta[0]?.count || 0,
    };
  }

  // ── Collection existence ─────────────────────────────────────────────────

  async collectionExists(): Promise<boolean> {
    const cols = await this.db.listCollections({ name: this._table.tableName }).toArray();
    return cols.length > 0;
  }

  async ensureCollectionExists(): Promise<void> {
    const exists = await this.collectionExists();
    if (!exists) {
      this._log("createCollection", this._table.tableName);
      await this.db.createCollection(this._table.tableName, this.collectionCreateOptions());
    }
  }

  /** `createCollection` options for this table (`@db.mongo.capped` size/max). */
  collectionCreateOptions(): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      comment: "Created by Atscript Mongo Adapter",
    };
    if (this._cappedOptions) {
      opts.capped = true;
      opts.size = this._cappedOptions.size;
      if (this._cappedOptions.max !== null && this._cappedOptions.max !== undefined) {
        opts.max = this._cappedOptions.max;
      }
    }
    return opts;
  }

  /**
   * Builds a Mongo filter for CAS-aware writes. Throws when `expectedVersion`
   * is supplied for a non-versioned table — fail loud at the adapter boundary
   * rather than silently dropping the CAS predicate.
   */
  private async _buildCasFilter(
    filter: FilterExpr,
    expectedVersion: number | undefined,
    op: string,
  ): Promise<Record<string, unknown> | undefined> {
    const versionColumn = this._table.versionColumnPhysical;
    if (expectedVersion !== undefined && versionColumn === undefined) {
      throw new Error(`${op}: expectedVersion requires versionColumn`);
    }
    const mongoFilter = await this._writeFilterOne(filter);
    if (!mongoFilter) {
      return undefined;
    }
    if (expectedVersion !== undefined && versionColumn !== undefined) {
      (mongoFilter as Record<string, unknown>)[versionColumn] = expectedVersion;
    }
    return mongoFilter as Record<string, unknown>;
  }

  /**
   * The id-resolving pipeline of a write filter holding relational
   * predicates: the matching `_id`s (in the active transaction's session,
   * if any), each table's `'nocase'` fields compared like on reads
   * ({@link _predicateFilterOpts}). `pre` is the predicate-free part, which
   * every `_id`-based write re-checks — so a document that stopped matching
   * it in between is not written.
   */
  private _predicateWritePlan(filter: FilterExpr): { pipeline: Document[]; pre?: Filter<any> } {
    const plan = buildMongoQuery(filter, this._predicateFilterOpts);
    return { pipeline: planStages(plan), pre: plan.pre };
  }

  /** A write filter's `_id` filter (re-checking `pre`). */
  private static _byIds(ids: unknown[], pre: Filter<any> | undefined): Filter<any> {
    const byId: Filter<any> = ids.length === 1 ? { _id: ids[0] } : { _id: { $in: ids } };
    return pre ? { $and: [byId, pre] } : byId;
  }

  /** Single-document write over a predicate filter: the first match's `_id` filter (`undefined`: none). */
  private async _predicateWriteFilterOne(filter: FilterExpr): Promise<Filter<any> | undefined> {
    const { pipeline, pre } = this._predicateWritePlan(filter);
    pipeline.push({ $limit: 1 }, { $project: { _id: 1 } });
    this._log("aggregate (write id)", pipeline);
    const [doc] = await wrapInvalidQuery(() => this.aggregatePipeline(pipeline).toArray());
    return doc ? MongoAdapter._byIds([doc._id], pre) : undefined;
  }

  /**
   * Multi-document write over `filter`: a predicate-free filter is written
   * as is; one with predicates calls `write` with one `_id`-based filter per
   * batch of {@link REL_WRITE_BATCH} matching ids, streamed from the cursor
   * (never all ids in memory at once).
   *
   * The ids come sorted by `_id`, so writes made while the cursor is open
   * can never feed back into it (otherwise a document an update moves within
   * the index the cursor scans could be returned — and written — twice):
   * after the `$lookup`s that `$sort` consumes every match before the first
   * batch returns, and an `_id` order read from the `_id` index is stable
   * (`_id` never changes).
   */
  private async _forEachMatching(
    filter: FilterExpr,
    write: (mongoFilter: Filter<any>) => Promise<void>,
  ): Promise<void> {
    if (!containsRelationFilter(filter)) {
      return write(buildMongoFilter(filter));
    }
    const { pipeline, pre } = this._predicateWritePlan(filter);
    pipeline.push({ $project: { _id: 1 } }, { $sort: { _id: 1 } });
    this._log("aggregate (write ids)", pipeline);
    // The blocking `$sort` may exceed the in-memory sort limit on large
    // matches; servers before 6.0 spill to disk only with `allowDiskUse`.
    const cursor = this.aggregatePipeline(pipeline, { allowDiskUse: true }).batchSize(
      REL_WRITE_BATCH,
    );
    try {
      const next = () => wrapInvalidQuery(() => cursor.next());
      let ids: unknown[] = [];
      for (let doc = await next(); doc; doc = await next()) {
        ids.push(doc._id);
        if (ids.length === REL_WRITE_BATCH) {
          await write(MongoAdapter._byIds(ids, pre));
          ids = [];
        }
      }
      if (ids.length > 0) {
        await write(MongoAdapter._byIds(ids, pre));
      }
    } finally {
      await cursor.close();
    }
  }

  /** Runs an update-shaped write over `filter` ({@link _forEachMatching}), counts summed. */
  private async _updateMatching(
    filter: FilterExpr,
    write: (mongoFilter: Filter<any>) => Promise<TDbUpdateResult>,
  ): Promise<TDbUpdateResult> {
    const total: TDbUpdateResult = { matchedCount: 0, modifiedCount: 0 };
    await this._forEachMatching(filter, async (mongoFilter) => {
      const result = await write(mongoFilter);
      total.matchedCount += result.matchedCount;
      total.modifiedCount += result.modifiedCount;
    });
    return total;
  }

  /** The filter of a single-document write — its predicates resolved to one `_id`. */
  private _writeFilterOne(filter: FilterExpr) {
    return containsRelationFilter(filter)
      ? this._predicateWriteFilterOne(filter)
      : buildMongoFilter(filter);
  }

  /**
   * Wraps an async operation to catch MongoDB duplicate key errors
   * (code 11000) and rethrow as structured `DbError` — every write path
   * (insert, replace, update, patch, their `*Many` variants) goes through it,
   * so a unique-index violation is a `CONFLICT` whichever statement hit it.
   */
  private async _wrapDuplicateKeyError<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (error: unknown) {
      return this._mapConstraintError(error);
    }
  }

  /** Rethrows a duplicate-key (11000) server error as `CONFLICT`, anything else as is. */
  private _mapConstraintError(error: unknown): never {
    if (error instanceof MongoServerError && error.code === 11000) {
      const field = error.keyPattern ? (Object.keys(error.keyPattern)[0] ?? "") : "";
      throw new DbError("CONFLICT", [{ path: field, message: error.message }]);
    }
    throw error;
  }

  /** An update-shaped write under {@link _wrapDuplicateKeyError}, reduced to `TDbUpdateResult`. */
  private async _wrapUpdate(
    fn: () => Promise<{ matchedCount: number; modifiedCount: number }>,
  ): Promise<TDbUpdateResult> {
    const { matchedCount, modifiedCount } = await this._wrapDuplicateKeyError(fn);
    return { matchedCount, modifiedCount };
  }

  // ── CRUD implementation ──────────────────────────────────────────────────

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    // §4.6 — Mongo has no DDL DEFAULT; the adapter fills in version=0 at insert
    // time when missing so OCC stays consistent with the SQL adapters.
    const versionColumn = this._table.versionColumnPhysical;
    if (versionColumn !== undefined && !(versionColumn in data)) {
      data[versionColumn] = 0;
    }
    if (this._incrementFields.size > 0) {
      const fields = this._fieldsNeedingIncrement(data);
      if (fields.length > 0) {
        const nextValues = await this._allocateIncrementValues(fields, 1);
        for (const physical of fields) {
          data[physical] = nextValues.get(physical) ?? 1;
        }
      }
    }
    this._log("insertOne", data);
    const result = await this._wrapDuplicateKeyError(() =>
      this.collection.insertOne(data, this._getSessionOpts()),
    );
    return { insertedId: objectIdFromStorage(this._resolveInsertedId(data, result.insertedId)) };
  }

  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    await this._prepareInsertBatch(data);

    this._log("insertMany", `${data.length} docs`);
    const result = await this._wrapDuplicateKeyError(() =>
      this.collection.insertMany(data, this._getSessionOpts()),
    );
    return {
      insertedCount: result.insertedCount,
      insertedIds: data.map((item, i) =>
        objectIdFromStorage(this._resolveInsertedId(item, result.insertedIds[i])),
      ),
    };
  }

  override supportsInsertIgnore(): boolean {
    return true;
  }

  /**
   * Conflict-ignoring batch insert (the core already removed in-batch duplicates).
   *
   * Outside a transaction: `insertMany(…, { ordered: false })`; duplicate-key
   * write errors (11000) mark the skipped rows, every other write error
   * rethrows after the batch (rows already written stay — as for a plain
   * non-transactional `insertMany`).
   *
   * Inside a transaction a duplicate key would abort the transaction even with
   * `ordered: false`, so the stored keys are looked up first (inside the
   * session), the matches are skipped and the rest is inserted ordered. A
   * residual 11000 (e.g. a collation-equal value) throws `CONFLICT`.
   */
  override async insertManyIgnore(
    data: Array<Record<string, unknown>>,
  ): Promise<TDbInsertIgnoreSlot[]> {
    if (data.length === 0) return [];
    await this._prepareInsertBatch(data);
    this._log("insertManyIgnore", `${data.length} docs`);
    const idOf = (item: Record<string, unknown>) =>
      objectIdFromStorage(this._resolveInsertedId(item, item._id));

    if (this._getTransactionState()) {
      const skipped = await this._findStoredKeyConflicts(data);
      const survivors = data.filter((_, i) => !skipped.has(i));
      if (survivors.length > 0) {
        await this._wrapDuplicateKeyError(() =>
          this.collection.insertMany(survivors, { ordered: true, ...this._getSessionOpts() }),
        );
      }
      return data.map((item, i) => (skipped.has(i) ? null : { insertedId: idOf(item) }));
    }

    const skipped = new Set<number>();
    try {
      await this.collection.insertMany(data, { ordered: false, ...this._getSessionOpts() });
    } catch (error) {
      if (!(error instanceof MongoBulkWriteError)) this._mapConstraintError(error);
      const writeErrors = [error.writeErrors].flat().filter(Boolean);
      // Only a bulk error made of duplicate-key write errors is a skip. No write error at all
      // (a write-concern failure, a lost acknowledgement) says nothing about which rows were
      // written: never report them inserted.
      if (writeErrors.length === 0 || hasWriteConcernError(error)) throw error;
      for (const writeError of writeErrors) {
        if (writeError.code !== 11000) throw error;
        skipped.add(writeError.index);
      }
    }
    return data.map((item, i) => (skipped.has(i) ? null : { insertedId: idOf(item) }));
  }

  /**
   * Indices of `data` rows whose primary (`_id`) or unique-index key tuple is
   * already stored (rows with a null / missing key component never collide).
   * One `$or` query per chunk covers every key set.
   */
  private async _findStoredKeyConflicts(
    data: Array<Record<string, unknown>>,
  ): Promise<Set<number>> {
    // `_id` (driver-assigned or explicit), the declared primary key (a unique
    // index on its own fields when it is not `_id`) and every unique index.
    const keySets: string[][] = [
      ["_id"],
      ...this._table.uniqueKeySets.filter((f) => !(f.length === 1 && f[0] === "_id")),
    ];
    const rowTuples = data.map((row) => keySets.map((fields) => uniqueKeyTuple(row, fields)));
    const projection = Object.fromEntries(keySets.flat().map((f) => [f, 1]));

    const stored = keySets.map(() => new Set<string>());
    const CHUNK = 1000;
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      const clauses: Document[] = [];
      keySets.forEach((fields, k) => {
        const rows = data.slice(offset, offset + CHUNK).filter((_, i) => rowTuples[offset + i]![k]);
        if (rows.length === 0) return;
        if (fields.length === 1) {
          clauses.push({ [fields[0]!]: { $in: rows.map((row) => getPath(row, fields[0]!)) } });
        } else {
          for (const row of rows) {
            clauses.push(Object.fromEntries(fields.map((f) => [f, getPath(row, f)])));
          }
        }
      });
      if (clauses.length === 0) continue;
      const found = await this.collection
        .find({ $or: clauses }, { projection, ...this._getSessionOpts() })
        .toArray();
      for (const doc of found) {
        keySets.forEach((fields, k) => {
          const tuple = uniqueKeyTuple(doc as Record<string, unknown>, fields);
          if (tuple !== undefined) stored[k]!.add(tuple);
        });
      }
    }
    const skipped = new Set<number>();
    rowTuples.forEach((tuples, i) => {
      if (tuples.some((t, k) => t !== undefined && stored[k]!.has(t))) skipped.add(i);
    });
    return skipped;
  }

  /** Version default + `@db.default.increment` allocation shared by every batch insert. */
  private async _prepareInsertBatch(data: Array<Record<string, unknown>>): Promise<void> {
    // §4.6 — version default per item (parity with SQL DDL DEFAULT 0).
    const versionColumn = this._table.versionColumnPhysical;
    if (versionColumn !== undefined) {
      for (const item of data) {
        if (!(versionColumn in item)) {
          item[versionColumn] = 0;
        }
      }
    }
    if (this._incrementFields.size > 0) {
      // Collect all increment fields that any item needs
      const allFields = new Set<string>();
      for (const item of data) {
        for (const f of this._fieldsNeedingIncrement(item)) {
          allFields.add(f);
        }
      }

      if (allFields.size > 0) {
        await this._assignBatchIncrements(data, allFields);
      }
    }
  }

  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    const pruned = this._prunedFind(query, "findOne", 1);
    if (pruned) {
      const [row] = await pruned;
      return row ?? null;
    }
    if (containsRelationFilter(query.filter) || hasNullsPlacement(query.controls)) {
      const [row] = await this._aggregateFind(query, "findOne", 1);
      return row ?? null;
    }
    const filter = buildMongoFilter(query.filter);
    const opts = this._buildFindOptions(query.controls);
    this._log("findOne", filter, opts);
    return wrapInvalidQuery(() =>
      this.collection.findOne(filter, {
        ...opts,
        ...this._getCollationOpts(query),
        ...this._getSessionOpts(),
      }),
    );
  }

  async findMany(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    const pruned = this._prunedFind(query, "findMany");
    if (pruned) return pruned;
    if (containsRelationFilter(query.filter) || hasNullsPlacement(query.controls)) {
      return this._aggregateFind(query, "findMany");
    }
    const filter = buildMongoFilter(query.filter);
    const opts = this._buildFindOptions(query.controls);
    this._log("findMany", filter, opts);
    return wrapInvalidQuery(() =>
      // eslint-disable-next-line unicorn/no-array-method-this-argument -- MongoDB Collection.find, not Array.find
      this.collection
        .find(filter, { ...opts, ...this._getCollationOpts(query), ...this._getSessionOpts() })
        .toArray(),
    );
  }

  async count(query: DbQuery): Promise<number> {
    // Predicates need `$lookup` — counted in a pipeline (`countDocuments` takes a
    // filter only); so is a pruned view read.
    const stages = () => [
      ...mongoFilterStages(query.filter, this._predicateFilterOpts),
      { $count: "count" },
    ];
    const pruned = this._viewRead(query, "count", stages);
    if (pruned || containsRelationFilter(query.filter)) {
      const pipeline = pruned?.pipeline ?? stages();
      const result = await this._readPipeline(query, pipeline, "aggregate (count)", pruned);
      return (result[0]?.count as number | undefined) ?? 0;
    }
    const filter = buildMongoFilter(query.filter);
    if (this._estimatesCount() && Object.keys(filter).length === 0) {
      this._log("estimatedDocumentCount");
      return this.collection.estimatedDocumentCount();
    }
    this._log("countDocuments", filter);
    return this.collection.countDocuments(filter, {
      ...this._getCollationOpts(query),
      ...this._getSessionOpts(),
    });
  }

  // oxlint-disable-next-line max-params
  async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
    expectedVersion?: number,
    opts?: TDbUpdateOptions,
  ): Promise<TDbUpdateResult> {
    const mongoFilter = await this._buildCasFilter(filter, expectedVersion, "updateOne");
    if (!mongoFilter) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    // A keepVersion patch is never empty (exempt-only has >= 1 key), so no `{}` update doc.
    const updateDoc = buildMongoUpdateDoc(data, ops, this._versionColumnFor(opts, expectedVersion));
    this._log("updateOne", mongoFilter, updateDoc);
    return this._wrapUpdate(() =>
      this.collection.updateOne(mongoFilter, updateDoc, this._getSessionOpts()),
    );
  }

  async replaceOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<TDbUpdateResult> {
    const mongoFilter = await this._buildCasFilter(filter, expectedVersion, "replaceOne");
    if (!mongoFilter) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const versionColumn = this._table.versionColumnPhysical;
    this._log("replaceOne", mongoFilter, data);
    if (versionColumn !== undefined) {
      // Mongo's plain replaceOne doesn't accept $inc, so use an aggregation
      // pipeline update via $replaceWith — the replacement document is rebuilt
      // with `version` set to `$<col> + 1`, evaluated atomically server-side.
      const pipeline = [
        {
          $replaceWith: {
            ...data,
            [versionColumn]: { $add: [`$${versionColumn}`, 1] },
          },
        },
      ];
      return this._wrapUpdate(() =>
        this.collection.updateOne(mongoFilter, pipeline, this._getSessionOpts()),
      );
    }
    return this._wrapUpdate(() =>
      this.collection.replaceOne(mongoFilter, data, this._getSessionOpts()),
    );
  }

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    const mongoFilter = await this._writeFilterOne(filter);
    if (!mongoFilter) {
      return { deletedCount: 0 };
    }
    this._log("deleteOne", mongoFilter);
    const result = await this.collection.deleteOne(mongoFilter, this._getSessionOpts());
    return { deletedCount: result.deletedCount };
  }

  async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
    opts?: TDbUpdateOptions,
  ): Promise<TDbUpdateResult> {
    // Locked decision row 2 — updateMany never CAS-checks. Still auto-bumps,
    // unless `opts.keepVersion` (a version-exempt patch).
    const versionColumn = this._versionColumnFor(opts);
    const updateDoc = buildMongoUpdateDoc(data, ops, versionColumn);
    return this._updateMatching(filter, (mongoFilter) => {
      this._log("updateMany", mongoFilter, updateDoc);
      return this._wrapUpdate(() =>
        this.collection.updateMany(mongoFilter, updateDoc, this._getSessionOpts()),
      );
    });
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    // MongoDB has no native replaceMany; use updateMany with $set (+ auto-bump
    // version when this table is versioned — sibling of updateMany, no CAS).
    const updateDoc = buildMongoUpdateDoc(data, undefined, this._table.versionColumnPhysical);
    return this._updateMatching(filter, (mongoFilter) => {
      this._log("replaceMany", mongoFilter, updateDoc);
      return this._wrapUpdate(() =>
        this.collection.updateMany(mongoFilter, updateDoc, this._getSessionOpts()),
      );
    });
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    let deletedCount = 0;
    await this._forEachMatching(filter, async (mongoFilter) => {
      this._log("deleteMany", mongoFilter);
      const result = await this.collection.deleteMany(mongoFilter, this._getSessionOpts());
      deletedCount += result.deletedCount;
    });
    return { deletedCount };
  }

  // ── Schema / Index sync ──────────────────────────────────────────────────

  clearCollectionCache(): void {
    this._collection = undefined;
  }

  async tableExists(): Promise<boolean> {
    return tableExistsImpl(this as any as TMongoSchemaSyncHost);
  }
  async ensureTable(): Promise<void> {
    // No inline constraints on MongoDB — `deferForeignKeysTo` does not apply
    return ensureTableImpl(this as any as TMongoSchemaSyncHost, this._table);
  }
  async hasRows(tableName?: string): Promise<boolean> {
    return hasRowsImpl(this as any as TMongoSchemaSyncHost, tableName);
  }
  async getObjectKind(name: string): Promise<TDbObjectKind | undefined> {
    return getObjectKindImpl(this as any as TMongoSchemaSyncHost, name);
  }
  /**
   * No physical primary key on MongoDB (`_id` is fixed): a `@meta.id` move is
   * an index change that `syncIndexes` reconciles. Schema sync refuses the
   * change on a populated collection for cross-adapter consistency.
   */
  async rebuildPrimaryKey(_change: TPrimaryKeyChange): Promise<void> {}
  override async syncIndexes(): Promise<void> {
    return syncIndexesImpl(this as any as TMongoSchemaSyncHost);
  }
  async syncColumns(diff: TColumnDiff): Promise<TSyncColumnResult> {
    return syncColumnsImpl(this as any as TMongoSchemaSyncHost, diff);
  }
  async dropColumns(columns: string[]): Promise<void> {
    return dropColumnsImpl(this as any as TMongoSchemaSyncHost, columns);
  }
  async renameTable(oldName: string): Promise<void> {
    return renameTableImpl(this as any as TMongoSchemaSyncHost, oldName);
  }
  async recreateTable(): Promise<void> {
    return recreateTableImpl(this as any as TMongoSchemaSyncHost);
  }
  async dropTable(): Promise<void> {
    return dropTableImpl(this as any as TMongoSchemaSyncHost);
  }
  override async dropViewByName(viewName: string): Promise<void> {
    return dropViewByNameImpl(this as any as TMongoSchemaSyncHost, viewName);
  }
  override async dropTableByName(tableName: string): Promise<void> {
    return dropTableByNameImpl(this as any as TMongoSchemaSyncHost, tableName);
  }
  override getDesiredTableOptions(): TExistingTableOption[] {
    return getDesiredTableOptionsImpl(this._cappedOptions);
  }
  override async getExistingTableOptions(tableName?: string): Promise<TExistingTableOption[]> {
    return getExistingTableOptionsImpl(this as any as TMongoSchemaSyncHost, tableName);
  }
  override destructiveOptionKeys(): ReadonlySet<string> {
    return DESTRUCTIVE_OPTION_KEYS;
  }

  /**
   * Whether an unfiltered count of this table may be answered from metadata
   * ({@link TMongoAdapterOptions.estimatedCount}): opted in, a collection (not
   * a view), and not inside a transaction (`estimatedDocumentCount` cannot
   * run in one).
   */
  private _estimatesCount(): boolean {
    const opt = this.options.estimatedCount;
    if (!opt || this._table.isView || this.isInTransaction()) {
      return false;
    }
    return opt === true || opt.includes(this._table.tableName);
  }

  // ── Auto-increment helpers ────────────────────────────────────────────────

  /** Returns the counters collection used for atomic auto-increment. */
  protected get _countersCollection(): Collection<{ _id: string; seq: number }> {
    return this.db.collection("__atscript_counters");
  }

  /** Returns physical field names of increment fields that are undefined in the data. */
  private _fieldsNeedingIncrement(data: Record<string, unknown>): string[] {
    const result: string[] = [];
    for (const physical of this._incrementFields.keys()) {
      if (data[physical] === undefined || data[physical] === null) {
        result.push(physical);
      }
    }
    return result;
  }

  /**
   * Atomically allocates `count` sequential values for each increment field
   * using a counter collection. Returns a map of field → first allocated value.
   */
  private async _allocateIncrementValues(
    physicalFields: string[],
    count: number,
  ): Promise<Map<string, number>> {
    const counters = this._countersCollection;
    const collectionName = this._table.tableName;
    const result = new Map<string, number>();

    for (const field of physicalFields) {
      const counterId = `${collectionName}.${field}`;
      const startValue = this._incrementFields.get(field);
      // The counter is advanced OUTSIDE any transaction (like a SQL
      // sequence): in the session, every concurrent transaction inserting
      // into the table would write-conflict on the counter document. A
      // rollback leaves a gap. Only the max read below joins the session, so
      // a fresh counter sees the transaction's own rows.
      const doc = await counters.findOneAndUpdate(
        { _id: counterId },
        { $inc: { seq: count } },
        { upsert: true, returnDocument: "after" },
      );
      const seq = doc?.seq ?? count;
      // If this was a fresh counter (upserted), check if collection already has data
      // with higher values and re-seed if needed, or apply the start value
      if (seq === count) {
        const currentMax = await this._getCurrentFieldMax(field);
        // Determine the minimum starting point: use start value or existing max + 1
        const minStart = typeof startValue === "number" ? startValue : 1;
        const effectiveBase = Math.max(minStart, currentMax + 1);
        if (effectiveBase > seq) {
          const adjusted = effectiveBase + count - 1;
          await counters.updateOne({ _id: counterId }, { $max: { seq: adjusted } });
          result.set(field, effectiveBase);
          continue;
        }
      }
      result.set(field, seq - count + 1);
    }

    return result;
  }

  /** Reads current max value for a single field via $group aggregation. */
  private async _getCurrentFieldMax(field: string): Promise<number> {
    const alias = `max__${field.replace(/\./g, "__")}`;
    const agg = await this.collection
      .aggregate(
        [{ $group: { _id: null, [alias]: { $max: `$${field}` } } }],
        this._getSessionOpts(),
      )
      .toArray();
    if (agg.length > 0) {
      const val = agg[0][alias];
      if (typeof val === "number") {
        return val;
      }
    }
    return 0;
  }

  /** Allocates increment values for a batch of items, assigning in order. */
  private async _assignBatchIncrements(
    data: Array<Record<string, unknown>>,
    allFields: Set<string>,
  ): Promise<void> {
    // Count how many items need auto-increment per field
    const fieldCounts = new Map<string, number>();
    for (const physical of allFields) {
      let count = 0;
      for (const item of data) {
        if (item[physical] === undefined || item[physical] === null) {
          count++;
        }
      }
      if (count > 0) {
        fieldCounts.set(physical, count);
      }
    }

    // Atomically allocate ranges for each field
    const fieldCounters = new Map<string, number>();
    for (const [physical, count] of fieldCounts) {
      const allocated = await this._allocateIncrementValues([physical], count);
      fieldCounters.set(physical, allocated.get(physical) ?? 1);
    }

    // Walk items in order: no value → next from allocated range; explicit → keep
    for (const item of data) {
      for (const physical of allFields) {
        if (item[physical] === undefined || item[physical] === null) {
          const next = fieldCounters.get(physical) ?? 1;
          item[physical] = next;
          fieldCounters.set(physical, next + 1);
        }
      }
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * The pruned read of this adapter's managed view for `query` followed by
   * `stages` (`mongoViewRead`, since 0.1.153): the view pipeline without the
   * joins the read does not need, on the entry collection — or `undefined`
   * to read the stored view: pruning off, not a view, nothing droppable, an
   * operation-wide collation (it would govern the view's join keys too), or
   * stages that may read a dropped column ({@link stagesReadAny}).
   */
  private _viewRead(
    query: DbQuery,
    kind: TReadColumnsKind,
    stages: Document[] | (() => Document[]),
  ): { collection: Collection<any>; pipeline: Document[] } | undefined {
    if (!this.viewJoinPruning || !this._table?.isView) return undefined;
    if (!containsRelationFilter(query.filter) && this._getCollationOpts(query)) return undefined;
    const read = mongoViewRead(this._table as unknown as AtscriptDbView, query, kind);
    if (!read) return undefined;
    const own = typeof stages === "function" ? stages() : stages;
    if (stagesReadAny(own, read.dropped)) return undefined;
    return { collection: this.db.collection(read.entry), pipeline: [...read.prefix, ...own] };
  }

  /**
   * Runs a read pipeline — through the pruned view read `pruned` when there
   * is one, on the bound collection otherwise. A view's own default
   * collation is the simple one, so the pruned read pins it: the entry
   * collection's default must not apply.
   */
  // oxlint-disable-next-line max-params
  private _readPipeline(
    query: DbQuery,
    stages: Document[],
    label: string,
    pruned: ReturnType<MongoAdapter["_viewRead"]>,
    options?: AggregateOptions,
  ): Promise<Document[]> {
    if (pruned) {
      this._log(`${label} (pruned view)`, pruned.pipeline);
      return wrapInvalidQuery(() =>
        pruned.collection
          .aggregate(pruned.pipeline, {
            ...options,
            collation: { locale: "simple" },
            ...this._getSessionOpts(),
          })
          .toArray(),
      );
    }
    this._log(label, stages);
    return wrapInvalidQuery(() =>
      this.collection.aggregate(stages, { ...options, ...this._readOpts(query) }).toArray(),
    );
  }

  /** A find over the pruned view read, or `undefined` when the stored view is read. */
  private _prunedFind(
    query: DbQuery,
    label: string,
    limit?: number,
  ): Promise<Array<Record<string, unknown>>> | undefined {
    const pruned = this._viewRead(query, "rows", () => [
      ...mongoFilterStages(query.filter, this._predicateFilterOpts),
      ...pageStages(limit ? { ...query.controls, $limit: limit } : query.controls),
    ]);
    return (
      pruned &&
      this._readPipeline(
        query,
        pruned.pipeline,
        `aggregate (${label})`,
        pruned,
        hasNullsPlacement(query.controls) ? { allowDiskUse: true } : undefined,
      )
    );
  }

  /**
   * A find as an aggregation pipeline: its filter holds relational
   * predicates, or its `$sort` places NULL (`$nulls` — `find().sort()` cannot
   * express it; the placed sort is a blocking sort, so it may spill to disk).
   */
  private async _aggregateFind(
    query: DbQuery,
    label: string,
    limit?: number,
  ): Promise<Array<Record<string, unknown>>> {
    const pipeline = [
      ...mongoFilterStages(query.filter, this._predicateFilterOpts),
      ...pageStages(limit ? { ...query.controls, $limit: limit } : query.controls),
    ];
    this._log(`aggregate (${label})`, pipeline);
    const opts = hasNullsPlacement(query.controls)
      ? { allowDiskUse: true, ...this._readOpts(query) }
      : this._readOpts(query);
    return wrapInvalidQuery(() => this.collection.aggregate(pipeline, opts).toArray());
  }

  private _buildFindOptions(controls?: DbQuery["controls"]) {
    const opts: Record<string, any> = {};
    if (!controls) {
      return opts;
    }
    if (controls.$sort) {
      opts.sort = controls.$sort;
    }
    if (controls.$limit) {
      opts.limit = controls.$limit;
    }
    if (controls.$skip) {
      opts.skip = controls.$skip;
    }
    if (controls.$select) {
      const projection = controls.$select.asProjection;
      if (projection) opts.projection = dedupeProjection(projection);
    }
    return opts;
  }

  /**
   * Returns MongoDB collation options if any filter field has a non-binary collation.
   * Uses pre-computed insights when available, falls back to computing them on demand.
   * Maps: nocase → strength 2 (case-insensitive), unicode → strength 1 (case+accent-insensitive).
   * Predicate-free filters only — a filter with relational predicates never gets an
   * operation-wide collation ({@link _readOpts}), so insights are never computed over
   * resolved predicate operands.
   */
  private _getCollationOpts(query: DbQuery): { collation: CollationOptions } | undefined {
    if (!this._collateFields) {
      return undefined;
    }
    const insights = query.insights ?? computeInsights(query.filter);
    const collate = this._collateFields;
    const collation = mongoCollationOf([...insights.keys()].map((field) => collate.get(field)));
    return collation ? { collation } : undefined;
  }

  protected _addMongoIndexField(
    type: TPlainIndex["type"],
    name: string,
    field: string,
    weight?: number,
  ) {
    const key = mongoIndexKey(type, name);
    let index = this._mongoIndexes.get(key) as TPlainIndex | undefined;
    const value = type === "text" ? "text" : 1;
    if (index) {
      index.fields[field] = value;
    } else {
      index = { key, name, type, fields: { [field]: value }, weights: {} };
      this._mongoIndexes.set(key, index);
    }
    if (weight) {
      index.weights[field] = weight;
    }
  }

  protected _setSearchIndex(
    type: TSearchIndex["type"],
    name: string | undefined,
    definition: TMongoSearchIndexDefinition,
    meta?: {
      fuzzy?: { maxEdits: number };
      strategy?: TSearchIndex["strategy"];
      paths?: string[];
    },
  ): TSearchIndex {
    const key = mongoIndexKey(type, name || DEFAULT_INDEX_NAME);
    const index: TSearchIndex = {
      key,
      name: name || DEFAULT_INDEX_NAME,
      type,
      definition,
      fuzzy: meta?.fuzzy,
      strategy: meta?.strategy,
      paths: meta?.paths ?? (type === "search_text" ? [] : undefined),
    };
    this._mongoIndexes.set(key, index);
    return index;
  }

  /**
   * Adds (and merges, by mapping `type`) one or more Atlas field-type mappings to
   * a `search_text` index. Multiple annotations on the same field — e.g.
   * `@db.mongo.search.text` (string) plus `@db.mongo.search.autocomplete`
   * (autocomplete + string) — accumulate into a single multi-type mapping
   * instead of overwriting one another.
   */
  protected _addFieldToSearchIndex(
    type: TSearchIndex["type"],
    _name: string | undefined,
    fieldName: string,
    mappings: TSearchFieldMapping[],
  ) {
    const name = _name || DEFAULT_INDEX_NAME;
    let index = this._mongoIndexes.get(mongoIndexKey(type, name)) as TSearchIndex | undefined;
    if (!index && type === "search_text") {
      index = this._setSearchIndex(type, name, { mappings: { fields: {} } });
    }
    if (!index) {
      return;
    }
    if (index.paths && !index.paths.includes(fieldName)) index.paths.push(fieldName);
    const rootFields = index.definition.mappings!.fields!;
    // MongoDB's DocumentFieldMapper renames ONLY the top-level document key
    // (`@db.column`); nested object keys are stored as-is. Mirror that so the
    // Atlas mapping/query key matches the stored field — resolve the first
    // segment via columnMap, keep deeper segments (and the leaf) logical.
    const segments = fieldName.split(".");
    const topKey = this._table.columnMap.get(segments[0]) ?? segments[0];
    // Top-level field — plain key.
    if (segments.length === 1) {
      rootFields[topKey] = mergeFieldMappings(rootFields[topKey], mappings);
      return;
    }
    // Nested field — Atlas rejects a dotted mapping key, so build a container
    // node per parent segment: an array-of-objects parent → `embeddedDocuments`,
    // a single-object parent → `document`. The leaf carries the actual mappings.
    let cursor = rootFields;
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      // The logical path drives array detection (flatMap is keyed logically);
      // only the first segment's mapping KEY is physically renamed.
      prefix = joinPath(prefix, segment);
      const nodeType = isArrayPath(this._table.flatMap, prefix) ? "embeddedDocuments" : "document";
      cursor = this._descendSearchNode(cursor, i === 0 ? topKey : segment, nodeType, fieldName);
    }
    const leaf = segments[segments.length - 1];
    cursor[leaf] = mergeFieldMappings(cursor[leaf], mappings);
  }

  /**
   * Returns (creating if needed) the nested `fields` map of the container node
   * at `segment`, reusing a same-typed sibling node so multiple searchable
   * fields under one parent (e.g. `identity.name` + `identity.tagline`) merge
   * instead of clobbering.
   */
  private _descendSearchNode(
    fields: Record<string, TSearchFieldMapping | TSearchFieldMapping[]>,
    segment: string,
    nodeType: "document" | "embeddedDocuments",
    fullPath: string,
  ): Record<string, TSearchFieldMapping | TSearchFieldMapping[]> {
    const existing = fields[segment];
    if (
      existing &&
      !Array.isArray(existing) &&
      (existing.type === "document" || existing.type === "embeddedDocuments")
    ) {
      if (existing.type !== nodeType) {
        // A path cannot be both an array and a single object — would only happen
        // on an inconsistent schema. Keep the first shape and warn.
        this._log(
          `search index: conflicting container type for "${fullPath}" ` +
            `(${existing.type} vs ${nodeType}); keeping ${existing.type}`,
        );
      }
      existing.fields ??= {};
      return existing.fields;
    }
    if (existing) {
      // A leaf mapping already sits where a container is needed — pathological
      // (same path annotated as both a value and a parent). Warn and override.
      this._log(`search index: field "${segment}" used as both value and parent in "${fullPath}"`);
    }
    const node: TSearchFieldMapping = { type: nodeType, fields: {} };
    fields[segment] = node;
    return node.fields!;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * `$sort` → `$skip` → `$limit` → `$project` stages of a read's controls (a
 * `$nulls` placement adds its flags before the `$sort` and drops them after
 * `$limit` — see {@link sortStages}).
 */
function pageStages(controls: DbQuery["controls"]): Document[] {
  if (!controls) {
    return [];
  }
  const { stages, cleanup } = sortStages(controls);
  if (controls.$skip) {
    stages.push({ $skip: controls.$skip });
  }
  if (controls.$limit) {
    stages.push({ $limit: controls.$limit });
  }
  if (cleanup) stages.push(cleanup);
  if (controls.$select) {
    const projection = controls.$select.asProjection;
    if (projection) stages.push({ $project: dedupeProjection(projection) });
  }
  return stages;
}

/**
 * Normalizes a declared `fuzzy` arg (`0-2`) into the query-time metadata Atlas
 * accepts. Atlas only honors an edit distance of `1` or `2`; `0`/undefined means
 * "no fuzzy", returned as `undefined` so no `fuzzy` clause is ever emitted.
 */
function normalizeSearchFuzzy(fuzzy?: number): { maxEdits: number } | undefined {
  return fuzzy === 1 || fuzzy === 2 ? { maxEdits: fuzzy } : undefined;
}

/** Narrows the declared `strategy` arg to a known value (undefined → query layer defaults to "compound"). */
function normalizeSearchStrategy(strategy?: string): TSearchIndex["strategy"] | undefined {
  return strategy === "compound" || strategy === "autocomplete" || strategy === "text"
    ? strategy
    : undefined;
}

/**
 * Merges incoming Atlas field-type mappings into a field's existing mapping,
 * keyed by `type` (a later mapping of the same type replaces the earlier one).
 * Collapses to a single object when one type remains, else an array (Atlas's
 * multi-type field form).
 */
function mergeFieldMappings(
  existing: TSearchFieldMapping | TSearchFieldMapping[] | undefined,
  incoming: TSearchFieldMapping[],
): TSearchFieldMapping | TSearchFieldMapping[] {
  const byType = new Map<string, TSearchFieldMapping>();
  const order: string[] = [];
  const add = (m: TSearchFieldMapping) => {
    if (!byType.has(m.type)) order.push(m.type);
    byType.set(m.type, m);
  };
  if (Array.isArray(existing)) existing.forEach(add);
  else if (existing) add(existing);
  incoming.forEach(add);
  const merged = order.map((t) => byType.get(t)!);
  return merged.length === 1 ? merged[0] : merged;
}

/**
 * Builds a MongoDB update document from a data object that may contain
 * field ops (`{ $inc: N }`, `{ $dec: N }`, `{ $mul: N }`).
 * Regular fields go into `$set`, ops go into `$inc` / `$mul`. When
 * `versionColumn` is supplied, an auto-bump (`$inc: { <col>: 1 }`) is merged
 * in so versioned tables increment monotonically on every successful update.
 */
function buildMongoUpdateDoc(
  data: Record<string, unknown>,
  ops?: TFieldOps,
  versionColumn?: string,
): Record<string, unknown> {
  const updateDoc: Record<string, unknown> = {};
  let hasData = false;
  for (const _ in data) {
    hasData = true;
    break;
  }
  if (hasData) updateDoc.$set = data;
  // Clone ops.inc so we can safely merge the auto-bump without mutating the caller's object.
  if (ops?.inc || versionColumn !== undefined) {
    const inc: Record<string, number> = { ...ops?.inc };
    if (versionColumn !== undefined) {
      // Step 2's patch decomposer already rejects $inc on the version column;
      // overwrite defensively so any future leak still produces +1 (never +N).
      inc[versionColumn] = 1;
    }
    updateDoc.$inc = inc;
  }
  if (ops?.mul) updateDoc.$mul = ops.mul;
  return updateDoc;
}
