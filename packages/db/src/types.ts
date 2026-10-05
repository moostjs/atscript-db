import type {
  AtscriptQueryNode,
  TAtscriptAnnotatedType,
  TSerializedAnnotatedType,
} from "@atscript/typescript/utils";
import type {
  AggregateFn,
  BucketUnit,
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
  /**
   * LOGICAL field paths the index reads. Absent when the adapter cannot tell
   * (e.g. a dynamic document search mapping) — treat it as "every field"
   * (fail closed) when gating access by field visibility.
   * @since 0.1.143
   */
  fields?: string[];
  /**
   * `true` on the index of its `type` that answers a request naming none
   * (at most one per type).
   * @since 0.1.143
   */
  isDefault?: boolean;
}

// ── Meta Response ───────────────────────────────────────────────────────────
// Shared contract for the `GET /meta` endpoint — emitted by the moost-db
// controller and consumed by the db-client runtime validator.

/** Relation summary in a meta response. */
export interface TRelationInfo {
  name: string;
  direction: "to" | "from" | "via";
  isArray: boolean;
  /**
   * Present (true) when the relation is `@db.rel.filterable`: clients may
   * filter by related rows (`nav=$some(…)` / `nav=$none(…)`). @since 0.1.147
   */
  filterable?: true;
}

/** Per-field capability flags in a meta response. */
export interface TFieldMeta {
  sortable: boolean;
  filterable: boolean;
  /**
   * Present only when `filterable` is `false` but narrower predicates still
   * pass the gate: their operators — `$exists` on a relational adapter's JSON
   * / array column, `$geoWithin` on a geoPoint of a geo-searchable adapter.
   * Since 0.1.132.
   */
  filterOps?: string[];
  /** Present (true) when the field is `@db.encrypted` — stored as ciphertext at rest. */
  encrypted?: boolean;
  /** Present (true) when the field carries a `@db.index.geo` geospatial index. */
  geo?: boolean;
  /**
   * Present (true) when the field is write-only over HTTP (`@db.writeOnly` or
   * stamped by a permission overlay): settable in write payloads, never
   * present in read responses. UIs render it as a set-only input.
   */
  writeOnly?: boolean;
  /**
   * Present (true) when the field is index-backed (explicit `@db.index*`,
   * primary key or unique field). Advisory only — a hint for UIs that want to
   * steer users toward cheap sort keys; it never affects whether a `$sort`
   * is accepted (`sortable` does). Since 0.1.128.
   */
  indexed?: boolean;
  /**
   * Present (true) exactly when a calendar bucket over this field passes the
   * gate: a physically filterable `number.timestamp` field (a dimension, when
   * the table declares dimensions) on an adapter with calendar buckets
   * (`bucketUnits`). Since 0.1.132.
   */
  bucketable?: true;
  /**
   * Present (true) when the field is a `@db.column.derived` column: its value
   * is computed from a `@db.json` field of the same row and is never written
   * — a write payload carrying it is accepted and the key is dropped. UIs
   * render it read-only. Since 0.1.141.
   */
  derived?: true;
  /**
   * Present (true) when the field is a computed view column (`@db.compute`):
   * its value is arithmetic over other fields of the view, evaluated by the
   * database. Advisory — sorting / filtering follow `sortable` / `filterable`.
   * Since 0.1.147.
   */
  computed?: true;
}

/** Built-in CRUD operation names; map 1:1 to public method names. */
export type TCrudOp =
  | "query"
  | "pages"
  | "one"
  | "geo"
  | "insert"
  | "update"
  | "replace"
  | "remove";

/**
 * CRUD permissions advertised in `/meta`. Key absent → operation is denied or
 * not exposed. Key present → operation is allowed; the `string[]` value is the
 * accepted UniQuery control whitelist for read ops (`[]` for write ops, which
 * take no controls — presence still signals "allowed").
 */
export type TCrudPermissions = Partial<Record<TCrudOp, string[]>>;

/** Response payload for `GET /meta`. */
export interface TMetaResponse {
  searchable: boolean;
  vectorSearchable: boolean;
  /** Whether the adapter supports `geoSearch()` AND the table declares a geo index. */
  geoSearchable?: boolean;
  searchIndexes: TSearchIndexInfo[];
  primaryKeys: string[];
  preferredId: string[];
  relations: TRelationInfo[];
  fields: Record<string, TFieldMeta>;
  type: TSerializedAnnotatedType;
  actions: TDbActionInfo[];
  crud: TCrudPermissions;
  /**
   * Logical field name of the `@db.column.version` field, when the table opts
   * into optimistic concurrency control (OCC) — the key a client sends in a
   * write body / `$cas` and reads back on rows. A `@db.column` rename on the
   * field changes only the storage column, never this name. Absent for tables
   * without the annotation, i.e. last-write-wins (default) behavior.
   */
  versionColumn?: string;
  /**
   * Calendar-bucket units the adapter can group by (`{ $bucket }` in an
   * aggregate `$select`, URL `bucket(field,unit,…)`); omitted when it has
   * none. Since 0.1.132.
   */
  bucketUnits?: BucketUnit[];
  /**
   * Aggregate functions the adapter renders (`{ $fn }` in an aggregate
   * `$select`, URL `sum(field)` / `countDistinct(field)` …) — see
   * `BaseDbAdapter.aggregateFns()`.
   *
   * @since 0.1.136
   */
  aggregateFns?: AggregateFn[];
}

// ── Actions ────────────────────────────────────────────────────────────────
// Declarative action descriptors surfaced via `/meta`. The server emits the
// information; UI clients render row buttons, batch toolbars, header buttons,
// or dispatch custom events based on the `processor` discriminator.

/** Where the action applies on the UI. */
export type TDbActionLevel = "table" | "row" | "rows";

/**
 * Semantic intent the UI maps to its own visual language (color, prominence).
 *
 * Suggested visual prominence (most → least): `negative` > `warning` > `primary`
 * > `positive` > `secondary`. Use `negative` for destructive ops (delete, purge),
 * `warning` for risky-but-non-destructive ops (retry payment, force recompute,
 * reset state), `primary` for the headline action, `positive` for benign
 * confirmations (approve, publish), `secondary` for everything else.
 */
export type TDbActionIntent = "positive" | "negative" | "warning" | "primary" | "secondary";

/** How the UI client should handle the action when invoked. */
export type TDbActionProcessor = "backend" | "navigate" | "custom";

/**
 * Single action descriptor in the `/meta` envelope. Flat shape — `processor`
 * is a string discriminator; `value` is its sibling and is always populated.
 *
 * - `processor: 'backend'` — UI POSTs to `value` (full HTTP path).
 * - `processor: 'navigate'` — UI routes to `value` (URL template; `$1` is the row PK).
 * - `processor: 'custom'`  — UI dispatches `value` as an event name (defaults to action `name`).
 */
export interface TDbActionInfo {
  name: string;
  label: string;
  level: TDbActionLevel;
  processor: TDbActionProcessor;
  value: string;
  icon?: string;
  intent?: TDbActionIntent;
  description?: string;
  order?: number;
  default?: boolean;
  /**
   * Confirmation prompt copy. String form is shown verbatim. Tuple form is
   * `[singular, plural]`: the UI picks `[0]` when the action will execute
   * against a single PK (always for `'row'`-level; for `'rows'`-level when the
   * current selection has exactly one PK) and `[1]` otherwise.
   *
   * Placeholder substitution is UI-resolved, not server-parsed. Conventional
   * placeholders: `$1` for the single PK (singular form) and `$N` for the
   * count (plural form), e.g. `['Delete order $1?', 'Delete $N orders?']`.
   */
  promptText?: string | [string, string];
  /**
   * Single-character keyboard shortcut hint. The server stores this verbatim
   * — choice of modifier prefix (Alt+, Ctrl+, bare key) and activation scope
   * (e.g. only when an actions dropdown is open) are UI/UX concerns. Conflict
   * resolution between actions sharing the same key is also up to the UI;
   * the server does no dedup.
   */
  shortcut?: string;
  /**
   * Stringified gate predicate (`fn.toString()`). Present only for `'row'`
   * and `'rows'` level actions whose decorator declared a `disabled` function.
   * The function is the batch shape `(rows: TRow[]) => (boolean | string)[]`
   * (sync). Per entry: truthy = disabled — test truthiness, not `=== true`; a
   * non-empty string is also the human-readable reason (since 0.1.141). The
   * UI evaluates against a level-specific scope to grey-out / hide the
   * button. The server has already enforced this predicate before the
   * action's handler ran — the server is authoritative; this field is purely
   * a UI hint. Server-evaluated reasons arrive per row in `$disabledReasons`.
   */
  disabled?: string;
  /**
   * Name of the `.as` interface the action's `@InputForm()` parameter expects
   * (the compiled class's `.name`). Present for an `@InputForm(FormType)`
   * parameter or a class-level `inputForm` entry. Clients fetch the
   * serialized schema via `GET /meta/form/:name` on the same controller and
   * render a form to collect the `input` field of the action's request
   * envelope. A class-level entry may name a form served elsewhere — then
   * {@link formUrl} is present and clients fetch it instead of `meta/form/:name`.
   */
  inputForm?: string;
  /**
   * Server-absolute path of the serialized form schema —
   * same convention as `value` for `'backend'` actions: clients prefix
   * their base URL. Present only together with {@link inputForm}, when the
   * form is served by another endpoint than this controller's
   * `meta/form/:name`; clients fetch it instead of the relative route.
   *
   * @since 0.1.136
   */
  formUrl?: string;
  /**
   * Present on an action another controller owns and runs (a view
   * delegating its source table's row actions): that controller's
   * server-absolute base path. `value`, `formUrl` and the per-row
   * `GET {owner}/meta/actions/:id` live there; `disabled` is not sent (the
   * row's `$actions` verdict is authoritative).
   *
   * @since 0.1.147
   */
  owner?: string;
  /**
   * Delegated action only: the {@link owner}'s identification field → the
   * path in THIS controller's rows that carries its value. Clients build the
   * action's `ids` from a row through it. Absent when every pair is
   * identical and is exactly this controller's `preferredId`.
   *
   * @since 0.1.147
   */
  idMap?: Record<string, string>;
  /**
   * `'rows'` level only: the action also accepts a query target — "every row
   * matching this filter / search" instead of a list of identifiers — of at
   * most `maxRows` rows. `url` (server-absolute) is where such a request is
   * POSTed when it is not `value` (a delegated action: this controller
   * resolves the query and runs the owner's action in batches).
   *
   * @since 0.1.147
   */
  queryTarget?: { maxRows: number; url?: string };
}

/**
 * Outcome of an action run over a target (a query target, or the
 * `@DbActionTarget` handler surface): how many rows the target matched, how
 * many the handler processed, and the rows left out — `skipped` by the gate
 * (disabled, out of scope, or `"stale"`: the row no longer matches the query
 * it was selected by) and `failed` as reported by the handler.
 *
 * @since 0.1.147
 */
export interface TDbActionTargetSummary {
  matched: number;
  processed: number;
  skipped: { id: Record<string, unknown>; reason?: string }[];
  failed: { id: Record<string, unknown>; reason: string }[];
  /**
   * The run stopped early: a batch failed after an earlier batch had run
   * (those stay applied). Its ids, and every id not reached, are in
   * `failed`. Absent when the run completed.
   */
  aborted?: { status: number; message: string };
  /**
   * A delegated run (a view's query target onto its source's action): the
   * `message` each batch's source handler returned, in batch order. Absent
   * when none returned one.
   */
  messages?: string[];
  /** {@link messages}, the distinct ones joined by newlines — for a toast. */
  message?: string;
}

/**
 * `GET /meta/actions/:id` (and `/meta/actions?…`) response: the row-level
 * actions the caller may run on that one row right now — the same answer
 * a row's `$actions` / `$disabledReasons` give, without a read grant.
 * Unknown and out-of-scope ids both answer `{ actions: [] }`.
 *
 * @since 0.1.145
 */
export interface TDbAvailableActions {
  /** Action names runnable on the row, in `/meta.actions` order. */
  actions: string[];
  /** Action name → reason, for actions disabled on the row WITH a reason. Absent when none. */
  disabledReasons?: Record<string, string>;
}

// ── CRUD Result Types ───────────────────────────────────────────────────────

export interface TDbInsertResult {
  insertedId: unknown;
}

export interface TDbInsertManyResult {
  insertedCount: number;
  insertedIds: unknown[];
}

/**
 * `insertOne` result in conflict-ignoring mode (`onConflict: 'ignore'`).
 * @since 0.1.148
 */
export interface TDbInsertIgnoreResult {
  /** Id of the inserted row; absent when the row was skipped. */
  insertedId?: unknown;
  /** `true` when the row collided on the primary key or a unique index and was skipped. */
  conflict: boolean;
}

/**
 * `insertMany` result in conflict-ignoring mode (`onConflict: 'ignore'`):
 * `insertedCount` / `insertedIds` cover the INSERTED rows only (dense, input
 * order); `inserted` and `conflicts` map back to input indices.
 * @since 0.1.148
 */
export interface TDbInsertManyIgnoreResult extends TDbInsertManyResult {
  /** Input index of each `insertedIds` entry. */
  inserted: number[];
  /** Input indices skipped because of a unique / primary-key conflict, ascending. */
  conflicts: number[];
}

/** One slot per input row of `BaseDbAdapter.insertManyIgnore`: the inserted id, or `null` for a skipped (conflicting) row. */
export type TDbInsertIgnoreSlot = { insertedId: unknown } | null;

export interface TDbUpdateResult {
  matchedCount: number;
  modifiedCount: number;
}

export interface TDbDeleteResult {
  deletedCount: number;
}

// ── Index Types ─────────────────────────────────────────────────────────────

export type TDbIndexType = "plain" | "unique" | "fulltext" | "geo";

export interface TDbIndexField {
  name: string;
  sort: "asc" | "desc";
  weight?: number;
  /**
   * Whether the indexed field is optional (declared `field?:` in the model).
   * Resolved during index finalization. Adapters use this to make a unique
   * index "present-only" so multiple value-less rows are tolerated — matching
   * SQL's `NULLS DISTINCT` default. SQL adapters get this for free and ignore
   * the flag; MongoDB needs it to emit a partial unique index.
   */
  optional?: boolean;
  /**
   * Resolved design type of the field ('string', 'number', 'boolean', …).
   * Carried alongside {@link optional} so adapters can derive a type-correct
   * present-only filter (e.g. Mongo's `partialFilterExpression`) without
   * re-resolving the field type. Undefined when the field cannot be resolved.
   */
  designType?: string;
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

/** A legitimate row-identifier shape: primary key or a unique index. */
export interface TIdentification {
  /** Logical (path) field names that form this identifier. */
  fields: readonly string[];
  /** `'primaryKey'` for the PK; the unique-index name otherwise. */
  source: string;
}

// ── Field Storage ──────────────────────────────────────────────────────────

export type TDbStorageType = "column" | "flattened" | "json";

/** Primitive result type of a JSON-leaf extraction (view JSON leaves, derived columns). */
export type TViewJsonType = "string" | "number" | "boolean";

/**
 * Where a `@db.column.derived` field reads its value from: a primitive leaf
 * inside a `@db.json` field of the SAME table (since 0.1.141).
 */
export interface TDerivedColumn {
  /** Logical path of the source leaf (`payload.customer.id`). */
  sourcePath: string;
  /**
   * Physical column of the JSON field the leaf lives in (relational layout:
   * `@db.column` rename applied, unqualified) — what the generated column's
   * expression reads.
   */
  sourceColumn: string;
  /** Segments inside {@link sourceColumn} down to the leaf. */
  jsonPath: string[];
  /** Declared leaf type — the extraction's type guard. */
  type: TViewJsonType;
}

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
  /**
   * Whether this field is index-backed: it participates in an explicit index
   * (@db.index.plain, @db.index.unique, @db.index.fulltext) OR is a primary key
   * or unique field (which are always index-backed — Mongo `_id`, SQL PK/unique
   * constraints — even without an explicit `@db.index*`).
   */
  isIndexed?: boolean;
  /** Literal currency code from `@db.amount.currency 'EUR'`. */
  currencyCode?: string;
  /** Sibling field path from `@db.amount.currency.ref 'fieldName'`. */
  currencyRefField?: string;
  /** Literal unit-of-measure from `@db.unit 'kg'`. */
  unitCode?: string;
  /** Sibling field path from `@db.unit.ref 'fieldName'`. */
  unitRefField?: string;
  /**
   * For FK fields: the resolved field metadata of the referenced (target) PK column.
   * Adapters use this in `typeMapper` to produce matching DB types for FK columns
   * (e.g., `typeMapper(field.fkTargetField)` to inherit the target PK's DB type).
   * Undefined for non-FK fields or when the target cannot be resolved.
   */
  fkTargetField?: TDbFieldMeta;
  /**
   * `@db.encrypted` — the value is AES-256-GCM encrypted by the core layer
   * before reaching the adapter. Adapters must map the column to an unbounded
   * text type and veto filtering/sorting (`canFilterField`/`canSortField`).
   * The descriptor's `designType` is forced to `'string'` (ciphertext envelope);
   * the declared type stays available via `type` for validation.
   */
  encrypted?: boolean;
  /**
   * The field's declared type is the `db.geoPoint` primitive (`[lng, lat]` tuple).
   * Adapters map this to their native geo storage (e.g. MongoDB GeoJSON Point).
   */
  isGeoPoint?: boolean;
  /**
   * `@db.column.derived` (since 0.1.141): the value is computed from a JSON
   * leaf of the same row. Relational adapters store it as a generated column
   * (`physicalName` is that column); document adapters store nothing —
   * `physicalName` is the source's document path, which filters, sorts,
   * projections and indexes address, and reads fill the field from it.
   * Never written: write payloads drop it, `$inc` / `$dec` / `$mul` on it are
   * rejected.
   */
  derived?: TDerivedColumn;
  /**
   * A computed view column (`@db.compute`, since 0.1.147): `operands` are the
   * logical paths of the view fields its value is computed from — transitive
   * (a computed operand is replaced by its own operands), never computed
   * themselves. `via` lists the intermediate computed fields the value is
   * computed through (transitively; empty when every leaf is a plain field).
   * Read-only; a computed field must not be visible when one of its operands
   * or `via` fields is hidden (the same rule as the `@db.writeOnly` seal —
   * `priority = x * 100 + rank` would otherwise give back a hidden `rank`).
   */
  computed?: { operands: readonly string[]; via: readonly string[] };
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
  /**
   * Physical column names of {@link fields} (after `@db.column` renames and
   * flattening), in the same order. Use these for DDL, constraint sync, the
   * FK diff and the schema snapshot; `fields` stays logical (query / relation
   * pairing). Absent → same as `fields`.
   */
  physicalFields?: string[];
  /**
   * Physical column names of {@link targetFields} on the referenced table
   * (its `@db.column` renames), in the same order. Absent → same as `targetFields`.
   */
  physicalTargetFields?: string[];
  /**
   * `@db.schema` of the referenced table, when it declares one — SQL DDL
   * qualifies `REFERENCES` with it (a table in another schema). Not part of
   * the schema snapshot.
   */
  targetSchema?: string;
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
  /**
   * `true` for a generated (computed) column — what a `@db.column.derived`
   * field is stored as on relational adapters. Adapters that introspect it
   * set it (SQLite `table_xinfo.hidden`, MySQL `EXTRA`, PostgreSQL
   * `is_generated`); the column diff then decides kind changes by it.
   * @since 0.1.141
   */
  generated?: boolean;
}

/**
 * Why a `@db.column.derived` column is dropped and re-added by schema sync:
 * `kind` — a regular column became derived or a derived one became regular;
 * `expression` — the source column, path or leaf type changed (compared with
 * the stored snapshot); `type` — the mapped column type differs.
 * @since 0.1.141
 */
export type TDerivedChangeReason = "kind" | "expression" | "type";

/** Result of comparing desired schema against existing database columns. */
export interface TColumnDiff {
  added: TDbFieldMeta[];
  removed: TExistingColumn[];
  renamed: Array<{ field: TDbFieldMeta; oldName: string }>;
  typeChanged: Array<{ field: TDbFieldMeta; existingType: string }>;
  nullableChanged: Array<{ field: TDbFieldMeta; wasNullable: boolean }>;
  defaultChanged: Array<{ field: TDbFieldMeta; oldDefault?: string; newDefault?: string }>;
  conflicts: Array<{ field: TDbFieldMeta; oldName: string; conflictsWith: string }>;
  /**
   * Derived columns whose live column no longer matches the model and must
   * be dropped and re-added (a generated column's expression cannot be
   * altered in place): `kind` — a regular column became derived or a derived
   * one became regular (the column-drop policy applies: normal mode rebuilds,
   * safe mode skips); `expression` — the source path or leaf type in the
   * stored snapshot differs (engines normalize expression text, so the
   * snapshot is the baseline); `type` — the mapped column type differs.
   * Absent (or empty) when nothing changed.
   *
   * Invariant: a derived field, and a live generated column, is reported
   * HERE only — never in `typeChanged`, `nullableChanged` or
   * `defaultChanged` (a generated column is nullable and has no DEFAULT). On
   * nested-object adapters derived fields are not part of the diff at all
   * (`TableMetadata.columnDescriptors` leaves them out: they store nothing
   * there), so `added` never carries one either.
   * @since 0.1.141
   */
  derivedChanged?: Array<{ field: TDbFieldMeta; reason: TDerivedChangeReason }>;
  /**
   * The primary-key FIELD SET differs between the live table and the model
   * (set semantics — a composite-key reorder is not a change, consistent with
   * the schema hash). Column names are physical; a renamed PK column is
   * compared under its new name. Only reported when the table exists.
   * @since 0.1.128
   */
  primaryKeyChanged?: TPrimaryKeyChange;
}

// ── Schema Sync: primary keys & FK introspection (since 0.1.128) ─────────

/** Old and new primary-key column sets of a table whose key definition moved. */
export interface TPrimaryKeyChange {
  /** Physical PK columns currently in the database (after rename mapping). */
  from: string[];
  /** Physical PK columns the model declares. */
  to: string[];
}

/**
 * A live foreign-key constraint as introspected from the database
 * (outbound: declared on the table that owns it).
 */
export interface TExistingForeignKey {
  /** Local (referencing) columns, in constraint order. */
  fields: string[];
  /** Referenced table name. */
  targetTable: string;
  /** Referenced columns, in constraint order. */
  targetFields: string[];
}

/**
 * A live foreign key that REFERENCES a given table (inbound edge), as returned
 * by `BaseDbAdapter.getReferencingForeignKeys(tableName)`.
 */
export interface TReferencingForeignKey {
  /** The referencing (child) table. */
  table: string;
  /** Referencing columns on `table`, in constraint order. */
  fields: string[];
  /** Referenced columns on the queried table, in constraint order. */
  targetFields: string[];
}

/** Kind of a physical database object, as returned by `BaseDbAdapter.getObjectKind`. */
export type TDbObjectKind = "table" | "view" | "materialized";

/** Options accepted by `BaseDbAdapter.ensureTable`. */
export interface TEnsureTableOptions {
  /**
   * Table names whose inline FOREIGN KEY constraints must be omitted from
   * CREATE TABLE — the constraints are added afterwards by `syncForeignKeys()`.
   * Schema sync passes the members of a foreign-key cycle so they can be
   * created in any order.
   */
  deferForeignKeysTo?: ReadonlySet<string>;
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
      | "findMany"
      | "loadRelations"
      | "primaryKeys"
      | "preferredId"
      | "relations"
      | "foreignKeys"
      | "isValidFieldPath"
    >
  | undefined;

/** Minimal table interface used by the table resolver. Avoids circular dependency with AtscriptDbTable. */
export interface AtscriptDbTableLike {
  findMany(query: unknown): Promise<Array<Record<string, unknown>>>;
  loadRelations(rows: Array<Record<string, unknown>>, withRelations: WithRelation[]): Promise<void>;
  primaryKeys: readonly string[];
  preferredId: readonly string[];
  relations: ReadonlyMap<string, TDbRelation>;
  foreignKeys: ReadonlyMap<string, TDbForeignKey>;
  getMetadata(): TableMetadata;
  isValidFieldPath(path: string): boolean;
}

// ── Write Table Resolver ─────────────────────────────────────────────────

/**
 * Nested FROM re-entry option (internal): pins every child's foreign key
 * `field` to its parent in the write's row filter; a `strict` item that
 * matches nothing → `CONFLICT`.
 * @internal
 */
export interface TNestedOwner {
  field: string;
  strict?: ReadonlyArray<boolean>;
}

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
    opts?: { maxDepth?: number; _depth?: number; _ownedBy?: TNestedOwner },
  ): Promise<TDbUpdateResult>;
  updateOne(
    payload: Record<string, unknown>,
    opts?: { maxDepth?: number },
  ): Promise<TDbUpdateResult>;
  bulkUpdate(
    payloads: Array<Record<string, unknown>>,
    opts?: { maxDepth?: number; _depth?: number; _ownedBy?: TNestedOwner },
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
  /**
   * `@db.rel.filterable` — HTTP clients may filter the parent rows by this
   * relation (`{ nav: { $some | $none: … } }`). Server-side code may always.
   * @since 0.1.147
   */
  filterable?: boolean;
  /**
   * `@db.rel.filter` condition: part of the relation's meaning — applied when
   * the relation is loaded (`$with`) and inside relational predicates.
   * @since 0.1.147
   */
  filter?: AtscriptQueryNode;
}

// ── Write semantics (Group B: payload aliases + validated-stage guard contexts) ──

/**
 * Write payload for insert / patch paths: every key optional, and optional
 * columns additionally accept `null` (an explicit NULL — `undefined` means
 * "absent" and is dropped before the row reaches defaults or validation).
 */
export type DbPatch<D> = {
  [K in keyof D]?: undefined extends D[K] ? D[K] | null : D[K];
} & Record<string, unknown>;

/**
 * Write payload for full-row replace paths: required keys stay required,
 * optional columns additionally accept `null` (explicit NULL).
 */
export type DbRow<D> = {
  [K in keyof D]: undefined extends D[K] ? D[K] | null : D[K];
} & Record<string, unknown>;

/** Built-in write actions a moost-db `AsDbController` endpoint performs. */
export type TDbWriteAction =
  | "insert"
  | "insertMany"
  | "replace"
  | "replaceMany"
  | "update"
  | "updateMany";

/**
 * Context handed to a write {@link TWriteOptions.guard} (since 0.1.128) — and
 * through it to `AsDbController.guardWrite()`. The table invokes the guard
 * exactly once, inside its own transaction, after `undefined`-pruning,
 * defaults and validation and before encryption / nested-relation phases.
 */
export interface TDbWriteGuardContext<Row = Record<string, unknown>> {
  /** The table method the guard runs for (`insertOne` → `insert`, `insertMany` → `insertMany`, …). */
  readonly action: TDbWriteAction;
  /**
   * insert/replace: validated rows with SDK-side defaults applied (plaintext,
   * nav data still attached); update: validated patches with the identifying
   * PK/unique fields present and `$cas` removed. Mutate in place to enrich —
   * the table re-validates the rows after the guard.
   */
  readonly rows: Row[];
  /** Parallel to `rows`: expected version lifted from `$cas`, or `undefined`. */
  readonly expectedVersions: ReadonlyArray<number | undefined>;
  /**
   * Lazy, memoised pre-image of `rows[i]` by its identifying filter, read
   * inside the transaction. Identified exactly like the write (primary key
   * first, then a unique index — since 0.1.143), so it is always the row the
   * write targets. `null` when the row is missing OR when it carries
   * no identifying key yet (e.g. auto-increment inserts) — never throws.
   */
  current(i: number): Promise<Row | null>;
  /**
   * Every row's pre-image in ONE read (since 0.1.143): parallel to `rows`,
   * each entry exactly what `current(i)` resolves to — a single `findMany`
   * by the rows' record filters inside the transaction, which fills the
   * same per-index memo (an index `current(i)` already read is reused, a
   * later `current(i)` reads nothing). Prefer it over a `current(i)` loop
   * for batches.
   */
  currentAll(): Promise<Array<Row | null>>;
  /**
   * The exact filter the write identifies `rows[i]` by (since 0.1.143) —
   * its primary key, else the unique index it carries (see `current(i)`),
   * each naming at most ONE row — or `null` when the row has no identifying
   * key yet (e.g. an auto-increment insert). The filter `current(i)` reads
   * by; memoised per index on first use (change a row's identifying fields
   * before asking, not after). Combine it with a policy filter to check
   * the batch in the database without reading it — every targeted row
   * matches `policy` iff `count({ $and: [{ $or: filters }, policy] })`
   * equals the number of DISTINCT filters (a missing row counts as a miss).
   */
  filterFor(i: number): _FilterExpr | null;
}

/**
 * Context handed to a delete {@link TDeleteOptions.guard} (since 0.1.128) —
 * and through it to `AsDbController.guardRemove()`. Runs inside the table's
 * transaction; an id that resolves to no filter never reaches the guard
 * (`deleteOne` answers `{ deletedCount: 0 }`).
 */
export interface TDbRemoveGuardContext<Row = Record<string, unknown>> {
  /** The id `deleteOne` was called with. */
  readonly id: unknown;
  /**
   * The exact filter the delete targets — `table.resolveRowFilter(id)`, pinned
   * inside the transaction (primary key first, since 0.1.143). Never null here.
   */
  readonly filter: _FilterExpr;
  /** Lazy, memoised pre-image of the row about to be deleted (`null` when missing). */
  current(): Promise<Row | null>;
}

/** A validated-stage write guard — see {@link TWriteOptions.guard}. */
export type TDbWriteGuard<Row = Record<string, unknown>> = (
  ctx: TDbWriteGuardContext<Row>,
) => void | Promise<void>;

/** A validated-stage delete guard — see {@link TDeleteOptions.guard}. */
export type TDbRemoveGuard<Row = Record<string, unknown>> = (
  ctx: TDbRemoveGuardContext<Row>,
) => void | Promise<void>;

/** Options of `AtscriptDbTable.touchMany` (since 0.1.129). */
export interface TTouchManyOptions {
  /**
   * `'all'` (default): every key must match its stored version — a stale or
   * missing row throws `DbError("CAS_MISMATCH")` and no version moves.
   * `'any'`: bump whatever matches and report the honest counts.
   */
  require?: "all" | "any";
}

/**
 * Options of `insertOne/Many`, `replaceOne` / `bulkReplace`, `updateOne` / `bulkUpdate`.
 * `isFieldVisible` (since 0.1.134, see {@link TIdResolveOptions}) applies to the
 * top-level rows only — a payload without its primary key identifies through
 * a unique index; nested-relation writes ignore it.
 *
 * The nested re-entries a deep write performs on related tables get neither
 * `guard`, `check` nor `isFieldVisible` — they run with the table's own
 * integrity rules only (a nested write touches only rows related to the
 * record being written). A permission layer that must authorize related
 * tables rejects nested payloads up front.
 */
export interface TWriteOptions<Row = Record<string, unknown>> extends TIdResolveOptions {
  /** Nested-relation write recursion limit (default 3). */
  maxDepth?: number;
  /**
   * Validated-stage guard (since 0.1.128): invoked exactly once inside the
   * table's transaction, after defaults + validation and before encryption
   * and nested-relation phases, with the rows the table is about to write.
   * Rows may be enriched in place — they are validated again afterwards. A
   * throw rolls the transaction back and propagates unchanged. Never runs
   * for the nested re-entries a deep write performs on related tables.
   */
  guard?: TDbWriteGuard<Row>;
  /**
   * Post-write check (since 0.1.143): invoked exactly once per top-level call,
   * inside the table's transaction, AFTER the main write and every
   * nested-relation phase — see {@link TDbWriteCheckContext}. A throw rolls
   * the transaction back (when `ctx.transactional`) and propagates unchanged.
   * Never runs for the nested re-entries a deep write performs on related tables.
   */
  check?: TDbWriteCheck;
}

/**
 * Options of `insertOne` / `insertMany`.
 * @since 0.1.148
 */
export interface TInsertOptions<Row = Record<string, unknown>> extends TWriteOptions<Row> {
  /**
   * `'error'` (default): a unique / primary-key violation throws `CONFLICT`.
   * `'ignore'`: rows that collide on the primary key or any unique index —
   * with a stored row or an earlier row of the same batch — are skipped and
   * reported by input index. Everything else (validation, NOT NULL, FK, check,
   * guard) still throws and rolls the call back. A row that creates a related
   * parent (`@db.rel.to` nested object) is rejected in this mode.
   */
  onConflict?: "error" | "ignore";
}

/**
 * Context handed to a write {@link TWriteOptions.check} (since 0.1.143) — and
 * through it to `AsDbController.checkWrite()`. Lets a permission layer verify
 * the POST-image of a write with the database's own filter semantics (a
 * row-level "WITH CHECK"): count the written rows that still match a policy
 * filter and throw when one does not.
 */
export interface TDbWriteCheckContext {
  /** The table method the check runs for (`insertOne` → `insert`, …). */
  readonly action: TDbWriteAction;
  /**
   * One exact primary-key filter per row the call wrote (inserted rows by
   * their resulting PK, updated / replaced rows by the PK of the row the
   * write actually targeted), de-duplicated. Rows the write matched nothing
   * for are absent.
   */
  readonly filters: ReadonlyArray<Record<string, unknown>>;
  /**
   * `true` when the check runs inside a real transaction, so a throw rolls
   * the write back. `false` on adapters whose transaction is a pass-through
   * (e.g. a standalone MongoDB) — the write is already durable, so a caller
   * that needs a hard guarantee must validate BEFORE the write instead.
   */
  readonly transactional: boolean;
  /** Counts rows matching `filter` inside the check's transaction. */
  count(filter: Record<string, unknown>): Promise<number>;
}

/** A post-write check — see {@link TWriteOptions.check}. */
export type TDbWriteCheck = (ctx: TDbWriteCheckContext) => void | Promise<void>;

/**
 * Options of `deleteOne`. `isFieldVisible` since 0.1.134 — see
 * {@link TIdResolveOptions}. `scope` since 0.1.143 — see
 * {@link TRowResolveOptions}; on `deleteOne` it also restricts the delete
 * itself (an out-of-scope row is not deleted, `{ deletedCount: 0 }`).
 */
export interface TDeleteOptions<Row = Record<string, unknown>> extends TRowResolveOptions {
  /**
   * Validated-stage guard (since 0.1.128): invoked inside the table's
   * transaction after the id resolved to a filter and before cascade /
   * delete. A throw rolls the transaction back and propagates unchanged.
   */
  guard?: TDbRemoveGuard<Row>;
}

/** Options of `resolveIdFilter` / `identificationsVisibleTo` (since 0.1.134). */
export interface TIdResolveOptions {
  /**
   * Field-visibility predicate (e.g. a per-request read scope). A unique-index
   * identification with a field that fails it is ignored — the id resolves
   * exactly as if that index did not exist, so a hidden unique key can never
   * answer "a row with this value exists". Primary-key, `preferredId` and
   * `@meta.id` fields always count as visible.
   */
  isFieldVisible?: (path: string) => boolean;
}

/**
 * Options of `resolveRowFilter` (and `deleteOne`) — see {@link TIdResolveOptions}.
 *
 * @since 0.1.143
 */
export interface TRowResolveOptions extends TIdResolveOptions {
  /**
   * Row scope (e.g. a per-request row-level read overlay). When an id could
   * name several rows (a scalar equal to one row's primary key and another
   * row's unique key), only rows matching `scope` count while the
   * identifications are tried primary key first — so a row outside the scope
   * can never shadow one inside it, and the outcome is exactly what it would
   * be if the out-of-scope row did not exist. It does not filter the result
   * itself: AND the scope onto the returned filter (or guard the write) to
   * exclude an out-of-scope row the id names unambiguously. Empty = no scope.
   */
  scope?: _FilterExpr;
}

// ── Nullable typing (Group C: read-side generics; since 0.1.128) ─────────────

/**
 * Adds `null` to every optional property of `O`. Optional columns store SQL
 * NULL / Mongo null, and the runtime validator accepts `null` for optional
 * props — so filter shapes (`{ note: null }`, `{ note: { $ne: null } }`) and
 * row shapes must admit it at the type level too. Homomorphic: keys and
 * required properties are unchanged; applying it twice is a no-op.
 */
export type NullableOptional<O> = {
  [K in keyof O]: undefined extends O[K] ? O[K] | null : O[K];
};
