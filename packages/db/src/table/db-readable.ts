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
  TDbDefaultValue,
  TDbFieldMeta,
  TDbForeignKey,
  TDbIndex,
  TDbRelation,
  TIdDescriptor,
  TIdentification,
  TSearchIndexInfo,
  TTableResolver,
  TWriteTableResolver,
} from "../types";
import { TableMetadata } from "./table-metadata";
import { type FieldMappingStrategy, DocumentFieldMapper } from "../strategies/field-mapping";
import { RelationalFieldMapper } from "../strategies/relational-field-mapper";
import type { TRelationLoaderHost } from "../rel/relation-loader";
import { findFKForRelation, findRemoteFK } from "../rel/relation-helpers";
import type { DbEncryption } from "../encryption";
import { assertGeoPoint, guardAggregate, guardQuery } from "../query/query-guards";

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

  /**
   * Sets the encryption service used for `@db.encrypted` fields.
   * Called by `DbSpace` after table/view creation when the space was
   * configured with an `encryption` options block.
   */
  public setEncryption(encryption: DbEncryption | undefined): void {
    this._encryption = encryption;
  }

  /** Ensures metadata is built. Called before any metadata access. */
  protected _ensureBuilt(): void {
    if (!this._meta.isBuilt) {
      this._meta.build(this.type, this.adapter, this.logger);
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
    if (!this.adapter.isSearchable()) {
      throw new DbError("INVALID_QUERY", [
        {
          path: "$search",
          message: `Table "${this.tableName}" has no search indexes defined`,
        },
      ]);
    }
  }

  /** Engine-agnostic query-time guards (encrypted-field refs, $geoWithin shape). */
  protected _guardQuery(query: Uniquery | undefined): void {
    guardQuery(this._meta, this.adapter, query as Parameters<typeof guardQuery>[2]);
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
   * Physical column name of the field annotated with `@db.column.version`, or
   * `undefined` when the table has no version column. Used by adapters and the
   * REST integration to drive optimistic concurrency control (OCC).
   */
  public get versionColumn(): string | undefined {
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

  /**
   * Resolves whether `path` references a real field — directly via `flatMap`
   * or transitively through a nav relation by recursing into the target
   * table. Defense-in-depth for query-path validation: `flattenAnnotatedType`
   * still truncates real self-referential cycles, so paths like
   * `parent.parent.name` on a self-ref schema would miss `flatMap.has` but
   * remain valid field references on the target.
   *
   * Cycle-safe via a visited set keyed on `<tableName>:<navField>`.
   */
  public isValidFieldPath(path: string, _visited?: Set<string>): boolean {
    if (this.flatMap.has(path)) {
      return true;
    }
    const dotIdx = path.indexOf(".");
    if (dotIdx === -1) {
      return false;
    }
    const head = path.slice(0, dotIdx);
    const tail = path.slice(dotIdx + 1);
    if (!this.navFields.has(head)) {
      return false;
    }
    const relation = this._meta.relations.get(head);
    if (!relation) {
      return false;
    }
    const targetType = relation.targetType();
    if (!targetType || !this._tableResolver) {
      return false;
    }
    const targetTable = this._tableResolver(targetType);
    if (!targetTable || typeof targetTable.isValidFieldPath !== "function") {
      return false;
    }
    const visited = _visited ?? new Set<string>();
    const cycleKey = `${this.tableName}:${head}`;
    if (visited.has(cycleKey)) {
      return false;
    }
    visited.add(cycleKey);
    return targetTable.isValidFieldPath(tail, visited);
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
    const withRelations = (query.controls as UniqueryControls)?.$with as WithRelation[] | undefined;
    const translatedQuery = this._fieldMapper.translateQuery(query as Uniquery, this._meta);
    const result = await this.adapter.findOne(translatedQuery);
    if (!result) {
      return null;
    }
    const row = this._fieldMapper.reconstructFromRead(result, this._meta);
    await this._decryptRows([row]);
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
    this._guardQuery(query as Uniquery);
    const withRelations = (query.controls as UniqueryControls)?.$with as WithRelation[] | undefined;
    const translatedQuery = this._fieldMapper.translateQuery(query as Uniquery, this._meta);
    const results = await this.adapter.findMany(translatedQuery);
    const rows = results.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    await this._decryptRows(rows);
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
    const withRelations = (query.controls as UniqueryControls)?.$with as WithRelation[] | undefined;
    const translated = this._fieldMapper.translateQuery(query as Uniquery, this._meta);
    const result = await this.adapter.findManyWithCount(translated);
    const rows = result.data.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    await this._decryptRows(rows);
    if (withRelations?.length) {
      await this.loadRelations(rows, withRelations);
    }
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

    // Quantity-ref dimension requirement: aggregating a field tagged with
    // `@db.amount.currency.ref` or `@db.unit.ref` must group by the referenced
    // sibling field — summing rows that mix currencies (or units) is wrong.
    const { quantityRefByField } = this._meta;
    if ($select && quantityRefByField.size > 0) {
      const groupBySet = new Set($groupBy);
      for (const item of $select) {
        if (typeof item === "string") continue;
        if (item.$field === "*") continue;
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

    // Encrypted-field guards: $groupBy / aggregate refs / $having / filter
    guardAggregate(this._meta, this.adapter, query);

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

  /** Whether the adapter can filter on a given field (proxies adapter capability). */
  public canFilterField(fd: TDbFieldMeta): boolean {
    return this.adapter.canFilterField(fd);
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
    const withRelations = (query.controls as UniqueryControls)?.$with as WithRelation[] | undefined;
    const translated = this._fieldMapper.translateQuery(query as Uniquery, this._meta);
    const results = await this.adapter.search(text, translated, indexName);
    const rows = results.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    await this._decryptRows(rows);
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
    this._ensureSearchable();
    this._guardQuery(query as Uniquery);
    const withRelations = (query.controls as UniqueryControls)?.$with as WithRelation[] | undefined;
    const translated = this._fieldMapper.translateQuery(query as Uniquery, this._meta);
    const result = await this.adapter.searchWithCount(text, translated, indexName);
    const rows = result.data.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    await this._decryptRows(rows);
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
    this._guardQuery(query as Uniquery | undefined);
    const withRelations = (query?.controls as UniqueryControls)?.$with as
      | WithRelation[]
      | undefined;
    const translated = this._fieldMapper.translateQuery((query || {}) as Uniquery, this._meta);
    const results = await this.adapter.vectorSearch(vector, translated, indexName);
    const rows = results.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    await this._decryptRows(rows);
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
    this._guardQuery(query as Uniquery | undefined);
    const withRelations = (query?.controls as UniqueryControls)?.$with as
      | WithRelation[]
      | undefined;
    const translated = this._fieldMapper.translateQuery((query || {}) as Uniquery, this._meta);
    const result = await this.adapter.vectorSearchWithCount(vector, translated, indexName);
    const rows = result.data.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    await this._decryptRows(rows);
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
    const { translated, withRelations } = this._prepareGeoSearch(point, query, indexName);
    const results = await this.adapter.geoSearch(point, translated, indexName);
    const rows = results.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    await this._decryptRows(rows);
    if (withRelations?.length) {
      await this.loadRelations(rows, withRelations);
    }
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
    const { translated, withRelations } = this._prepareGeoSearch(point, query, indexName);
    const result = await this.adapter.geoSearchWithCount(point, translated, indexName);
    const rows = result.data.map((row) => this._fieldMapper.reconstructFromRead(row, this._meta));
    await this._decryptRows(rows);
    if (withRelations?.length) {
      await this.loadRelations(rows, withRelations);
    }
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
  ): {
    translated: ReturnType<FieldMappingStrategy["translateQuery"]>;
    withRelations?: WithRelation[];
  } {
    this._ensureBuilt();
    if (!this.adapter.isGeoSearchable()) {
      throw new DbError("GEO_NOT_SUPPORTED", [
        {
          path: "",
          message: `Geo search is not supported by the adapter behind table "${this.tableName}"`,
        },
      ]);
    }
    const geoIndexes = [...this._meta.indexes.values()].filter((index) => index.type === "geo");
    if (geoIndexes.length === 0) {
      throw new DbError("GEO_INDEX_MISSING", [
        {
          path: "",
          message: `Table "${this.tableName}" declares no @db.index.geo — geoSearch requires a geo index`,
        },
      ]);
    }
    if (indexName !== undefined && !geoIndexes.some((index) => index.name === indexName)) {
      throw new DbError("GEO_INDEX_MISSING", [
        {
          path: indexName,
          message: `Geo index "${indexName}" not found on table "${this.tableName}"`,
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
    const withRelations = (query?.controls as UniqueryControls)?.$with as
      | WithRelation[]
      | undefined;
    const translated = this._fieldMapper.translateQuery((query || {}) as Uniquery, this._meta);
    return { translated, withRelations };
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
   * Resolve an id value (scalar or object) into a {@link FilterExpr} using the
   * same identification resolution as {@link findById}. Public so callers can
   * AND-combine the id-filter with a row-level read overlay before issuing
   * `findOne` (avoiding the existence leak that `findById` would cause).
   */
  public resolveIdFilter(id: unknown): FilterExpr | null {
    return this._resolveIdFilter(id);
  }

  /**
   * Resolve an id value into a filter expression.
   *
   * When `preferredId` differs from the PK, scalar ids resolve only against
   * the preferred field (deterministic addressing). Otherwise scalars try PK
   * + every single-field unique index; objects try PK + compound unique
   * indexes.
   */
  protected _resolveIdFilter(id: unknown): FilterExpr | null {
    const pkFields = this.primaryKeys;
    const preferredFields = this.preferredId;
    const isExplicitPreferred =
      preferredFields.length !== pkFields.length ||
      preferredFields.some((f, i) => f !== pkFields[i]);
    const isScalar = id === null || typeof id !== "object";

    if (isScalar && isExplicitPreferred && preferredFields.length === 1) {
      return this._tryFieldFilter(preferredFields[0]!, id);
    }

    // Accept both scalar id and `{[field]: scalar}` object form.
    const tryScalarOrField = (field: string): FilterExpr | null => {
      const value = isScalar ? id : (id as Record<string, unknown>)[field];
      return value === undefined ? null : this._tryFieldFilter(field, value);
    };

    const orFilters: FilterExpr[] = [];
    const idObj = isScalar ? null : (id as Record<string, unknown>);

    // Single-field identifications (PK + every single-field unique index).
    for (const ident of this.identifications) {
      if (ident.fields.length !== 1) continue;
      const filter = tryScalarOrField(ident.fields[0]!);
      if (filter) orFilters.push(filter);
    }

    // Compound identifications (object form only). PK is unconditional;
    // compound unique indexes are fallback — only attempted when nothing
    // else has matched, so a single-field match wins over a compound one.
    if (idObj) {
      for (const ident of this.identifications) {
        if (ident.fields.length < 2) continue;
        if (ident.source !== "primaryKey" && orFilters.length > 0) break;
        const filter = this._tryCompoundFilter(ident.fields, idObj);
        if (filter) orFilters.push(filter);
      }
    }

    if (orFilters.length === 0) return null;
    if (orFilters.length === 1) return orFilters[0];
    return { $or: orFilters } as FilterExpr;
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
