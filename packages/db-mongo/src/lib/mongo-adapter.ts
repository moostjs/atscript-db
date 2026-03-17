import type {
  TAtscriptAnnotatedType,
  TMetadataMap,
  TValidatorOptions,
  Validator,
} from "@atscript/typescript/utils";
import {
  BaseDbAdapter,
  DbError,
  type DbQuery,
  type FilterExpr,
  type TDbInsertResult,
  type TDbInsertManyResult,
  type TDbUpdateResult,
  type TDbDeleteResult,
  type TSearchIndexInfo,
  type TDbRelation,
  type TDbForeignKey,
  type TTableResolver,
  type WithRelation,
  type TColumnDiff,
  type TSyncColumnResult,
  type TDbCollation,
  type TExistingTableOption,
  type TMetadataOverrides,
  type TableMetadata,
  type TFieldOps,
  computeInsights,
} from "@atscript/db";
import type {
  AggregationCursor,
  ClientSession,
  CollationOptions,
  Collection,
  Db,
  Document,
  MongoClient,
} from "mongodb";
import { MongoServerError, ObjectId } from "mongodb";
import { CollectionPatcher, type TCollectionPatcherContext } from "./collection-patcher";
import { buildMongoFilter } from "./mongo-filter";
import {
  DEFAULT_INDEX_NAME,
  mongoIndexKey,
  type TPlainIndex,
  type TSearchIndex,
  type TMongoIndex,
  type TMongoSearchIndexDefinition,
} from "./mongo-types";
import type { TMongoRelationHost } from "./mongo-relations";
import { loadRelationsImpl } from "./mongo-relations";
import type { TMongoSearchHost } from "./mongo-search";
import {
  searchImpl,
  searchWithCountImpl,
  vectorSearchImpl,
  vectorSearchWithCountImpl,
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
  DESTRUCTIVE_OPTION_KEYS,
} from "./mongo-schema-sync";
import { validateMongoIdPlugin } from "./validate-plugins";

export type {
  TPlainIndex,
  TSearchIndex,
  TMongoIndex,
  TMongoSearchIndexDefinition,
} from "./mongo-types";

// ── Adapter ──────────────────────────────────────────────────────────────────

export class MongoAdapter extends BaseDbAdapter {
  private _collection?: Collection<any>;

  /** MongoDB-specific indexes (search, vector) — separate from table.indexes. */
  protected _mongoIndexes = new Map<string, TMongoIndex>();

  /** Vector search filter associations built during flattening. */
  protected _vectorFilters = new Map<string, string>();

  /** Default similarity thresholds per vector index (from @db.search.vector.threshold). */
  protected _vectorThresholds = new Map<string, number>();

  /** Cached search index lookup. */
  protected _searchIndexesMap?: Map<string, TMongoIndex>;

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
  ) {
    super();
  }

  // ── Transaction support ──────────────────────────────────────────────────

  private get _client() {
    return this.client;
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

  aggregatePipeline(pipeline: Document[]): AggregationCursor {
    return this.collection.aggregate(pipeline, this._getSessionOpts());
  }

  override async aggregate(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    const { buildAggregatePipeline, buildCountPipeline } = await import("../agg");

    if (query.controls?.$count) {
      const pipeline = buildCountPipeline(query);
      this._log("aggregate (count)", pipeline);
      const result = await this.aggregatePipeline(pipeline).toArray();
      return result.length > 0 ? result : [{ count: 0 }];
    }

    const pipeline = buildAggregatePipeline(query);
    this._log("aggregate", pipeline);
    return this.aggregatePipeline(pipeline).toArray();
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

  override getValidatorPlugins(): ReturnType<BaseDbAdapter["getValidatorPlugins"]> {
    return [validateMongoIdPlugin];
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

  override async nativePatch(
    filter: FilterExpr,
    patch: unknown,
    ops?: TFieldOps,
  ): Promise<TDbUpdateResult> {
    const mongoFilter = buildMongoFilter(filter);
    const patcher = new CollectionPatcher(this.getPatcherContext(), patch, ops);
    const { updateFilter, updateOptions } = patcher.preparePatch();
    this._log("updateOne (patch)", mongoFilter, updateFilter);
    const result = await this.collection.updateOne(mongoFilter, updateFilter, {
      ...updateOptions,
      ...this._getSessionOpts(),
    });
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  // ── Annotation scanning hooks ────────────────────────────────────────────

  override onBeforeFlatten(_type: unknown): void {
    const type = _type as TAtscriptAnnotatedType;
    const typeMeta = type.metadata;

    // @db.mongo.capped → store for ensureCollectionExists
    const capped = typeMeta.get("db.mongo.capped") as { size: number; max?: number } | undefined;
    if (capped) {
      this._cappedOptions = { size: capped.size, max: capped.max };
    }

    const dynamicText = typeMeta.get("db.mongo.search.dynamic");
    if (dynamicText) {
      this._setSearchIndex("dynamic_text", "_", {
        mappings: { dynamic: true },
        analyzer: dynamicText.analyzer,
        text: { fuzzy: { maxEdits: dynamicText.fuzzy || 0 } },
      });
    }
    for (const textSearch of typeMeta.get("db.mongo.search.static") || []) {
      this._setSearchIndex("search_text", textSearch.indexName, {
        mappings: { fields: {} },
        analyzer: textSearch.analyzer,
        text: { fuzzy: { maxEdits: textSearch.fuzzy || 0 } },
      });
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
    // - Only remove from primaryKeys if the schema explicitly defines _id
    //   (via @db.mongo.collection). Otherwise keep it as PK for replace/update.
    if (field !== "_id" && metadata.has("meta.id")) {
      this._addMongoIndexField("unique", "__pk", field);
      this._pendingUniqueFields.push(field);
    }
    // @db.default.increment → track for auto-increment on insert (with optional start value)
    if (metadata.has("db.default.increment")) {
      const physicalName = metadata.get("db.column") ?? field;
      const startValue = metadata.get("db.default.increment");
      this._incrementFields.set(
        physicalName,
        typeof startValue === "number" ? startValue : undefined,
      );
    }
    // @db.index.fulltext → MongoDB text index (adapter-level, with weight)
    for (const index of metadata.get("db.index.fulltext") || []) {
      const name = typeof index === "object" ? index.name || "" : "";
      const weight = typeof index === "object" ? index.weight || 1 : 1;
      this._addMongoIndexField("text", name, field, weight);
    }
    // @db.mongo.search.text
    for (const index of metadata.get("db.mongo.search.text") || []) {
      this._addFieldToSearchIndex("search_text", index.indexName, field, index.analyzer);
    }
    // @db.search.vector (generic)
    const vectorIndex = metadata.get("db.search.vector");
    if (vectorIndex) {
      const indexName = vectorIndex.indexName || field;
      this._setSearchIndex("vector", indexName, {
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
      });
      // @db.search.vector.threshold
      const threshold = metadata.get("db.search.vector.threshold");
      if (threshold !== undefined) {
        this._vectorThresholds.set(mongoIndexKey("vector", indexName), threshold);
      }
    }
    // @db.search.filter (generic) — each entry is a plain string (the index name)
    for (const indexName of metadata.get("db.search.filter") || []) {
      this._vectorFilters.set(mongoIndexKey("vector", indexName), field);
    }
  }

  override getMetadataOverrides(meta: TableMetadata): TMetadataOverrides {
    const uniqueFields = this._pendingUniqueFields;

    if (this._hasExplicitId) {
      // Schema defines _id explicitly (via @db.mongo.collection or manual field).
      // _id is the primary key; remove non-_id @meta.id fields from PKs (they become unique indexes).
      return {
        addPrimaryKeys: ["_id"],
        removePrimaryKeys: meta.originalMetaIdFields.filter((f) => f !== "_id"),
        addUniqueFields: uniqueFields.length > 0 ? uniqueFields : undefined,
      };
    }

    // Schema does NOT define _id. The user's @meta.id field is the primary key
    // for replace/update operations. Inject a synthetic _id as unique field so
    // that findById can resolve ObjectId strings via _resolveIdFilter.
    uniqueFields.push("_id");
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
      addUniqueFields: uniqueFields,
    };
  }

  override onAfterFlatten(): void {
    // Associate vector filter fields with their vector indexes
    for (const [key, value] of this._vectorFilters.entries()) {
      const index = this._mongoIndexes.get(key);
      if (index && index.type === "vector") {
        index.definition.fields?.push({
          type: "filter",
          path: value,
        });
      }
    }

    // Build map of fields with non-binary collation for query-time collation injection
    for (const fd of this._table.fieldDescriptors) {
      if (fd.collate && fd.collate !== "binary") {
        if (!this._collateFields) {
          this._collateFields = new Map();
        }
        this._collateFields.set(fd.physicalName, fd.collate);
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

      // Check generic text indexes from table.indexes
      for (const index of this._table.indexes.values()) {
        if (index.type === "fulltext" && !defaultIndex) {
          // Convert generic fulltext to our TMongoIndex for search dispatch
          defaultIndex = {
            key: index.key,
            name: index.name,
            type: "text",
            fields: Object.fromEntries(index.fields.map((f) => [f.name, "text" as const])),
            weights: Object.fromEntries(
              index.fields.filter((f) => f.weight).map((f) => [f.name, f.weight!]),
            ),
          };
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

  override async findManyWithCount(
    query: DbQuery,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    const filter = buildMongoFilter(query.filter);
    const controls = query.controls || {};

    const dataStages: Document[] = [];
    if (controls.$sort) {
      dataStages.push({ $sort: controls.$sort });
    }
    if (controls.$skip) {
      dataStages.push({ $skip: controls.$skip });
    }
    if (controls.$limit) {
      dataStages.push({ $limit: controls.$limit });
    }
    if (controls.$select) {
      dataStages.push({ $project: controls.$select.asProjection });
    }

    const pipeline: Document[] = [
      { $match: filter },
      { $facet: { data: dataStages, meta: [{ $count: "count" }] } },
    ];

    this._log("aggregate (findManyWithCount)", pipeline);
    const result = await this.collection
      .aggregate(pipeline, { ...this._getCollationOpts(query), ...this._getSessionOpts() })
      .toArray();
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
      await this.db.createCollection(this._table.tableName, opts);
    }
  }

  /**
   * Wraps an async operation to catch MongoDB duplicate key errors
   * (code 11000) and rethrow as structured `DbError`.
   */
  private async _wrapDuplicateKeyError<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const field = error.keyPattern ? (Object.keys(error.keyPattern)[0] ?? "") : "";
        throw new DbError("CONFLICT", [{ path: field, message: error.message }]);
      }
      throw error;
    }
  }

  // ── CRUD implementation ──────────────────────────────────────────────────

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
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
    return { insertedId: this._resolveInsertedId(data, result.insertedId) };
  }

  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
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

    this._log("insertMany", `${data.length} docs`);
    const result = await this._wrapDuplicateKeyError(() =>
      this.collection.insertMany(data, this._getSessionOpts()),
    );
    return {
      insertedCount: result.insertedCount,
      insertedIds: data.map((item, i) => this._resolveInsertedId(item, result.insertedIds[i])),
    };
  }

  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    const filter = buildMongoFilter(query.filter);
    const opts = this._buildFindOptions(query.controls);
    this._log("findOne", filter, opts);
    return this.collection.findOne(filter, {
      ...opts,
      ...this._getCollationOpts(query),
      ...this._getSessionOpts(),
    });
  }

  async findMany(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    const filter = buildMongoFilter(query.filter);
    const opts = this._buildFindOptions(query.controls);
    this._log("findMany", filter, opts);
    // eslint-disable-next-line unicorn/no-array-method-this-argument -- MongoDB Collection.find, not Array.find
    return this.collection
      .find(filter, { ...opts, ...this._getCollationOpts(query), ...this._getSessionOpts() })
      .toArray();
  }

  async count(query: DbQuery): Promise<number> {
    const filter = buildMongoFilter(query.filter);
    this._log("countDocuments", filter);
    return this.collection.countDocuments(filter, {
      ...this._getCollationOpts(query),
      ...this._getSessionOpts(),
    });
  }

  async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
  ): Promise<TDbUpdateResult> {
    const mongoFilter = buildMongoFilter(filter);
    const updateDoc = buildMongoUpdateDoc(data, ops);
    this._log("updateOne", mongoFilter, updateDoc);
    const result = await this.collection.updateOne(mongoFilter, updateDoc, this._getSessionOpts());
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async replaceOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    const mongoFilter = buildMongoFilter(filter);
    this._log("replaceOne", mongoFilter, data);
    const result = await this._wrapDuplicateKeyError(() =>
      this.collection.replaceOne(mongoFilter, data, this._getSessionOpts()),
    );
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    const mongoFilter = buildMongoFilter(filter);
    this._log("deleteOne", mongoFilter);
    const result = await this.collection.deleteOne(mongoFilter, this._getSessionOpts());
    return { deletedCount: result.deletedCount };
  }

  async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
  ): Promise<TDbUpdateResult> {
    const mongoFilter = buildMongoFilter(filter);
    const updateDoc = buildMongoUpdateDoc(data, ops);
    this._log("updateMany", mongoFilter, updateDoc);
    const result = await this.collection.updateMany(mongoFilter, updateDoc, this._getSessionOpts());
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    // MongoDB has no native replaceMany; use updateMany with $set
    const mongoFilter = buildMongoFilter(filter);
    this._log("replaceMany", mongoFilter, { $set: data });
    const result = await this.collection.updateMany(
      mongoFilter,
      { $set: data },
      this._getSessionOpts(),
    );
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    const mongoFilter = buildMongoFilter(filter);
    this._log("deleteMany", mongoFilter);
    const result = await this.collection.deleteMany(mongoFilter, this._getSessionOpts());
    return { deletedCount: result.deletedCount };
  }

  // ── Schema / Index sync ──────────────────────────────────────────────────

  clearCollectionCache(): void {
    this._collection = undefined;
  }

  async tableExists(): Promise<boolean> {
    return tableExistsImpl(this as any as TMongoSchemaSyncHost);
  }
  async ensureTable(): Promise<void> {
    return ensureTableImpl(this as any as TMongoSchemaSyncHost, this._table);
  }
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
  async dropViewByName(viewName: string): Promise<void> {
    return dropViewByNameImpl(this as any as TMongoSchemaSyncHost, viewName);
  }
  async dropTableByName(tableName: string): Promise<void> {
    return dropTableByNameImpl(this as any as TMongoSchemaSyncHost, tableName);
  }
  override getDesiredTableOptions(): TExistingTableOption[] {
    return getDesiredTableOptionsImpl(this._cappedOptions);
  }
  override async getExistingTableOptions(): Promise<TExistingTableOption[]> {
    return getExistingTableOptionsImpl(this as any as TMongoSchemaSyncHost);
  }
  override destructiveOptionKeys(): ReadonlySet<string> {
    return DESTRUCTIVE_OPTION_KEYS;
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
      .aggregate([{ $group: { _id: null, [alias]: { $max: `$${field}` } } }])
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
      opts.projection = controls.$select.asProjection;
    }
    return opts;
  }

  /**
   * Returns MongoDB collation options if any filter field has a non-binary collation.
   * Uses pre-computed insights when available, falls back to computing them on demand.
   * Maps: nocase → strength 2 (case-insensitive), unicode → strength 1 (case+accent-insensitive).
   */
  private _getCollationOpts(query: DbQuery): { collation: CollationOptions } | undefined {
    if (!this._collateFields) {
      return undefined;
    }
    const insights = query.insights ?? computeInsights(query.filter);
    let strength: 1 | 2 | undefined;
    for (const field of insights.keys()) {
      const collation = this._collateFields.get(field);
      if (collation === "unicode") {
        return { collation: { locale: "en", strength: 1 } };
      }
      if (collation === "nocase") {
        strength = 2;
      }
    }
    return strength ? { collation: { locale: "en", strength } } : undefined;
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
  ) {
    const key = mongoIndexKey(type, name || DEFAULT_INDEX_NAME);
    this._mongoIndexes.set(key, {
      key,
      name: name || DEFAULT_INDEX_NAME,
      type,
      definition,
    });
  }

  protected _addFieldToSearchIndex(
    type: TSearchIndex["type"],
    _name: string | undefined,
    fieldName: string,
    analyzer?: string,
  ) {
    const name = _name || DEFAULT_INDEX_NAME;
    let index = this._mongoIndexes.get(mongoIndexKey(type, name)) as TSearchIndex | undefined;
    if (!index && type === "search_text") {
      this._setSearchIndex(type, name, {
        mappings: { fields: {} },
        text: { fuzzy: { maxEdits: 0 } },
      });
      index = this._mongoIndexes.get(mongoIndexKey(type, name)) as TSearchIndex | undefined;
    }
    if (index) {
      index.definition.mappings!.fields![fieldName] = { type: "string" };
      if (analyzer) {
        index.definition.mappings!.fields![fieldName].analyzer = analyzer;
      }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a MongoDB update document from a data object that may contain
 * field ops (`{ $inc: N }`, `{ $dec: N }`, `{ $mul: N }`).
 * Regular fields go into `$set`, ops go into `$inc` / `$mul`.
 */
function buildMongoUpdateDoc(
  data: Record<string, unknown>,
  ops?: TFieldOps,
): Record<string, unknown> {
  const updateDoc: Record<string, unknown> = {};
  let hasData = false;
  for (const _ in data) {
    hasData = true;
    break;
  }
  if (hasData) updateDoc.$set = data;
  if (ops?.inc) updateDoc.$inc = ops.inc;
  if (ops?.mul) updateDoc.$mul = ops.mul;
  return updateDoc;
}
