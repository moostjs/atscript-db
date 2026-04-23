import type { TAtscriptAnnotatedType, TSerializedAnnotatedType } from "@atscript/typescript/utils";
import type {
  FilterExpr as _FilterExpr,
  UniqueryControls as _UniqueryControls,
  UniqueryInsights,
  WithRelation,
} from "@uniqu/core";
import type { UniquSelect } from "./query/uniqu-select";
import type { TableMetadata } from "./table/table-metadata";

export type { FlatOf, PrimaryKeyOf, OwnPropsOf, NavPropsOf } from "@atscript/typescript/utils";

// ── Re-export uniqu types as canonical filter/query format ──────────────────

export type {
  FilterExpr,
  FieldOpsFor,
  UniqueryControls,
  Uniquery,
  WithRelation,
  TypedWithRelation,
  AggregateExpr,
  AggregateFn,
  AggregateControls,
  AggregateQuery,
  AggregateResult,
} from "@uniqu/core";

// ── Resolved query types (adapter-facing) ──────────────────────────────────

/** Controls with resolved projection. Used in the adapter interface. */
export interface DbControls extends Omit<_UniqueryControls, "$select"> {
  $select?: UniquSelect;
}

/** Query object with resolved projection. Passed to adapter methods. */
export interface DbQuery {
  filter: _FilterExpr;
  controls: DbControls;
  /** Pre-computed query insights (field → operators). Adapters may use this to apply query-time behaviour (e.g. collation). */
  insights?: UniqueryInsights;
}

// ── Search Index Metadata ───────────────────────────────────────────────────

/** Describes an available search index exposed by a database adapter. */
export interface TSearchIndexInfo {
  /** Index name. Empty string or 'DEFAULT' for the default index. */
  name: string;
  /** Human-readable label for UI display. */
  description?: string;
  /** Index type: text search or vector similarity search. */
  type?: "text" | "vector";
}

// ── Meta Response ───────────────────────────────────────────────────────────
// Shared contract for the `GET /meta` endpoint — emitted by the moost-db
// controller and consumed by the db-client runtime validator.

/** Relation summary in a meta response. */
export interface TRelationInfo {
  name: string;
  direction: "to" | "from" | "via";
  isArray: boolean;
}

/** Per-field capability flags in a meta response. */
export interface TFieldMeta {
  sortable: boolean;
  filterable: boolean;
}

/** Response payload for `GET /meta`. */
export interface TMetaResponse {
  searchable: boolean;
  vectorSearchable: boolean;
  searchIndexes: TSearchIndexInfo[];
  primaryKeys: string[];
  readOnly: boolean;
  relations: TRelationInfo[];
  fields: Record<string, TFieldMeta>;
  type: TSerializedAnnotatedType;
}

// ── CRUD Result Types ───────────────────────────────────────────────────────

export interface TDbInsertResult {
  insertedId: unknown;
}

export interface TDbInsertManyResult {
  insertedCount: number;
  insertedIds: unknown[];
}

export interface TDbUpdateResult {
  matchedCount: number;
  modifiedCount: number;
}

export interface TDbDeleteResult {
  deletedCount: number;
}

// ── Index Types ─────────────────────────────────────────────────────────────

export type TDbIndexType = "plain" | "unique" | "fulltext";

export interface TDbIndexField {
  name: string;
  sort: "asc" | "desc";
  weight?: number;
}

export interface TDbIndex {
  /** Unique key used for identity/diffing (e.g., "atscript__plain__email") */
  key: string;
  /** Human-readable index name. */
  name: string;
  /** Index type. */
  type: TDbIndexType;
  /** Ordered list of fields in the index. */
  fields: TDbIndexField[];
}

// ── Default Value Types ─────────────────────────────────────────────────────

export type TDbDefaultFn = "increment" | "uuid" | "now";

export type TDbCollation = "binary" | "nocase" | "unicode";

export type TDbDefaultValue =
  | { kind: "value"; value: string }
  | { kind: "fn"; fn: TDbDefaultFn; start?: number };

// ── ID Descriptor ───────────────────────────────────────────────────────────

export interface TIdDescriptor {
  /** Field names that form the primary key. */
  fields: string[];
  /** Whether this is a composite key (multiple fields). */
  isComposite: boolean;
}

// ── Field Storage ──────────────────────────────────────────────────────────

export type TDbStorageType = "column" | "flattened" | "json";

// ── Field Metadata ──────────────────────────────────────────────────────────

export interface TDbFieldMeta {
  /** The dot-notation path to this field (logical name). */
  path: string;
  /** The annotated type for this field. */
  type: TAtscriptAnnotatedType;
  /** Physical column/field name (from @db.column, __-separated for flattened, or same as path). */
  physicalName: string;
  /** Resolved design type: 'string', 'number', 'boolean', 'object', 'json', etc. */
  designType: string;
  /** Whether the field is optional. */
  optional: boolean;
  /** Whether this field is part of the primary key (@meta.id). */
  isPrimaryKey: boolean;
  /** Whether this field is excluded from the DB (@db.ignore). */
  ignored: boolean;
  /** Default value from @db.default.* */
  defaultValue?: TDbDefaultValue;
  /**
   * How this field is stored in the database.
   * - 'column': a standard scalar column (default for primitives)
   * - 'flattened': a leaf scalar from a flattened nested object
   * - 'json': stored as a single JSON column (arrays, @db.json fields)
   */
  storage: TDbStorageType;
  /**
   * For flattened fields: the dot-notation path (same as `path`).
   * E.g., for physicalName 'contact__email', this is 'contact.email'.
   * Undefined for non-flattened fields.
   */
  flattenedFrom?: string;
  /** Old physical column name from @db.column.renamed (for rename migration). */
  renamedFrom?: string;
  /** Collation from @db.column.collate (e.g. 'nocase', 'binary', 'unicode'). */
  collate?: TDbCollation;
  /** Whether this field participates in any index (@db.index.plain, @db.index.unique, @db.index.fulltext). */
  isIndexed?: boolean;
  /**
   * For FK fields: the resolved field metadata of the referenced (target) PK column.
   * Adapters use this in `typeMapper` to produce matching DB types for FK columns
   * (e.g., `typeMapper(field.fkTargetField)` to inherit the target PK's DB type).
   * Undefined for non-FK fields or when the target cannot be resolved.
   */
  fkTargetField?: TDbFieldMeta;
}

// ── Value Formatters ─────────────────────────────────────────────────────

export interface TValueFormatterPair {
  /** Converts a JS value to storage representation (write + filter paths). */
  toStorage: (value: unknown) => unknown;
  /** Converts a storage value back to JS representation (read path). */
  fromStorage: (value: unknown) => unknown;
}

// ── Foreign Key Types ────────────────────────────────────────────────────

export type TDbReferentialAction = "cascade" | "restrict" | "noAction" | "setNull" | "setDefault";

export interface TDbForeignKey {
  /** FK field names on this table (local columns). */
  fields: string[];
  /** Target table name (from the chain ref's type @db.table annotation). */
  targetTable: string;
  /** Target field names on the referenced table. */
  targetFields: string[];
  /** Lazy reference to the target annotated type (for on-demand table resolution). */
  targetTypeRef?: () => TAtscriptAnnotatedType;
  /** Alias grouping FK fields (if any). */
  alias?: string;
  /** Referential action on delete. */
  onDelete?: TDbReferentialAction;
  /** Referential action on update. */
  onUpdate?: TDbReferentialAction;
}

// ── Schema Sync Types ────────────────────────────────────────────────────

/** Describes an existing column in the database (from introspection). */
export interface TExistingColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  /** Serialized default value (e.g., "'active'", "NULL"). */
  dflt_value?: string;
}

/** Result of comparing desired schema against existing database columns. */
export interface TColumnDiff {
  added: TDbFieldMeta[];
  removed: TExistingColumn[];
  renamed: Array<{ field: TDbFieldMeta; oldName: string }>;
  typeChanged: Array<{ field: TDbFieldMeta; existingType: string }>;
  nullableChanged: Array<{ field: TDbFieldMeta; wasNullable: boolean }>;
  defaultChanged: Array<{ field: TDbFieldMeta; oldDefault?: string; newDefault?: string }>;
  conflicts: Array<{ field: TDbFieldMeta; oldName: string; conflictsWith: string }>;
}

/** Result of applying column diff to the database. */
export interface TSyncColumnResult {
  added: string[];
  renamed: string[];
}

/** A single table-level option in unified key-value format. */
export interface TExistingTableOption {
  key: string;
  value: string;
}

/** Result of comparing desired table options against existing ones. */
export interface TTableOptionDiff {
  changed: Array<{
    key: string;
    oldValue: string;
    newValue: string;
    /** Whether applying this change requires dropping and recreating the table. */
    destructive: boolean;
  }>;
}

// ── Metadata Overrides ───────────────────────────────────────────────────

/**
 * Adapter-provided metadata adjustments applied atomically during the
 * build pipeline, before field descriptors are built.
 *
 * Replaces the old pattern where adapters mutated metadata via
 * back-references (`this._table.addPrimaryKey()`, etc.).
 */
export interface TMetadataOverrides {
  /** Fields to add as primary keys. */
  addPrimaryKeys?: string[];
  /** Fields to remove from primary keys. */
  removePrimaryKeys?: string[];
  /** Fields to register as having a unique constraint. */
  addUniqueFields?: string[];
  /** Synthetic fields to inject into flatMap (e.g. MongoDB's `_id`). */
  injectFields?: Array<{ path: string; type: TAtscriptAnnotatedType }>;
}

// ── Table Resolver ───────────────────────────────────────────────────────

/**
 * Callback that resolves an annotated type to a queryable table instance.
 * Required for `$with` relation loading — each table needs to query related tables.
 *
 * Typically provided by the driver/registry (e.g. `DbSpace.getTable`).
 */
export type TTableResolver = (
  type: TAtscriptAnnotatedType,
) =>
  | Pick<
      AtscriptDbTableLike,
      "findMany" | "loadRelations" | "primaryKeys" | "relations" | "foreignKeys"
    >
  | undefined;

/** Minimal table interface used by the table resolver. Avoids circular dependency with AtscriptDbTable. */
export interface AtscriptDbTableLike {
  findMany(query: unknown): Promise<Array<Record<string, unknown>>>;
  loadRelations(rows: Array<Record<string, unknown>>, withRelations: WithRelation[]): Promise<void>;
  primaryKeys: readonly string[];
  relations: ReadonlyMap<string, TDbRelation>;
  foreignKeys: ReadonlyMap<string, TDbForeignKey>;
  getMetadata(): TableMetadata;
}

// ── Write Table Resolver ─────────────────────────────────────────────────

/** Minimal writable table interface for nested creation/update. */
export interface AtscriptDbWritable {
  insertOne(
    payload: Record<string, unknown>,
    opts?: { maxDepth?: number },
  ): Promise<TDbInsertResult>;
  insertMany(
    payloads: Array<Record<string, unknown>>,
    opts?: { maxDepth?: number; _depth?: number },
  ): Promise<TDbInsertManyResult>;
  replaceOne(
    payload: Record<string, unknown>,
    opts?: { maxDepth?: number },
  ): Promise<TDbUpdateResult>;
  bulkReplace(
    payloads: Array<Record<string, unknown>>,
    opts?: { maxDepth?: number; _depth?: number },
  ): Promise<TDbUpdateResult>;
  updateOne(
    payload: Record<string, unknown>,
    opts?: { maxDepth?: number },
  ): Promise<TDbUpdateResult>;
  bulkUpdate(
    payloads: Array<Record<string, unknown>>,
    opts?: { maxDepth?: number; _depth?: number },
  ): Promise<TDbUpdateResult>;
  findOne(query: unknown): Promise<Record<string, unknown> | null>;
  count(query: { filter: Record<string, unknown> }): Promise<number>;
  deleteMany(filter: unknown): Promise<TDbDeleteResult>;
  /** Pre-validate items (type + FK constraints) without inserting them. */
  preValidateItems(
    items: Array<Record<string, unknown>>,
    opts?: { excludeFkTargetTable?: string },
  ): Promise<void>;
}

/**
 * Callback that resolves an annotated type to a writable table instance.
 * Used for nested creation — inserting related records inline.
 */
export type TWriteTableResolver = (
  type: TAtscriptAnnotatedType,
) => (AtscriptDbTableLike & AtscriptDbWritable) | undefined;

// ── Cascade Types ────────────────────────────────────────────────────────

/**
 * A child table that may need cascade/setNull processing when a parent is deleted.
 * Returned by the cascade resolver.
 */
export interface TCascadeTarget {
  /** FK on the child table that references the parent being deleted. */
  fk: TDbForeignKey;
  /** Name of the child table that holds this FK. */
  childTable: string;
  /** Delete matching child records (goes through AtscriptDbTable for recursive cascade). */
  deleteMany(filter: Record<string, unknown>): Promise<TDbDeleteResult>;
  /** Update matching child records (for setNull — sets FK fields to null). */
  updateMany(
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<TDbUpdateResult>;
  /** Count matching child records (for restrict — check existence before delete). */
  count(filter: Record<string, unknown>): Promise<number>;
}

/**
 * Callback that finds all child tables with FKs pointing to a given parent table.
 * Used by AtscriptDbTable to implement application-level cascade deletes.
 */
export type TCascadeResolver = (tableName: string) => TCascadeTarget[];

// ── FK Validation Types ──────────────────────────────────────────────────

/**
 * Minimal interface for querying a target table during FK validation.
 * Only `count` is needed — we check if the referenced record exists.
 */
export interface TFkLookupTarget {
  count(filter: Record<string, unknown>): Promise<number>;
}

/**
 * Callback that resolves a table name to a queryable target for FK validation.
 * Returns undefined if the target table is not registered in the space.
 */
export type TFkLookupResolver = (tableName: string) => TFkLookupTarget | undefined;

// ── Relation Types ───────────────────────────────────────────────────────

export interface TDbRelation {
  /** Direction: 'to' (FK is local), 'from' (FK is remote), or 'via' (M:N junction). */
  direction: "to" | "from" | "via";
  /** The alias used for pairing (if any). */
  alias?: string;
  /** Target type's annotated type reference. */
  targetType: () => TAtscriptAnnotatedType;
  /** Whether this is an array relation (one-to-many). */
  isArray: boolean;
  /** Junction type reference for 'via' (M:N) relations. */
  viaType?: () => TAtscriptAnnotatedType;
}
