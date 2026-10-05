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
  AggregateFn,
  AggregateQuery,
  BucketUnit,
  FilterExpr,
  UniqueryControls,
  Uniquery,
  WithRelation,
} from "@uniqu/core";
import { isAggregateExpr } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import { DbError, spaceClosedError } from "../db-error";
import type { TGenericLogger } from "../logger";
import { NoopLogger } from "../logger";
import type {
  NullableOptional,
  TDbDefaultValue,
  TDbFieldMeta,
  TDbForeignKey,
  TDbIndex,
  TDbRelation,
  TDerivedColumn,
  TIdDescriptor,
  TIdentification,
  TIdResolveOptions,
  TRowResolveOptions,
  TSearchIndexInfo,
  TTableResolver,
  TWriteTableResolver,
} from "../types";
import { TableMetadata } from "./table-metadata";
import {
  type FieldMappingStrategy,
  type TReadControls,
  DocumentFieldMapper,
  isExclusionProjection,
} from "../strategies/field-mapping";
import { RelationalFieldMapper } from "../strategies/relational-field-mapper";
import type { TRelationLoaderHost } from "../rel/relation-loader";
import {
  findFKEntryForRelation,
  findFKForRelation,
  findRemoteFK,
  tableNameOf,
} from "../rel/relation-helpers";
import type { DbEncryption } from "../encryption";
import {
  assertGeoPoint,
  guardAggregate,
  guardFilter,
  guardPaths,
  guardQuery,
  isStrictTable,
} from "../query/query-guards";
import {
  createRelationFilterHost,
  type TRelationFilterOwner,
  type TRelGuardState,
} from "../query/relation-filter";
import { normalizeComputedSelect } from "../query/buckets";
import { geoIndexNotFoundMessage } from "../shared/index-messages";
import { deletePath, isEmptyObject, selfOrAncestor } from "../shared/object";
import { rowMatchesKey } from "../shared/keys";

/** A read translated for the adapter, with what finishing its rows needs — see `_translateRead`. */
interface TReadPlan {
  translated: ReturnType<FieldMappingStrategy["translateQuery"]>;
  /** The controls the rows were read with (`$select` widened by join keys). */
  controls: TReadControls | undefined;
  withRelations?: WithRelation[];
  /** Join keys added to `$select` for `$with` — stripped after loading. */
  widened: string[];
}

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
  : // `NavPropsOf<T>` falls back to `Record<string, never>` for tables without
    // any declared nav props. Its `keyof` is `string`, which would cause
    // `Omit<Data, string>` to strip every field. Detect that index-signature-only
    // shape and treat it as "no nav props".
    string extends keyof Nav
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
  // Optional columns read back / filter as `null` too (since 0.1.128).
  _FlatType = NullableOptional<FlatOf<T>>,
  A extends BaseDbAdapter = BaseDbAdapter,
  IdType = PrimaryKeyOf<T>,
  OwnProps = NullableOptional<OwnPropsOf<T>>,
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

  /** Encryption service for `@db.encrypted` fields — set by `DbSpace` from its options. */
  protected _encryption?: DbEncryption;

  private _metaIdPhysical: string | null | undefined;

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

    this.tableName = adapter.getAdapterTableName?.(_type) || tableNameOf(_type);
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

  /**
   * Sets the encryption service used for `@db.encrypted` fields.
   * Called by `DbSpace` after table/view creation when the space was
   * configured with an `encryption` options block.
   */
  public setEncryption(encryption: DbEncryption | undefined): void {
    this._encryption = encryption;
  }

  /** @internal Set by the owning `DbSpace` when it closes. */
  _spaceClosed = false;

  /** Ensures metadata is built. Called before any metadata access. */
  protected _ensureBuilt(): void {
    if (this._spaceClosed) throw spaceClosedError();
    if (!this._meta.isBuilt) {
      this._meta.build(this.type, this.adapter, this.logger);
      if (this._meta.navFields.size > 0 && this._tableResolver) {
        const resolver = this._tableResolver;
        this._meta.relationFilters = createRelationFilterHost(
          this,
          (type) => resolver(type) as unknown as TRelationFilterOwner | undefined,
        );
      }
    }
    if (this._meta.encryptedFields.size > 0 && !this._encryption) {
      // Never silently store/read plaintext on a model that declares
      // @db.encrypted — fail fast at the first table use / schema sync.
      throw new DbError("ENC_CONFIG_MISSING", [
        {
          path: "",
          message:
            `Table "${this.tableName}" declares @db.encrypted fields but the DbSpace ` +
            `has no encryption configuration — pass { encryption: { defaultKeyId, keys } } ` +
            `to the DbSpace options`,
        },
      ]);
    }
  }

  /**
   * Built table metadata. Triggers a lazy build on first access — safe to call
   * from peer tables that need this one's relations / nav fields before any
   * operation has run against it directly.
   */
  public getMetadata(): TableMetadata {
    this._ensureBuilt();
    return this._meta;
  }

  protected _ensureSearchable(): void {
    if (this.adapter.isSearchable()) return;
    // Naming the vector index is the whole diagnostic when one exists — that is
    // the table whose author believes it is searchable. Which annotation grants
    // text search is adapter-specific (`@db.index.fulltext`, or Mongo's Atlas
    // `@db.mongo.search.*`), so the message does not guess at one.
    const hasVectorIndex = this.adapter.getSearchIndexes().some((i) => i.type === "vector");
    throw new DbError("INVALID_QUERY", [
      {
        path: "$search",
        message:
          `Table "${this.tableName}" has no text search index` +
          (hasVectorIndex ? " — a @db.search.vector index only answers vectorSearch()" : ""),
      },
    ]);
  }

  /** Engine-agnostic query-time guards (encrypted-field refs, $geoWithin shape). */
  protected _guardQuery(query: Uniquery | undefined): void {
    guardQuery(this._meta, this.adapter, query as Parameters<typeof guardQuery>[2]);
  }

  /**
   * Guards a relational predicate operand against THIS table — the filter
   * guard and the path guard with the predicate's shared `state` (depth,
   * count, read/write mode). Called by the source table's relation host.
   *
   * @internal Core wiring for relational predicates; not consumer API.
   */
  public _guardRelationOperand(filter: FilterExpr, state: TRelGuardState): void {
    this._ensureBuilt();
    guardFilter(this._meta, this.adapter, filter);
    guardPaths(this._meta, this.adapter, { filter }, false, state);
  }

  /**
   * Translates a relational predicate operand for THIS table's adapter (its
   * own field mapper; nested predicates resolved at `depth + 1`).
   *
   * @internal Core wiring for relational predicates; not consumer API.
   */
  public _resolveRelationOperand(filter: FilterExpr, depth: number): FilterExpr {
    this._ensureBuilt();
    return this._fieldMapper.translateFilter(filter, this._meta, depth);
  }

  /**
   * Translates a logical query (filter + controls) for THIS table's adapter
   * after the read guards — exactly what `findMany` hands the adapter.
   * For adapters that load `$with` relations natively and must address the
   * related table's physical names.
   *
   * @internal Adapter-facing surface; not part of the consumer API.
   * @since 0.1.147
   */
  public _translateForAdapter(query: Uniquery): ReturnType<FieldMappingStrategy["translateQuery"]> {
    this._ensureBuilt();
    this._guardQuery(query);
    return this._fieldMapper.translateQuery(query, this._meta);
  }

  /**
   * Physical rows of THIS table → logical rows (field mapping, value
   * formatters, decryption) — what every read does before `$with` loading.
   * `controls` are the logical read controls the rows were read with.
   *
   * @internal Adapter-facing surface; not part of the consumer API.
   * @since 0.1.147
   */
  public async _rowsFromAdapter(
    rows: Record<string, unknown>[],
    controls?: TReadControls,
  ): Promise<Record<string, unknown>[]> {
    this._ensureBuilt();
    const out = this._fromRead(rows, controls);
    await this._decryptRows(out);
    return out;
  }

  private _encryptedPathsCache?: Array<{ path: string; segments: string[]; leaf: string }>;

  /** Pre-split `encryptedFields` paths — computed once, reused on every read/write. */
  protected get _encryptedPaths(): Array<{ path: string; segments: string[]; leaf: string }> {
    return (this._encryptedPathsCache ??= [...this._meta.encryptedFields].map((path) => {
      const segments = path.split(".");
      return { path, segments, leaf: segments[segments.length - 1]! };
    }));
  }

  /**
   * Walks all but the last of `segments` down from `root`, returning the
   * object holding the leaf — or `undefined` when the path is unreachable
   * (a missing, non-object, or array step). With `cloneParents`, every
   * traversed object is shallow-cloned and re-linked so caller-shared
   * nested objects are never mutated.
   */
  protected _walkToLeafParent(
    root: Record<string, unknown>,
    segments: string[],
    cloneParents: boolean,
  ): Record<string, unknown> | undefined {
    let parent: Record<string, unknown> = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const next: unknown = parent[segments[i]!];
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        return undefined;
      }
      let child = next as Record<string, unknown>;
      if (cloneParents) {
        child = { ...child };
        parent[segments[i]!] = child;
      }
      parent = child;
    }
    return parent;
  }

  /**
   * Decrypts `@db.encrypted` fields on reconstructed rows (in place).
   * Non-envelope stored values follow the configured `onUnencrypted` policy.
   */
  protected async _decryptRows(rows: Array<Record<string, unknown>>): Promise<void> {
    const enc = this._encryption;
    if (this._meta.encryptedFields.size === 0 || rows.length === 0 || !enc) {
      return;
    }
    for (const row of rows) {
      for (const { path, segments, leaf } of this._encryptedPaths) {
        const parent = this._walkToLeafParent(row, segments, false);
        if (!parent) {
          continue;
        }
        const value = parent[leaf];
        if (value === undefined || value === null) {
          continue;
        }
        if (enc.isEnvelope(value)) {
          parent[leaf] = await enc.decrypt(value, { table: this.tableName, field: path });
        } else if (enc.onUnencrypted === "error") {
          throw new DbError("ENC_NOT_ENCRYPTED", [
            {
              path,
              message:
                `Field "${path}" on "${this.tableName}" holds a non-encrypted value while ` +
                `@db.encrypted is declared — set encryption.onUnencrypted: 'passthrough' ` +
                `to read legacy plaintext during a migration window`,
            },
          ]);
        }
        // 'passthrough' → return the raw value as-is; it re-encrypts on its next write.
      }
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

  /**
   * Physical column lists that must be unique: the primary key (when declared)
   * followed by every unique index. Used by conflict-ignoring inserts.
   * @since 0.1.148
   */
  public get uniqueKeySets(): string[][] {
    this._ensureBuilt();
    const sets: string[][] = [];
    if (this._meta.primaryKeys.length > 0) {
      sets.push(this._meta.primaryKeys.map((f) => this._meta.physicalPath(f)));
    }
    for (const index of this._meta.indexes.values()) {
      if (index.type === "unique") sets.push(index.fields.map((f) => f.name));
    }
    return sets;
  }

  /** Preferred row identifier field names. Defaults to primary keys. */
  public get preferredId(): readonly string[] {
    this._ensureBuilt();
    return this._meta.preferredId;
  }

  /** Legitimate row-identifier shapes (primary key + every unique index). */
  public get identifications(): readonly TIdentification[] {
    this._ensureBuilt();
    return this._meta.getIdentifications();
  }

  /**
   * The {@link identifications} an id may resolve through when fields are
   * hidden per request (since 0.1.134): a unique index with a field that
   * fails `isFieldVisible` is dropped, as if it did not exist. Primary-key,
   * `preferredId` and `@meta.id` fields always count as visible. Without a
   * predicate, every identification.
   */
  public identificationsVisibleTo(
    isFieldVisible?: TIdResolveOptions["isFieldVisible"],
  ): readonly TIdentification[] {
    const all = this.identifications;
    if (!isFieldVisible) return all;
    const always = this._meta.getAlwaysAddressable();
    return all.filter((ident) => ident.fields.every((f) => always.has(f) || isFieldVisible(f)));
  }

  /**
   * Physical column name of the single `@meta.id` field, or `null` when the
   * schema has zero or multiple `@meta.id` fields. Used by adapters to return
   * the user's logical ID instead of the DB-generated one on insert.
   *
   * @internal Adapter-facing surface; not part of the consumer API.
   */
  public get metaIdPhysical(): string | null {
    this._ensureBuilt();
    if (this._metaIdPhysical === undefined) {
      const fields = this._meta.originalMetaIdFields;
      if (fields.length === 1) {
        const field = fields[0];
        this._metaIdPhysical = this._meta.columnMap.get(field) ?? field;
      } else {
        this._metaIdPhysical = null;
      }
    }
    return this._metaIdPhysical;
  }

  /**
   * Logical field name of the field annotated with `@db.column.version`, or
   * `undefined` when the table has no version column. This is the key used in
   * `$cas: { <versionColumn>: N }`, in write payloads, in rows read back, and in
   * `/meta`'s `versionColumn` — a `@db.column 'physical_name'` rename on the
   * field changes only the storage column (see {@link versionColumnPhysical}).
   */
  public get versionColumn(): string | undefined {
    this._ensureBuilt();
    return this._meta.versionField;
  }

  /**
   * Physical column name of the `@db.column.version` field (after any
   * `@db.column` rename), or `undefined` when the table has no version column.
   * Adapters use it for the auto-bump, the CAS predicate, and the insert-time
   * `0` backfill — all of which operate on already-mapped physical rows.
   *
   * @internal Adapter-facing surface; not part of the consumer API.
   */
  public get versionColumnPhysical(): string | undefined {
    this._ensureBuilt();
    const field = this._meta.versionField;
    if (field === undefined) return undefined;
    return this._meta.columnMap.get(field) ?? field;
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

  /** Logical → physical column name mapping from `@db.column` (top-level only on document storage). */
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

  /**
   * `@db.column.derived` fields (logical name → what they read) — computed
   * from a JSON leaf of the same row, never written. Since 0.1.141.
   */
  public get derivedFields(): ReadonlyMap<string, TDerivedColumn> {
    this._ensureBuilt();
    return this._meta.derivedFields;
  }

  /** Navigational fields (`@db.rel.to` / `@db.rel.from`) — not stored as columns. */
  public get navFields(): ReadonlySet<string> {
    this._ensureBuilt();
    return this._meta.navFields;
  }

  /** Physical field names used to invert exclude-mode `$select` into a SELECT list. */
  public get allPhysicalFields(): readonly string[] {
    this._ensureBuilt();
    return this._meta.allPhysicalFields;
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

  /**
   * The `@db.rel.FK` entry a `@db.rel.to` relation is backed by — paired
   * exactly like relation loading and nested writes pair them: by the
   * relation's alias when it has one, else by the target table. `undefined`
   * for an unknown name, a `@db.rel.from` / `@db.rel.via` relation (their key
   * lives on the other table) or a TO relation without a matching FK.
   *
   * @since 0.1.143
   */
  public foreignKeyOf(relationName: string): TDbForeignKey | undefined {
    const relation = this.relations.get(relationName);
    if (relation?.direction !== "to") return undefined;
    return findFKEntryForRelation(relation, this._meta.foreignKeys);
  }

  /**
   * Logical paths stored as ONE JSON column (`storage: "json"` — `@db.json`
   * fields and nested objects / arrays a relational adapter serializes): the
   * engine cannot address a sub-path of such a column in a projection,
   * filter or sort, so a permission layer treats it atomically (visible whole
   * or not at all). Navigation fields excluded; empty on document adapters
   * (they store nested values natively).
   *
   * @since 0.1.143
   */
  public get jsonParents(): ReadonlySet<string> {
    this._ensureBuilt();
    return this._meta.jsonParents;
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

  /**
   * Physical column (or document path) of a logical field path —
   * `@db.column` renames and flattening applied.
   * @since 0.1.147
   */
  public physicalPath(logical: string): string {
    this._ensureBuilt();
    return this._meta.physicalPath(logical);
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
   * Physical rows of one read → logical rows: the field mapper's per-read
   * work (the derived read plan on document adapters) is done once for all
   * of them. Every read path funnels through here.
   */
  private _fromRead(
    rows: Record<string, unknown>[],
    controls: TReadControls | undefined,
  ): Record<string, unknown>[] {
    return this._fieldMapper.reconstructRows(rows, this._meta, controls);
  }

  /**
   * Translates a read query for the adapter. A `$select` that leaves out a
   * key a `$with` relation joins on — a TO relation's foreign key, the key a
   * FROM / VIA relation is looked up by — is widened with it for the read
   * (since 0.1.143), and {@link _finishRead} strips it again once the
   * relations are loaded: the joined object never reads `null` just because
   * its key was not selected.
   */
  private _translateRead(query: Uniquery | undefined): TReadPlan {
    let readQuery = (query ?? {}) as Uniquery;
    const controls = readQuery.controls as UniqueryControls | undefined;
    const withRelations = controls?.$with as WithRelation[] | undefined;
    let widened: string[] = [];
    if (withRelations?.length && controls?.$select) {
      const widen = this._widenSelectForWith(controls.$select, withRelations);
      if (widen) {
        readQuery = { ...readQuery, controls: { ...controls, $select: widen.select } } as Uniquery;
        widened = widen.added;
      }
    }
    return {
      translated: this._fieldMapper.translateQuery(readQuery, this._meta),
      controls: readQuery.controls as TReadControls | undefined,
      withRelations,
      widened,
    };
  }

  /**
   * Reconstructs + decrypts a read's rows, keeps the ones `pick` selects (all
   * by default), loads their `$with` relations and strips widened keys.
   */
  private async _finishRead(
    results: Record<string, unknown>[],
    read: TReadPlan,
    pick?: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const all = this._fromRead(results, read.controls);
    await this._decryptRows(all);
    const rows = pick ? pick(all) : all;
    if (read.withRelations?.length) {
      await this.loadRelations(rows, read.withRelations);
      for (const key of read.widened) {
        for (const row of rows) deletePath(row, key);
      }
    }
    return rows;
  }

  /** `$select` plus the join keys of `withRelations` it leaves out — `undefined` when none is missing. */
  private _widenSelectForWith(
    select: NonNullable<UniqueryControls["$select"]>,
    withRelations: WithRelation[],
  ): { select: NonNullable<UniqueryControls["$select"]>; added: string[] } | undefined {
    const keys = new Set<string>();
    for (const rel of withRelations) {
      for (const key of this._joinKeysOf(rel.name)) keys.add(key);
    }
    if (keys.size === 0) return undefined;
    if (isExclusionProjection(select)) {
      const added = [...keys].filter((key) => key in select);
      if (added.length === 0) return undefined;
      const next = { ...select };
      for (const key of added) delete next[key];
      return { select: next as NonNullable<UniqueryControls["$select"]>, added };
    }
    const named = new Set<string>(
      Array.isArray(select)
        ? select.filter((key): key is string => typeof key === "string")
        : Object.keys(select).filter((key) => (select as Record<string, unknown>)[key]),
    );
    // An empty projection reads every field.
    if (named.size === 0) return undefined;
    const added = [...keys].filter((key) => selfOrAncestor(key, named) === undefined);
    if (added.length === 0) return undefined;
    const next = Array.isArray(select)
      ? [...select, ...added]
      : { ...(select as Record<string, unknown>), ...Object.fromEntries(added.map((k) => [k, 1])) };
    return { select: next as NonNullable<UniqueryControls["$select"]>, added };
  }

  private _joinKeysCache?: Map<string, readonly string[]>;

  /**
   * The keys of THIS table a `$with` relation joins on: a TO relation's
   * foreign-key fields; the fields a FROM relation's (or a VIA junction's)
   * foreign key references — typically the primary key. An adapter that
   * loads relations natively re-reads the rows by primary key, so it is
   * always included there. Empty for an unknown or nested (`a.b`) name.
   */
  private _joinKeysOf(relName: string): readonly string[] {
    const cache = (this._joinKeysCache ??= new Map());
    let keys = cache.get(relName);
    if (keys === undefined) {
      keys = [];
      const relation = this._meta.relations.get(relName);
      if (relation?.direction === "to") {
        keys = this._findFKForRelation(relation)?.localFields ?? [];
      } else if (relation && this._tableResolver) {
        const remote =
          relation.direction === "from"
            ? this._tableResolver(relation.targetType())
            : relation.viaType && this._tableResolver(relation.viaType());
        const fk =
          remote &&
          this._findRemoteFK(
            remote,
            this.tableName,
            relation.direction === "from" ? relation.alias : undefined,
          );
        keys = fk?.targetFields ?? [];
      }
      if (relation && this.adapter.supportsNativeRelations()) {
        keys = [...new Set([...keys, ...this.primaryKeys])];
      }
      cache.set(relName, keys);
    }
    return keys;
  }

  /**
   * Pre-computed field metadata for adapter use.
   */
  public get fieldDescriptors(): readonly TDbFieldMeta[] {
    this._ensureBuilt();
    return this._meta.fieldDescriptors;
  }

  /**
   * The descriptors schema sync manages as columns: non-ignored, and on
   * nested-object adapters without the `@db.column.derived` fields (they store
   * nothing there). See `TableMetadata.columnDescriptors`.
   * @since 0.1.141
   */
  public get columnDescriptors(): readonly TDbFieldMeta[] {
    this._ensureBuilt();
    return this._meta.columnDescriptors;
  }

  /**
   * The columns that hold a value of their own (non-ignored, not derived) —
   * what a table recreation copies and a full replace assigns. See
   * `TableMetadata.storedDescriptors`.
   * @since 0.1.141
   */
  public get storedDescriptors(): readonly TDbFieldMeta[] {
    this._ensureBuilt();
    return this._meta.storedDescriptors;
  }

  /**
   * The target table of the navigation relation `navField` (since 0.1.134),
   * resolved through the table resolver this readable was built with (the
   * `DbSpace`'s). `undefined` when `navField` is not a relation of this table
   * or no resolver is available (a table constructed without a `DbSpace`).
   * Top-level relation names only — no dotted paths.
   *
   * ```typescript
   * const users = posts.relatedTable('author')
   * users?.primaryKeys // ['id']
   * ```
   */
  public relatedTable(navField: string): ReturnType<TTableResolver> {
    this._ensureBuilt();
    const targetType = this._meta.relations.get(navField)?.targetType();
    if (!targetType || !this._tableResolver) {
      return undefined;
    }
    return this._tableResolver(targetType);
  }

  /**
   * Resolves whether `path` references a real field — directly via `flatMap`
   * or transitively through a nav relation by recursing into the target
   * table. Defense-in-depth for query-path validation: `flattenAnnotatedType`
   * still truncates real self-referential cycles, so paths like
   * `parent.parent.name` on a self-ref schema would miss `flatMap.has` but
   * remain valid field references on the target — a path may cross the same
   * relation any number of times (callers cap the depth).
   *
   * Terminates on cyclic schemas: every hop consumes one path segment.
   */
  public isValidFieldPath(path: string): boolean {
    if (this.flatMap.has(path)) {
      return true;
    }
    const dotIdx = path.indexOf(".");
    if (dotIdx === -1) {
      return false;
    }
    const head = path.slice(0, dotIdx);
    const tail = path.slice(dotIdx + 1);
    const targetTable = this.relatedTable(head);
    if (!targetTable || typeof targetTable.isValidFieldPath !== "function") {
      return false;
    }
    return targetTable.isValidFieldPath(tail);
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
    this._guardQuery(query as Uniquery);
    const read = this._translateRead(query as Uniquery);
    const result = await this.adapter.findOne(read.translated);
    if (!result) {
      return null;
    }
    const [row] = await this._finishRead([result], read);
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
    this._guardQuery(query as Uniquery);
    const read = this._translateRead(query as Uniquery);
    const rows = await this._finishRead(await this.adapter.findMany(read.translated), read);
    return rows as Array<DbResponse<DataType, NavType, Q>>;
  }

  /**
   * `findMany` for the generic `$with` loader. With `partitionBy` (logical
   * fields), `$skip` / `$limit` apply per group of rows sharing those fields'
   * values (`BaseDbAdapter.findManyPerPartition`); `pick` chooses which of the
   * read rows to keep before their own `$with` relations load.
   *
   * @internal Relation-loader surface; not part of the consumer API.
   * @since 0.1.147
   */
  public async _findManyForRelation(
    query: Uniquery,
    opts: {
      partitionBy?: readonly string[];
      pick?: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
    },
  ): Promise<Record<string, unknown>[]> {
    this._ensureBuilt();
    this._guardQuery(query);
    const read = this._translateRead(query);
    const results = opts.partitionBy
      ? await this.adapter.findManyPerPartition(
          read.translated,
          opts.partitionBy.map((field) => this._meta.physicalPath(field)),
        )
      : await this.adapter.findMany(read.translated);
    return this._finishRead(results, read, opts.pick);
  }

  /**
   * Counts records matching the query.
   */
  public async count(query?: Uniquery<OwnProps, NavType>): Promise<number> {
    this._ensureBuilt();
    query ??= { filter: {}, controls: {} } as Uniquery<OwnProps, NavType>;
    this._guardQuery(query as Uniquery);
    return this.adapter.count(this._fieldMapper.translateQuery(query as Uniquery, this._meta));
  }

  /**
   * Finds records and total count in a single logical call.
   */
  public async findManyWithCount<Q extends Uniquery<OwnProps, NavType>>(
    query: Q,
  ): Promise<{ data: Array<DbResponse<DataType, NavType, Q>>; count: number }> {
    this._ensureBuilt();
    this._guardQuery(query as Uniquery);
    const read = this._translateRead(query as Uniquery);
    const result = await this.adapter.findManyWithCount(read.translated);
    const rows = await this._finishRead(result.data, read);
    return {
      data: rows as Array<DbResponse<DataType, NavType, Q>>,
      count: result.count,
    };
  }

  // ── Aggregation ─────────────────────────────────────────────────────────

  /**
   * Executes an aggregate query with GROUP BY and aggregate functions.
   *
   * Validates:
   * - `$select` computed entries and calendar buckets (the shared normalizer,
   *   `normalizeComputedSelect`: shapes, unit, zone, alias, grouping)
   * - Plain fields in $select are a subset of $groupBy
   * - When dimensions/measures are defined (strict mode): $groupBy fields
   *   must be dimensions, aggregate $field values must be measures (or '*';
   *   a `countDistinct` field may also be a dimension)
   * - the path guard (a bucket source must pass `bucketSourceVerdict` —
   *   timestamp type, no JSON ancestor, a dimension in strict mode, an
   *   adapter with calendar buckets), the adapter's aggregate functions
   *   (`AGG_FN_NOT_SUPPORTED`) and calendar-bucket units
   *   (`BUCKET_NOT_SUPPORTED`)
   *
   * Translates field names, delegates to adapter.aggregate(),
   * then reverse-maps and applies fromStorage formatters on results.
   */
  public async aggregate(query: AggregateQuery): Promise<Array<Record<string, unknown>>> {
    this._ensureBuilt();
    const { $groupBy, $select } = query.controls;

    // Computed-entry shapes + calendar buckets, before any rule reads `$select`
    // (the rules below then meet only strings, aggregates and valid buckets).
    const buckets = normalizeComputedSelect(query.controls, this._meta, true);

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
    if (isStrictTable(this._meta)) {
      const dimSet = new Set(dimensions);
      const measSet = new Set(measures);

      // A bucket alias groups by its source field, whose dimension rule is the
      // bucket source verdict's (the path guard, shared with moost-db's gate).
      const bucketAliases = new Set(buckets.map((b) => b.alias));
      for (const field of $groupBy) {
        if (!dimSet.has(field) && !bucketAliases.has(field)) {
          throw new DbError("INVALID_QUERY", [
            { path: "$groupBy", message: `Field "${field}" is not a dimension` },
          ]);
        }
      }

      if ($select) {
        for (const item of $select) {
          if (!isAggregateExpr(item) || item.$field === "*" || measSet.has(item.$field)) continue;
          // Counting distinct values is a question about a dimension as much
          // as a measure ("how many regions sold"), so either may be counted.
          if (item.$fn === "countDistinct") {
            if (dimSet.has(item.$field)) continue;
            throw new DbError("INVALID_QUERY", [
              {
                path: "$select",
                message: `Aggregate field "${item.$field}" is not a dimension or measure`,
              },
            ]);
          }
          throw new DbError("INVALID_QUERY", [
            { path: "$select", message: `Aggregate field "${item.$field}" is not a measure` },
          ]);
        }
      }
    }

    // Quantity-ref dimension requirement: aggregating a field tagged with
    // `@db.amount.currency.ref` or `@db.unit.ref` must group by the referenced
    // sibling field — summing rows that mix currencies (or units) is wrong.
    const { quantityRefByField } = this._meta;
    if ($select && quantityRefByField.size > 0) {
      const groupBySet = new Set($groupBy);
      for (const item of $select) {
        if (!isAggregateExpr(item) || item.$field === "*") continue;
        const refField = quantityRefByField.get(item.$field);
        if (refField && !groupBySet.has(refField)) {
          throw new DbError("INVALID_QUERY", [
            {
              path: "$select",
              message: `Aggregate "${item.$fn}(${item.$field})" requires "${refField}" in $groupBy — quantity-ref-tagged fields must be grouped by their dimension`,
            },
          ]);
        }
      }
    }

    // A grouped `$search` must answer for exactly the rows the same term returns
    // in the leaf list, so it takes the leaf path's two gates before dispatch:
    // the source must be able to run it, and a blank-but-present term matches
    // nothing (`search()` returns [] outright) rather than everything.
    const searchTerm = query.controls.$search;
    if (typeof searchTerm === "string" && searchTerm) {
      this._ensureSearchable();
      if (!searchTerm.trim()) {
        return query.controls.$count ? [{ count: 0 }] : [];
      }
    }

    // Encrypted-field guards: $groupBy / aggregate refs / $having / filter,
    // then the path guard and the adapter's calendar-bucket units.
    guardAggregate(this._meta, this.adapter, query, buckets);

    // Translate and delegate
    const dbQuery = this._fieldMapper.translateAggregateQuery(query, this._meta, buckets);
    const results = await this.adapter.aggregate(dbQuery);

    // Aggregate rows take the same reverse path as regular rows (since
    // 0.1.128): physical → logical names, fromStorage formatters, boolean /
    // decimal / JSON coercion of grouped columns, and a flattened leaf
    // (`stats__views`) nests as `{ stats: { views } }`. Keys that are not
    // columns — aggregate aliases such as `total` or `count_star`, calendar
    // bucket labels — are copied as-is by both strategies; an aggregate alias
    // that collides with a physical column name is treated as that column (as
    // the formatter rule always did). A bucket alias never collides (the
    // normalizer rejects it), so no formatter ever touches a label. Rows an
    // adapter already returns nested (MongoDB) pass through unchanged. A
    // grouped derived field on a document adapter is filled from its source
    // path (the grouped dimension) and the source pruned (since 0.1.141).
    return this._fromRead(results, query.controls);
  }

  // ── Search ──────────────────────────────────────────────────────────────

  /** Whether the underlying adapter supports text search. */
  public isSearchable(): boolean {
    return this.adapter.isSearchable();
  }

  /** Whether the adapter can filter on a given field (proxies adapter capability). */
  public canFilterField(fd: TDbFieldMeta): boolean {
    return this.adapter.canFilterField(fd);
  }

  /** Calendar-bucket units the adapter can group by (proxies adapter capability; empty = none). */
  public calendarBucketUnits(): ReadonlySet<BucketUnit> {
    return this.adapter.calendarBucketUnits();
  }

  /** Aggregate functions the adapter renders (proxies adapter capability). @since 0.1.136 */
  public aggregateFns(): ReadonlySet<AggregateFn> {
    return this.adapter.aggregateFns();
  }

  /** Whether the adapter can sort by a given field (proxies adapter capability). */
  public canSortField(fd: TDbFieldMeta): boolean {
    return this.adapter.canSortField(fd);
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
    this._ensureSearchable();
    this._guardQuery(query as Uniquery);
    const read = this._translateRead(query as Uniquery);
    const results = await this.adapter.search(text, read.translated, indexName);
    const rows = await this._finishRead(results, read);
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
    this._ensureSearchable();
    this._guardQuery(query as Uniquery);
    const read = this._translateRead(query as Uniquery);
    const result = await this.adapter.searchWithCount(text, read.translated, indexName);
    const rows = await this._finishRead(result.data, read);
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
    this._guardQuery(query as Uniquery | undefined);
    const read = this._translateRead(query as Uniquery | undefined);
    const results = await this.adapter.vectorSearch(vector, read.translated, indexName);
    const rows = await this._finishRead(results, read);
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
    this._guardQuery(query as Uniquery | undefined);
    const read = this._translateRead(query as Uniquery | undefined);
    const result = await this.adapter.vectorSearchWithCount(vector, read.translated, indexName);
    const rows = await this._finishRead(result.data, read);
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

  // ── Geo Search ────────────────────────────────────────────────────────

  /** Whether the underlying adapter supports geospatial search. */
  public isGeoSearchable(): boolean {
    return this.adapter.isGeoSearchable();
  }

  /**
   * Distance-ranked geospatial search (mirrors {@link vectorSearch}).
   * Results are sorted by distance ascending; each row carries a computed
   * `$distance` field (meters from the query point). `$maxDistance` /
   * `$minDistance` (meters) ride in `query.controls`; user `$sort` is rejected.
   *
   * Overloads:
   * - `geoSearch(point, query?)` — uses the table's only geo index
   * - `geoSearch(indexName, point, query?)` — targets a specific geo index
   */
  public async geoSearch<Q extends Uniquery<OwnProps, NavType>>(
    pointOrIndex: [number, number] | string,
    maybePointOrQuery?: [number, number] | Q,
    maybeQuery?: Q,
  ): Promise<Array<DbResponse<DataType, NavType, Q> & { $distance: number }>> {
    const { point, query, indexName } = this._resolveGeoSearchArgs<Q>(
      pointOrIndex,
      maybePointOrQuery,
      maybeQuery,
    );
    const read = this._prepareGeoSearch(point, query, indexName);
    const results = await this.adapter.geoSearch(point, read.translated, indexName);
    const rows = await this._finishRead(results, read);
    return rows as Array<DbResponse<DataType, NavType, Q> & { $distance: number }>;
  }

  /**
   * Distance-ranked geospatial search with count for paginated results.
   *
   * Overloads:
   * - `geoSearchWithCount(point, query?)` — uses the table's only geo index
   * - `geoSearchWithCount(indexName, point, query?)` — targets a specific geo index
   */
  public async geoSearchWithCount<Q extends Uniquery<OwnProps, NavType>>(
    pointOrIndex: [number, number] | string,
    maybePointOrQuery?: [number, number] | Q,
    maybeQuery?: Q,
  ): Promise<{
    data: Array<DbResponse<DataType, NavType, Q> & { $distance: number }>;
    count: number;
  }> {
    const { point, query, indexName } = this._resolveGeoSearchArgs<Q>(
      pointOrIndex,
      maybePointOrQuery,
      maybeQuery,
    );
    const read = this._prepareGeoSearch(point, query, indexName);
    const result = await this.adapter.geoSearchWithCount(point, read.translated, indexName);
    const rows = await this._finishRead(result.data, read);
    return {
      data: rows as Array<DbResponse<DataType, NavType, Q> & { $distance: number }>,
      count: result.count,
    };
  }

  /** Resolves overloaded geo search arguments into canonical form. */
  private _resolveGeoSearchArgs<Q>(
    pointOrIndex: [number, number] | string,
    maybePointOrQuery?: [number, number] | Q,
    maybeQuery?: Q,
  ): { point: [number, number]; query: Q | undefined; indexName: string | undefined } {
    if (Array.isArray(pointOrIndex)) {
      // geoSearch(point, query?)
      return {
        point: pointOrIndex,
        query: maybePointOrQuery as Q | undefined,
        indexName: undefined,
      };
    }
    // geoSearch(indexName, point, query?)
    return {
      point: maybePointOrQuery as [number, number],
      query: maybeQuery,
      indexName: pointOrIndex,
    };
  }

  /** Shared geoSearch validation + query translation. */
  private _prepareGeoSearch(
    point: [number, number],
    query: Uniquery | undefined,
    indexName: string | undefined,
  ): TReadPlan {
    this._ensureBuilt();
    // Schema facts first, adapter capability last: a table without the geo
    // index answers the same on every adapter (PostgreSQL only learns PostGIS
    // for tables with geo columns), so a permission layer hiding an index can
    // answer exactly like a table that has none.
    const geoIndexes = [...this._meta.indexes.values()].filter((index) => index.type === "geo");
    if (geoIndexes.length === 0) {
      throw new DbError("GEO_INDEX_MISSING", [
        {
          path: "",
          message: geoIndexNotFoundMessage(this.tableName),
        },
      ]);
    }
    if (indexName !== undefined && !geoIndexes.some((index) => index.name === indexName)) {
      throw new DbError("GEO_INDEX_MISSING", [
        {
          path: indexName,
          message: geoIndexNotFoundMessage(this.tableName, indexName),
        },
      ]);
    }
    if (!this.adapter.isGeoSearchable()) {
      throw new DbError("GEO_NOT_SUPPORTED", [
        {
          path: "",
          message: `Geo search is not supported by the adapter behind table "${this.tableName}"`,
        },
      ]);
    }
    assertGeoPoint(point, "$center");
    const controls = (query?.controls ?? {}) as Record<string, unknown>;
    if (controls.$sort) {
      throw new DbError("INVALID_QUERY", [
        {
          path: "$sort",
          message: "geoSearch results are distance-ordered — $sort is not allowed on this path",
        },
      ]);
    }
    for (const key of ["$maxDistance", "$minDistance"] as const) {
      const v = controls[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
        throw new DbError("INVALID_QUERY", [
          { path: key, message: `${key} must be a non-negative number of meters` },
        ]);
      }
    }
    this._guardQuery(query);
    return this._translateRead(query);
  }

  // ── Find by ID ──────────────────────────────────────────────────────────

  /**
   * Finds a single record by any type-compatible identifier — primary key
   * or single-field unique index.
   * The return type excludes nav props unless `$with` is provided in controls.
   *
   * The id addresses exactly ONE row, primary key first (since 0.1.143) —
   * see {@link resolveRowFilter}: when a scalar id equals one row's primary
   * key and another row's unique key, the primary-key row is returned.
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
    return this.findOneByRow(id, { controls: query?.controls }) as Promise<DbResponse<
      DataType,
      NavType,
      Q
    > | null>;
  }

  /**
   * Reads the ONE row an id addresses — resolved exactly like
   * {@link resolveRowFilter} (primary key first, `opts.scope` /
   * `opts.isFieldVisible` as there) — with `opts.controls` applied, in one
   * step: the identifications are probed in order with the caller's
   * controls and the first row found wins, so no pin-then-reread. The row
   * must also match `opts.scope` (an out-of-scope row answers `null` like a
   * missing one).
   *
   * @since 0.1.143
   */
  public async findOneByRow<
    Q extends { controls?: UniqueryControls<OwnProps, NavType> } = Record<string, never>,
  >(id: unknown, opts?: TRowResolveOptions & Q): Promise<DbResponse<DataType, NavType, Q> | null> {
    this._ensureBuilt();
    const controls = opts?.controls ?? {};
    for (const candidate of this._idCandidates(id, opts)) {
      const row = await this.findOne({
        filter: this._andScope(candidate, opts?.scope),
        controls,
      } as Uniquery<OwnProps, NavType>);
      if (row) return row as DbResponse<DataType, NavType, Q>;
    }
    return null;
  }

  /**
   * Resolve an id value (scalar or object) into a {@link FilterExpr} using the
   * same identifications as {@link findById}. Public so callers can
   * AND-combine the id-filter with a row-level read overlay before issuing
   * `findOne` (avoiding the existence leak that `findById` would cause).
   * `opts.isFieldVisible` (since 0.1.134) drops unique indexes over hidden
   * fields — see {@link identificationsVisibleTo}.
   *
   * The result is a plain `$or` over every identification the id is
   * type-compatible with (a scalar can equal one row's primary key AND
   * another row's unique key), so it may match more than one row. Code that
   * must address exactly one row — writes, pre-images, `/one` reads — uses
   * {@link resolveRowFilter} instead.
   */
  public resolveIdFilter(id: unknown, opts?: TIdResolveOptions): FilterExpr | null {
    return this._resolveIdFilter(id, opts);
  }

  /**
   * Resolve an id value (scalar or object) into a filter that matches exactly
   * ONE row, deterministically and primary key first (since 0.1.143):
   *
   * - an id that yields a single identification (e.g. a numeric PK with no
   *   type-compatible unique key) resolves to it without a read;
   * - an object id carrying the complete primary key resolves by the primary
   *   key alone — exactly like a write payload is identified;
   * - otherwise the identifications are tried in order (primary key first,
   *   then each unique index): the first one that matches a row wins and the
   *   result is that row's exact primary-key filter;
   * - when none matches, the first identification is returned (it matches
   *   nothing, so callers answer "not found" as usual).
   *
   * `null` when the id resolves to no identification at all. Every write
   * (`deleteOne`, the guards' `current()`) and `findById` go through this
   * resolution; call it inside the write's transaction when the answer must
   * stay pinned. `opts.isFieldVisible` as in {@link resolveIdFilter}.
   *
   * `opts.scope` (a row-level overlay) restricts which rows count as matches
   * while the identifications are tried — a row outside it never shadows one
   * inside it, so the answer is the same as if that row did not exist. AND
   * the scope onto the result to exclude an out-of-scope row the id names
   * unambiguously. See {@link TRowResolveOptions}.
   */
  public async resolveRowFilter(
    id: unknown,
    opts?: TRowResolveOptions,
  ): Promise<FilterExpr | null> {
    this._ensureBuilt();
    return this._pinIdCandidates(this._idCandidates(id, opts), opts?.scope);
  }

  /**
   * Resolve an id value into a filter expression (the `$or` of
   * {@link _idCandidates}; a single candidate is returned as-is).
   */
  protected _resolveIdFilter(id: unknown, opts?: TIdResolveOptions): FilterExpr | null {
    const candidates = this._idCandidates(id, opts, false);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;
    return { $or: candidates } as FilterExpr;
  }

  /**
   * The ordered identification filters an id value can resolve through —
   * primary key first, then each unique index.
   *
   * When `preferredId` differs from the PK, scalar ids resolve only against
   * the preferred field (deterministic addressing). Otherwise scalars try PK
   * + every single-field unique index; objects try PK + compound unique
   * indexes. With `opts.isFieldVisible`, only the identifications
   * {@link identificationsVisibleTo} keeps are tried. With `pkWins` (the
   * default), an object id carrying the complete primary key yields the
   * primary-key filter alone.
   */
  protected _idCandidates(id: unknown, opts?: TIdResolveOptions, pkWins = true): FilterExpr[] {
    const pkFields = this.primaryKeys;
    const preferredFields = this.preferredId;
    const isExplicitPreferred =
      preferredFields.length !== pkFields.length ||
      preferredFields.some((f, i) => f !== pkFields[i]);
    const isScalar = id === null || typeof id !== "object";

    if (isScalar && isExplicitPreferred && preferredFields.length === 1) {
      const filter = this._tryFieldFilter(preferredFields[0]!, id);
      return filter ? [filter] : [];
    }

    const idObj = isScalar ? null : (id as Record<string, unknown>);
    if (idObj && pkWins && pkFields.length > 0) {
      const pkFilter = this._tryCompoundFilter(pkFields, idObj);
      if (pkFilter) return [pkFilter];
    }

    // Accept both scalar id and `{[field]: scalar}` object form.
    const tryScalarOrField = (field: string): FilterExpr | null => {
      const value = isScalar ? id : idObj![field];
      return value === undefined ? null : this._tryFieldFilter(field, value);
    };

    const candidates: FilterExpr[] = [];
    const identifications = this.identificationsVisibleTo(opts?.isFieldVisible);

    // Single-field identifications (PK + every single-field unique index).
    for (const ident of identifications) {
      if (ident.fields.length !== 1) continue;
      const filter = tryScalarOrField(ident.fields[0]!);
      if (filter) candidates.push(filter);
    }

    // Compound identifications (object form only). PK is unconditional;
    // compound unique indexes are fallback — only attempted when nothing
    // else has matched, so a single-field match wins over a compound one.
    if (idObj) {
      for (const ident of identifications) {
        if (ident.fields.length < 2) continue;
        if (ident.source !== "primaryKey" && candidates.length > 0) break;
        const filter = this._tryCompoundFilter(ident.fields, idObj);
        if (filter) candidates.push(filter);
      }
    }

    return candidates;
  }

  /**
   * Picks the one row a list of identification candidates addresses — see
   * {@link resolveRowFilter}. A lone candidate needs no read. With a
   * non-empty `scope`, only rows matching it count as matches.
   */
  protected async _pinIdCandidates(
    candidates: FilterExpr[],
    scope?: FilterExpr,
  ): Promise<FilterExpr | null> {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;
    // One read over every candidate; the candidate order is applied in memory.
    const pkFields = this.primaryKeys;
    const select = new Set<string>(pkFields);
    for (const candidate of candidates) {
      for (const field in candidate) select.add(field);
    }
    const rows = (await this.findMany({
      filter: this._andScope({ $or: candidates } as FilterExpr, scope),
      controls: { $select: [...select] },
    } as Uniquery<OwnProps, NavType>)) as Array<Record<string, unknown>>;
    if (rows.length === 0) return candidates[0]!;
    for (const candidate of candidates) {
      const row = rows.find((r) => rowMatchesKey(r, candidate as Record<string, unknown>));
      if (row) return this._pkFilterFrom(row) ?? candidate;
    }
    // Values the store compares differently than the key (e.g. a
    // case-insensitive collation) — probe the candidates one by one.
    return this._probeIdCandidates(candidates, scope);
  }

  /** Sequential fallback of {@link _pinIdCandidates}: first candidate matching a row wins. */
  private async _probeIdCandidates(
    candidates: FilterExpr[],
    scope?: FilterExpr,
  ): Promise<FilterExpr> {
    for (const candidate of candidates) {
      const pinned = await this._readPkFilter(candidate, scope);
      if (pinned) return pinned;
    }
    return candidates[0]!;
  }

  /**
   * The exact primary-key filter of `row` (values prepared like ids) — `null`
   * when the table has no primary key or `row` lacks a key field.
   */
  protected _pkFilterFrom(row: Record<string, unknown>): FilterExpr | null {
    const pkFields = this.primaryKeys;
    if (pkFields.length === 0) return null;
    const filter: FilterExpr = {};
    for (const field of pkFields) {
      const value = row[field];
      if (value === undefined) return null;
      const fieldType = this.flatMap.get(field);
      filter[field] = fieldType ? this.adapter.prepareId(value, fieldType) : value;
    }
    return filter;
  }

  /**
   * Reads the row `filter` (AND `scope`) matches and returns its exact
   * primary-key filter (`filter` itself on a table without one); `undefined`
   * when no row matches.
   */
  protected async _readPkFilter(
    filter: FilterExpr,
    scope?: FilterExpr,
  ): Promise<FilterExpr | undefined> {
    const pkFields = this.primaryKeys;
    const row = (await this.findOne({
      filter: this._andScope(filter, scope),
      controls: pkFields.length > 0 ? { $select: [...pkFields] } : {},
    } as Uniquery<OwnProps, NavType>)) as Record<string, unknown> | null;
    return row ? (this._pkFilterFrom(row) ?? filter) : undefined;
  }

  /** `filter` AND a row scope — `filter` itself when the scope is absent or empty. */
  protected _andScope(filter: FilterExpr, scope?: FilterExpr): FilterExpr {
    return scope === undefined || isEmptyObject(scope as Record<string, unknown>)
      ? filter
      : ({ $and: [filter, scope] } as FilterExpr);
  }

  /** Build a single-key filter from `idObj` over `fields`, or null if any field is missing/incompatible. */
  private _tryCompoundFilter(
    fields: readonly string[],
    idObj: Record<string, unknown>,
  ): FilterExpr | null {
    const filter: FilterExpr = {};
    for (const field of fields) {
      const value = idObj[field];
      if (value === undefined) return null;
      const fieldType = this.flatMap.get(field);
      if (fieldType && !isIdCompatible(value, fieldType)) return null;
      try {
        filter[field] = fieldType ? this.adapter.prepareId(value, fieldType) : value;
      } catch {
        return null;
      }
    }
    return filter;
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
