import {
  ALL_AGGREGATE_FNS,
  ALL_VIEW_CAPABILITIES,
  ALL_BUCKET_UNITS,
  BaseDbAdapter,
  DbError,
  isConflict,
  DbSpace,
  containsRelationFilter,
  isAtscriptDbView,
  isPlainObject,
} from "@atscript/db";
import type {
  DbQuery,
  DbControls,
  TDbObjectKind,
  FilterExpr,
  TFieldOps,
  TDbFieldMeta,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbInsertIgnoreSlot,
  TDbUpdateResult,
  TDbUpdateOptions,
  TDbDeleteResult,
} from "@atscript/db";
// `@atscript/db` does NOT re-export the annotated-type; it comes from the
// atscript compiler's utils entry (same import `db-space.ts` uses).
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { cloneValue } from "./memory-clone";
import { buildMemoryPredicate, getPath, pathReader, prepareRelationSets } from "./memory-filter";
import type { MemoryRowLoader, RelationSets } from "./memory-filter";
import { compileProjection, paginate, setPath, sortRows } from "./memory-engine";
import {
  indexRow,
  recordUniqueIndex,
  tupleTaken,
  unindexRow,
  uniqueTupleKey,
  type RecordedUniqueIndex,
} from "./memory-unique";
import { aggregateRows } from "./memory-aggregate";
import type { AggregateFn, BucketUnit, TViewCapability, UniquSelect } from "@atscript/db";

/**
 * Provider (read-through) backing closure. Recomputes and returns the table's
 * rows on demand — a fresh snapshot every call (sync or async). See
 * {@link MemoryAdapter.setProvider} / {@link setMemoryProvider}.
 */
export type MemoryProviderFn = () =>
  | Array<Record<string, unknown>>
  | Promise<Array<Record<string, unknown>>>;

type TRow = Record<string, unknown>;

/**
 * One table (or view) of an in-memory database. Its presence in the
 * {@link MemoryDatabase} is what `tableExists()` reports; dropping it deletes
 * the entry, so a table added back starts empty with fresh counters.
 */
interface MemoryTableState {
  kind: Exclude<TDbObjectKind, "materialized">;
  /** Stored rows keyed by `pkKey`, in nested physical shape. */
  rows: Map<string, Record<string, unknown>>;
  /** Unique indexes recorded by `syncIndexes`, enforced on every write. */
  uniqueIndexes: RecordedUniqueIndex[];
  /**
   * Set once a stored row's primary key holds an object other than a `Date`
   * (e.g. an array): such a key can match a filter value it does not encode,
   * so reads stop resolving pinned primary keys by direct lookup.
   */
  opaquePk: boolean;
  /** Per-field `@db.default.increment` counters (physical name → last value). */
  incrementCounters: Map<string, number>;
}

/** Table/view name → state: one in-memory database. */
type MemoryDatabase = Map<string, MemoryTableState>;

/**
 * One database per {@link DbSpace}, shared by every adapter the space builds —
 * the administrative adapter schema sync drops tables through included. A
 * space is the lifetime of an in-memory database: a fresh space starts empty.
 */
const databases = new WeakMap<DbSpace, MemoryDatabase>();

/**
 * In-memory {@link BaseDbAdapter} implementation.
 *
 * Runs in one of two modes:
 * - STORED mode (default): rows live in a `Map` of the space's in-memory
 *   database, keyed by table name (see {@link databases}), so every adapter of
 *   the space that serves a name sees the same table, and the administrative
 *   adapter can drop it by name. Documents are kept in their nested PHYSICAL
 *   shape (no flattening), which is why {@link supportsNestedObjects} is `true`.
 *   Full CRUD surface: inserts, reads, update / replace / delete with
 *   optimistic-concurrency CAS.
 * - PROVIDER (read-through) mode: enabled via {@link setProvider} /
 *   {@link setMemoryProvider}. Reads are served from a runtime closure
 *   recomputed per request (e.g. a Redis/job-manager snapshot) so a
 *   runtime-owned entity with NO database can be observed as a READ-ONLY
 *   atscript table; all writes are rejected (see {@link _assertWritable}).
 */
export class MemoryAdapter extends BaseDbAdapter {
  /**
   * The in-memory database: the space's (see {@link databases}), resolved once
   * in {@link registerSpace}; an adapter used without a space keeps this own one.
   */
  private _db: MemoryDatabase = new Map();

  /** Memoized physical PK field names — stable for the adapter's lifetime. */
  private _pkFieldsCache?: string[];

  /** Memoized compiled readers of {@link _physicalPkFields}. */
  private _pkReadersCache?: Array<(row: TRow) => unknown>;

  /**
   * Memoized map of PHYSICAL field name → optional `start` for every field
   * carrying `@db.default.increment`. Stable per adapter (see
   * {@link _incrementFields}).
   */
  private _incrementFieldsCache?: Map<string, number | undefined>;

  /**
   * Provider (read-through) backing closure. When set, this adapter is
   * PROVIDER-BACKED: reads recompute rows from this closure per request and all
   * writes are rejected (see {@link _assertWritable}). `undefined` ⇒ stored mode.
   *
   * WHY late-binding only (no constructor provider option): a {@link DbSpace}'s
   * zero-arg `TAdapterFactory` builds EVERY table's adapter with the SAME
   * factory — INCLUDING the internal `__atscript_control` sync table. A provider
   * injected at construction would therefore leak onto the control table and
   * break schema sync. Provider mode must target ONE specific table's
   * already-built adapter, so it is only settable AFTER construction via
   * {@link setProvider}.
   */
  private _provider?: MemoryProviderFn;

  /**
   * The in-memory store keeps documents nested (no flattening), so the generic
   * layer should pass nested objects through as-is.
   */
  override supportsNestedObjects(): boolean {
    return true;
  }

  // ── Per-field capability ────────────────────────────────────────────────────

  /**
   * Parity with the Mongo adapter (`return !fd.encrypted`). The in-memory
   * dot-path filter visitor CAN filter into nested objects AND array
   * (`storage === 'json'`) fields, so JSON storage is NOT a filterability
   * blocker here. The base default vetoes `storage === 'json'` — correct for SQL
   * engines that cannot reach into a raw JSON column, but WRONG for this
   * nested-object-capable adapter, and it would under-report `filterable` to
   * `/meta` for UIs. Overriding fixes that. The `@db.encrypted` veto is
   * core-supplied and absolute (equality/range over ciphertext is meaningless),
   * so it is preserved.
   *
   * NOTE on the capabilities left at their base defaults ON PURPOSE:
   * - `canSortField` — its conservative JSON veto (array sort-by-min/max-element
   *   is a footgun for generic UI sort headers) is deliberate, matching Mongo.
   * - `supportsNativePatch` / `supportsNativeRelations` — stay `false`: core
   *   decomposes patches into dot-path `$set`s and loads relations app-level.
   */
  override canFilterField(fd: TDbFieldMeta): boolean {
    return !fd.encrypted;
  }

  /**
   * Relational predicates (`{ nav: { $some | $none: … } }`) are evaluated in
   * reads AND mutation filters. Before a filter holding them is compiled, every
   * related table (and junction) is loaded ONCE for that operation — through
   * its own adapter's snapshot seam, so a provider-backed related table works
   * too — and each predicate becomes a set of matching correlation keys
   * (see {@link _relationSets}). Predicate-free filters take the plain path.
   *
   * @since 0.1.147
   */
  override supportsRelationFilters(_mode: "read" | "write"): boolean {
    return true;
  }

  // ── ID handling ────────────────────────────────────────────────────────────

  /**
   * Coerces a by-id value to the id field's declared leaf type. The framework
   * calls `adapter.prepareId(value, fieldType)` when building by-id filters, so a
   * URL id like `"21"` reaches this adapter as the STRING `"21"`. Memory does
   * STRICT JS comparison like the Mongo adapter, so the strict `$eq` would then
   * compare `"21" === 21` against a numeric PK and never match — every
   * fetch/patch/delete/replace-by-id of a numeric-PK row would 404. Coercing the
   * id to the field type here fixes that. SQL adapters can rely on the DB to
   * coerce the bound parameter; memory cannot, so it MUST coerce here.
   *
   * Mirrors the Mongo adapter's `prepareId` MINUS its `objectId` branch (an
   * in-memory store has no ObjectId ids): a leaf `designType` of `"number"`
   * coerces via `Number(id)`, everything else via `String(id)`.
   */
  override prepareId(id: unknown, _fieldType: unknown): unknown {
    const fieldType = _fieldType as TAtscriptAnnotatedType;
    if (fieldType.type.kind === "") {
      const dt = (fieldType.type as any).designType;
      if (dt === "number") {
        return Number(id);
      }
    }
    return String(id);
  }

  // ── Storage helpers ────────────────────────────────────────────────────────

  /** Joins the space's in-memory database (see {@link databases}), creating it on first use. */
  override registerSpace(space: DbSpace): void {
    let db = databases.get(space);
    if (!db) {
      db = new Map();
      databases.set(space, db);
    }
    this._db = db;
  }

  /**
   * This table's state, or `undefined` while it does not exist (never synced,
   * or dropped) — or when no readable is registered.
   */
  private _peekState(): MemoryTableState | undefined {
    const table = this._table as typeof this._table | undefined;
    return table && this._db.get(table.tableName);
  }

  /**
   * This table's state, created on first use — by `ensureTable`, or by a write
   * to a table that was never synced (implicit create, like a MongoDB
   * collection). Reads never create it.
   */
  private _state(): MemoryTableState {
    const db = this._db;
    const name = this._table.tableName;
    let state = db.get(name);
    if (!state) {
      state = {
        kind: this._table.isView ? "view" : "table",
        rows: new Map(),
        uniqueIndexes: [],
        opaquePk: false,
        incrementCounters: new Map(),
      };
      db.set(name, state);
    }
    return state;
  }

  /**
   * Physical names of the primary-key field(s). Single `@meta.id` resolves via
   * {@link AtscriptDbReadable.metaIdPhysical}; a composite key maps each logical
   * PK path through `physicalPath` (`@db.column` renames included). Memoized
   * because it is stable per adapter (1:1 with a fixed table) yet read on every
   * `pkKey`/projection — recomputing would re-read `this._table.*` and re-allocate.
   */
  private _physicalPkFields(): string[] {
    if (this._pkFieldsCache) {
      return this._pkFieldsCache;
    }
    const metaIdPhysical = this._table.metaIdPhysical;
    const fields = metaIdPhysical
      ? [metaIdPhysical]
      : this._table.primaryKeys.map((pk) => this._table.physicalPath(pk));
    this._pkFieldsCache = fields;
    return fields;
  }

  /** Compiled readers of {@link _physicalPkFields} (memoized like it). */
  private _pkReaders(): Array<(row: TRow) => unknown> {
    return (this._pkReadersCache ??= this._physicalPkFields().map((field) => pathReader(field)));
  }

  /**
   * PHYSICAL field name → optional `start` for every `@db.default.increment`
   * field. Discovered lazily from the table's field descriptors — each carries
   * both `physicalName` (the key the stored row uses) and `defaultValue`
   * (sourced from `this._table.defaults`), so this resolves column renames
   * correctly where iterating the logical-keyed `defaults` map would not.
   * Memoized because it is stable per adapter (1:1 with a fixed table), like
   * {@link _physicalPkFields}. An empty map ⇒ the insert fast-path skips all
   * increment work.
   *
   * Mirrors the Mongo adapter's `_incrementFields`
   * (`mongo-adapter.ts` — populated in `onFieldScanned`, keyed by physical
   * name): core NEVER generates `increment` values (its `_applyDefaults`
   * switch has no `increment` case, so the field reaches the adapter absent),
   * whether or not the adapter claims it via `nativeDefaultFns()`. The adapter
   * MUST fill it in. Mongo does not override `nativeDefaultFns()` /
   * `supportsNativeValueDefaults()` for increment, so neither does this adapter.
   */
  private _incrementFields(): Map<string, number | undefined> {
    if (this._incrementFieldsCache) {
      return this._incrementFieldsCache;
    }
    const fields = new Map<string, number | undefined>();
    for (const fd of this._table.fieldDescriptors) {
      const def = fd.defaultValue;
      if (def?.kind === "fn" && def.fn === "increment") {
        fields.set(fd.physicalName, def.start);
      }
    }
    this._incrementFieldsCache = fields;
    return fields;
  }

  /**
   * Assigns `@db.default.increment` values onto `row` (PHYSICAL shape) IN
   * PLACE — called from {@link _insertRow} BEFORE `pkKey`/uniqueness/inserted-id
   * are computed so an increment PRIMARY KEY produces a real `insertedId` and
   * stores under a real key. The memory analogue of the Mongo adapter's
   * insert-time increment (Mongo uses an atomic `__atscript_counters`
   * collection; an in-memory store keeps the counter in the table's state, so
   * it restarts with a fresh space or when the table is dropped — parity with
   * SQLite `:memory:`; never persisted):
   *
   * - No value for the field → assign the next counter value. First use starts
   *   at `start ?? 1` (`max(counter, (start ?? 1) - 1) + 1`); thereafter it is
   *   the previous value + 1. Sequential across an `insertMany` batch because
   *   {@link _insertRow} runs per item in `insertedIds` order against the shared
   *   counter.
   * - Explicit value present → keep it, but advance the counter to
   *   `max(counter, value)` so a later auto value can never collide with it.
   */
  private _applyIncrements(counters: Map<string, number>, row: Record<string, unknown>): void {
    const fields = this._incrementFields();
    if (fields.size === 0) {
      return;
    }
    for (const [physical, start] of fields) {
      // `base` already defaults to `floor` when the counter is unset, and every
      // counter write below keeps it >= floor, so `base >= floor` is invariant —
      // the next auto value is simply `base + 1` (no `Math.max(base, floor)`).
      const floor = (start ?? 1) - 1;
      const base = counters.get(physical) ?? floor;
      const current = row[physical];
      if (current === undefined || current === null) {
        const next = base + 1;
        row[physical] = next;
        counters.set(physical, next);
      } else if (typeof current === "number") {
        // Explicit id: don't overwrite, but never let a future auto value reuse it.
        counters.set(physical, Math.max(base, current));
      }
    }
  }

  /**
   * Builds the duplicate-primary-key {@link DbError}. The reported `path` is the
   * physical `@meta.id` name, falling back to the first (logical) primary key,
   * then `""`. Centralized so the insert and re-key paths raise an identical
   * CONFLICT.
   */
  private _pkConflict(): DbError {
    const path = this._table.metaIdPhysical ?? this._table.primaryKeys[0] ?? "";
    return new DbError("CONFLICT", [{ path, message: "Duplicate primary key" }]);
  }

  /**
   * Derives the storage key from a row's PRIMARY KEY value(s), read by PHYSICAL
   * name. Encoded as `JSON.stringify` of the ordered PK values so it is
   * collision-proof across both value shapes and types — `['a','b:c']` and
   * `['a:b','c']` differ, and `1` differs from `'1'`.
   */
  private pkKey(row: Record<string, unknown>): string {
    const readers = this._pkReaders();
    return JSON.stringify(readers.length === 1 ? [readers[0]!(row)] : readers.map((r) => r(row)));
  }

  /**
   * The storage key a filter pins by exact equality on EVERY primary-key field
   * — `{ id: v }`, `{ id: { $eq: v } }`, also inside (nested) `$and` — or
   * `undefined`. Only a string / number / boolean / `Date` value pins: for
   * those, a row the filter matches is stored exactly under this key (strict
   * equality ⇒ equal `JSON.stringify`), so a read can look the row up and
   * still run the full predicate on it. Unavailable once the table holds an
   * {@link MemoryTableState.opaquePk opaque} key.
   */
  private _pinnedKey(state: MemoryTableState, filter: FilterExpr): string | undefined {
    if (state.opaquePk) {
      return undefined;
    }
    const fields = this._physicalPkFields();
    const pinned = new Map<string, unknown>();
    collectPins(filter, fields, pinned);
    if (pinned.size !== fields.length) {
      return undefined;
    }
    return JSON.stringify(fields.map((field) => pinned.get(field)));
  }

  /**
   * Builds a DEFINED inserted-id for a table with NO single `@meta.id` — a
   * composite (or single non-meta) primary key, where
   * {@link BaseDbAdapter._resolveInsertedId} would otherwise fall back to
   * `undefined` (memory has no rowid/`_id` to hand back). Returns an object
   * mapping each PRIMARY KEY PHYSICAL field name → its value in the stored row
   * (e.g. `{ part1: "a", part2: "b" }`), read by physical name via
   * {@link getPath} so it matches how {@link pkKey} derives the storage key and
   * honours column renames. A single-field non-meta PK yields the one-key object
   * form for consistency (documented shape).
   *
   * Passed as the `dbGeneratedId` fallback in {@link _insertRow} ONLY when
   * {@link AtscriptDbReadable.metaIdPhysical} is null; single-`@meta.id` tables
   * keep an `undefined` fallback, so their scalar `insertedId`
   * (`row[metaIdPhysical]`) is byte-identical to before.
   */
  private _compositeInsertedId(row: Record<string, unknown>): Record<string, unknown> {
    const id: Record<string, unknown> = {};
    for (const field of this._physicalPkFields()) {
      id[field] = getPath(row, field);
    }
    return id;
  }

  // ── Provider (read-through) mode ─────────────────────────────────────────

  /**
   * Switches this adapter into PROVIDER-BACKED mode: `fn` is invoked on every
   * read to recompute the table's rows (e.g. a Redis/job-manager snapshot), so a
   * runtime-owned entity with NO database can be observed as a read-only
   * atscript table (and still carry `@DbAction`s). Rows are recomputed per read
   * (no caching); once set, the table is READ-ONLY — all writes throw (see
   * {@link _assertWritable}).
   *
   * Late-binding by design: set AFTER construction only, never via the
   * constructor — see the {@link _provider} field comment for why a constructor
   * option would leak onto the shared control-table adapter and break sync.
   */
  setProvider(fn: MemoryProviderFn): void {
    this._provider = fn;
  }

  /**
   * Write guard for provider-backed (read-only) mode. Called first in every one
   * of the 8 write methods so all mutation entry points reject identically. Uses
   * `INVALID_QUERY` (moost-db's validation interceptor maps it to HTTP 400, NOT
   * 500) since there is no dedicated read-only error code.
   */
  private _assertWritable(): void {
    if (this._provider) {
      throw new DbError("INVALID_QUERY", [
        {
          path: "",
          message: `Table "${this._table.tableName}" is provider-backed (read-only); writes are not supported`,
        },
      ]);
    }
  }

  /**
   * Snapshot seam for reads. Returns the current rows.
   *
   * - Stored mode reads the table's Map directly (insertion order preserved);
   *   a table that does not exist reads as empty.
   * - Provider (read-through) mode calls {@link _provider} to recompute a fresh
   *   snapshot per read.
   *
   * Does NOT clone — cloning happens only on OUTPUT (see {@link _projectAndClone})
   * so the store stays authoritative and cheap. That same clone-on-output path
   * ALSO covers provider rows: every value handed back to a caller is a
   * `structuredClone`, so a provider that returns objects it still holds is
   * protected from mutation by `reconstructFromRead`/callers.
   *
   * A single logical read invokes the provider EXACTLY ONCE: `findMany`
   * delegates to `findManyWithCount` (one `_filteredRows` ⇒ one `_loadRows`),
   * and `findOne`/`count` each call `_filteredRows` once — so recompute-per-read
   * AND single-snapshot-per-`findManyWithCount` both fall out for free.
   */
  protected _loadRows(): Record<string, unknown>[] | Promise<Record<string, unknown>[]> {
    if (this._provider) {
      return this._provider();
    }
    return [...(this._peekState()?.rows.values() ?? [])];
  }

  /**
   * A per-operation row loader for relational predicates: each related table
   * is snapshotted at most once per operation (the first predicate that needs
   * it loads it; later ones — and nested ones — reuse that snapshot), so a
   * provider-backed related table is invoked once per read. `own` seeds this
   * table's snapshot so a self relation reads the same rows as the outer scan.
   */
  private _snapshotLoader(own?: Promise<Record<string, unknown>[]>): MemoryRowLoader {
    const snapshots = new Map<BaseDbAdapter, Promise<Record<string, unknown>[]>>();
    if (own) {
      snapshots.set(this, own);
    }
    return (adapter) => {
      let rows = snapshots.get(adapter);
      if (!rows) {
        if (!(adapter instanceof MemoryAdapter)) {
          throw new DbError("REL_FILTER_NOT_SUPPORTED", [
            {
              path: "",
              message:
                "Relational predicate: the related table is not served by the memory adapter",
            },
          ]);
        }
        rows = Promise.resolve(adapter._loadRows());
        snapshots.set(adapter, rows);
      }
      return rows;
    };
  }

  /**
   * The prepared correlation sets for `filter`'s relational predicates.
   * Callers only await it when `containsRelationFilter(filter)` — a
   * predicate-free filter keeps its fully synchronous path. Write methods call
   * it BEFORE reading the table state, so the related tables (a self relation
   * included) are snapshotted before any row changes, like SQL.
   */
  private async _relationSets(
    filter: FilterExpr,
    own?: Promise<Record<string, unknown>[]>,
  ): Promise<RelationSets | undefined> {
    return prepareRelationSets(filter, this._snapshotLoader(own));
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /**
   * Clones the payload in, applies the version default, generates any
   * `@db.default.increment` values, enforces PK + unique constraints, stores
   * the row, and returns the resolved inserted id. Clone-in ({@link cloneValue},
   * `structuredClone`-equivalent) is what makes post-insert mutation of the
   * caller's object never leak into
   * the store. Called once per item by both `insertOne` and `insertMany`, so
   * increment values advance sequentially across a batch.
   */
  private _insertRow(state: MemoryTableState, data: Record<string, unknown>): unknown {
    const row = cloneValue(data);

    // Memory has no DDL DEFAULT; fill version=0 at insert when missing so OCC
    // stays consistent with the SQL/Mongo adapters.
    const versionColumn = this._table.versionColumnPhysical;
    if (versionColumn !== undefined && !(versionColumn in row)) {
      row[versionColumn] = 0;
    }

    // Memory has no DB sequence; the adapter generates @db.default.increment
    // values here — BEFORE pkKey, so an increment PK yields a real inserted id
    // (parity with SQL autoincrement / the Mongo counter-collection).
    this._applyIncrements(state.incrementCounters, row);

    const key = this.pkKey(row);
    if (state.rows.has(key)) {
      throw this._pkConflict();
    }

    const tuples = this._enforceUniqueIndexes(state, row);
    this._storeRow(state, key, row, tuples);
    // Single-`@meta.id` tables resolve their scalar id from `row[metaIdPhysical]`
    // and keep an `undefined` fallback (unchanged). A composite (or single
    // non-meta) PK has no single meta id, so supply a DEFINED fallback built from
    // the PK field values instead of `undefined`, which callers (e.g.
    // `POST /db/<table>`) need as a usable `insertedId`.
    const fallback = this._table.metaIdPhysical ? undefined : this._compositeInsertedId(row);
    return this._resolveInsertedId(row, fallback);
  }

  /**
   * Enforces every recorded unique index against the current store. A row is
   * exempted from an index (present-only semantics) when ANY of that index's
   * optional fields is absent/`null`. Otherwise a stored row with an equal
   * tuple → `CONFLICT`. Returns the row's tuple key per index (for
   * {@link _storeRow}).
   *
   * `excludeKey` (when given) skips the row stored under that {@link pkKey} — so
   * a row updating its own unique value does not false-conflict with itself.
   */
  private _enforceUniqueIndexes(
    state: MemoryTableState,
    row: Record<string, unknown>,
    excludeKey?: string,
  ): Array<string | undefined> {
    return state.uniqueIndexes.map((index) => {
      const tuple = uniqueTupleKey(index, row);
      if (tuple !== undefined && tupleTaken(index, tuple, excludeKey)) {
        throw new DbError("CONFLICT", [
          {
            path: index.fields[0] ?? index.name,
            message: `Duplicate value for unique index "${index.name}"`,
          },
        ]);
      }
      return tuple;
    });
  }

  /**
   * Stores `row` under `key` and records it in the unique indexes (`tuples`:
   * its precomputed tuple keys). The ONLY way a row enters the store, so the
   * indexes and {@link MemoryTableState.opaquePk} never drift from it.
   */
  private _storeRow(
    state: MemoryTableState,
    key: string,
    row: Record<string, unknown>,
    tuples?: ReadonlyArray<string | undefined>,
  ): void {
    state.rows.set(key, row);
    indexRow(state.uniqueIndexes, key, row, tuples);
    if (!state.opaquePk) {
      for (const read of this._pkReaders()) {
        const value = read(row);
        if (value !== null && typeof value === "object" && !(value instanceof Date)) {
          state.opaquePk = true;
        }
      }
    }
  }

  /** Removes the row stored under `key` (and its unique-index entries). */
  private _removeRow(state: MemoryTableState, key: string, row: Record<string, unknown>): void {
    state.rows.delete(key);
    unindexRow(state.uniqueIndexes, key, row);
  }

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    this._assertWritable();
    return { insertedId: this._insertRow(this._state(), data) };
  }

  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    this._assertWritable();
    // Ordered, non-atomic (v1 limitation): a collision throws after the prior
    // items are already stored. The table layer routes `insertOne` through
    // `insertMany([one])` and the sync lock relies on a duplicate-PK insert
    // throwing, so a single-element collision MUST throw — which it does.
    const state = this._state();
    const insertedIds = data.map((item) => this._insertRow(state, item));
    return { insertedCount: data.length, insertedIds };
  }

  override supportsInsertIgnore(): boolean {
    return true;
  }

  /** A row colliding on the primary key or a unique index (`CONFLICT`) becomes a skipped slot. */
  override async insertManyIgnore(
    data: Array<Record<string, unknown>>,
  ): Promise<TDbInsertIgnoreSlot[]> {
    this._assertWritable();
    const state = this._state();
    return data.map((item) => {
      try {
        return { insertedId: this._insertRow(state, item) };
      } catch (error) {
        if (isConflict(error)) return null;
        throw error;
      }
    });
  }

  // ── Write helpers ─────────────────────────────────────────────────────────

  /**
   * Selects the stored rows a write should touch, as `{ key, row }` pairs so
   * callers can mutate in place and re-key. Stored mode scans the table's Map
   * directly (writes are authoritative against the store, unlike reads which go
   * through the {@link _loadRows} snapshot seam).
   *
   * A defined `expectedVersion` layers an OCC (compare-and-set) predicate on top
   * of `filter`: a row matches only when `row[versionColumn] === expectedVersion`.
   * A version MISMATCH is NOT an error — it simply yields zero matches, so the
   * caller reports `matchedCount: 0`. Supplying `expectedVersion` for a table
   * that has no version column is a misconfiguration and throws (mirrors the
   * Mongo adapter's `_buildCasFilter`).
   *
   * When `many` is `false` at most the first match is returned. A table that
   * does not exist (`state` undefined) matches nothing and is not created.
   *
   * A filter with relational predicates needs `relationSets`, prepared by the
   * caller BEFORE it reads `state` (see {@link _relationSets}).
   */
  private _selectForWrite(
    state: MemoryTableState | undefined,
    filter: FilterExpr,
    expectedVersion: number | undefined,
    many: boolean,
    relationSets?: RelationSets,
  ): Array<{ key: string; row: Record<string, unknown> }> {
    const versionColumn = this._table.versionColumnPhysical;
    if (expectedVersion !== undefined && versionColumn === undefined) {
      throw new Error("expectedVersion requires a versioned table");
    }
    const match = buildMemoryPredicate(filter, relationSets);
    const matched: Array<{ key: string; row: Record<string, unknown> }> = [];
    if (!state) {
      return matched;
    }
    // A filter pinning the whole primary key can match only the row stored under it.
    const pinned = this._pinnedKey(state, filter);
    let candidates: Iterable<[string, Record<string, unknown>]> = state.rows;
    if (pinned !== undefined) {
      const row = state.rows.get(pinned);
      candidates = row ? [[pinned, row]] : [];
    }
    for (const [key, row] of candidates) {
      if (!match(row)) {
        continue;
      }
      // OCC: `versionColumn` is guaranteed defined whenever `expectedVersion` is
      // (the guard above throws otherwise), so the `!` is safe.
      if (expectedVersion !== undefined && row[versionColumn!] !== expectedVersion) {
        continue;
      }
      matched.push({ key, row });
      if (!many) {
        break;
      }
    }
    return matched;
  }

  /**
   * Sets `target`'s version column to `oldRow`'s version + 1, coercing a missing
   * old version to `0`. No-op on an unversioned table. The OLD version is read
   * from a pristine `oldRow` (not `target`) so the result is always
   * `oldVersion + 1` regardless of what a patch/replace payload wrote onto
   * `target`'s version column — the memory analogue of Mongo forcing
   * `$inc: { version: 1 }` last. Shared by {@link _commitUpdate} (merge path) and
   * {@link replaceOne} (full-replace path).
   */
  private _bumpVersion(target: Record<string, unknown>, oldRow: Record<string, unknown>): void {
    const versionColumn = this._table.versionColumnPhysical;
    if (versionColumn !== undefined) {
      target[versionColumn] = ((oldRow[versionColumn] as number | undefined) ?? 0) + 1;
    }
  }

  /**
   * Applies a merge-style update to `row` IN PLACE — the memory analogue of
   * `buildMongoUpdateDoc`:
   *
   * - `$set` (`data`): each key is set onto the row via {@link setPath}. Keys are
   *   DOT-PATHS (the table layer decomposes nested patches into `"profile.city"`
   *   because this adapter reports no {@link supportsNativePatch}), so they must
   *   nest into the stored document — MERGING siblings — exactly like Mongo's
   *   `$set: { "profile.city": v }`, not create a literal dotted key. Top-level
   *   (dot-free) keys behave as a plain assignment. `data` is deep-cloned
   *   first so nested subtrees from the caller never alias into the store.
   * - `ops.inc` / `ops.mul`: numeric increment / multiply on the (dot-path)
   *   target, coercing a missing or non-numeric current value to `0` (parity with
   *   Mongo's `$inc`/`$mul`).
   *
   * Does NOT bump the version column — {@link _commitUpdate} does that LAST via
   * {@link _bumpVersion} (after this merge, reading the pristine old row), so the
   * bump always wins over whatever `data`/`inc` wrote and lands on `oldVersion + 1`.
   */
  private _applyUpdate(
    row: Record<string, unknown>,
    data: Record<string, unknown>,
    ops?: TFieldOps,
  ): void {
    const patch = cloneValue(data);
    for (const k of Object.keys(patch)) {
      setPath(row, k, patch[k]);
    }

    if (ops?.inc) {
      for (const [col, n] of Object.entries(ops.inc)) {
        setPath(row, col, (Number(getPath(row, col)) || 0) + n);
      }
    }
    if (ops?.mul) {
      for (const [col, n] of Object.entries(ops.mul)) {
        setPath(row, col, (Number(getPath(row, col)) || 0) * n);
      }
    }
  }

  /**
   * Places `next` into the store under its (possibly changed) {@link pkKey} in
   * place of `oldRow` (stored under `oldKey`), re-keying when a mutation/replace
   * moved the primary key. A collision on the NEW key (some other row already
   * owns it) throws `CONFLICT`. Throws BEFORE touching the Map so a failed
   * re-key leaves the store unchanged. `tuples` are `next`'s unique-index keys.
   */
  // oxlint-disable-next-line max-params
  private _commitRow(
    state: MemoryTableState,
    oldKey: string,
    oldRow: Record<string, unknown>,
    next: Record<string, unknown>,
    tuples: ReadonlyArray<string | undefined>,
  ): void {
    const newKey = this.pkKey(next);
    if (newKey !== oldKey && state.rows.has(newKey)) {
      throw this._pkConflict();
    }
    unindexRow(state.uniqueIndexes, oldKey, oldRow);
    if (newKey !== oldKey) {
      state.rows.delete(oldKey);
    }
    // Same key → `Map.set` replaces in place, keeping the row's position.
    this._storeRow(state, newKey, next, tuples);
  }

  /**
   * Update-then-commit for a single matched row: clones the pristine `row`,
   * applies the merge update, bumps the version LAST (read from the pristine old
   * `row`), enforces unique indexes on the result EXCLUDING the row's own key (so
   * a row keeping/rewriting its own unique value never self-conflicts), then
   * commits. Nothing is written to the store until both the unique and PK checks
   * pass, so a conflict leaves the store untouched. `keepVersion` skips the
   * bump (a version-exempt patch, since 0.1.150).
   */
  // oxlint-disable-next-line max-params
  private _commitUpdate(
    state: MemoryTableState,
    oldKey: string,
    row: Record<string, unknown>,
    data: Record<string, unknown>,
    ops?: TFieldOps,
    keepVersion = false,
  ): void {
    const next = cloneValue(row);
    this._applyUpdate(next, data, ops);
    if (!keepVersion) this._bumpVersion(next, row);
    const tuples = this._enforceUniqueIndexes(state, next, oldKey);
    this._commitRow(state, oldKey, row, next, tuples);
  }

  async replaceOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<TDbUpdateResult> {
    this._assertWritable();
    const sets = containsRelationFilter(filter) ? await this._relationSets(filter) : undefined;
    const state = this._peekState();
    const matched = this._selectForWrite(state, filter, expectedVersion, false, sets);
    if (!state || matched.length === 0) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const { key, row } = matched[0]!;

    // FULL replace: `next` is the payload verbatim, so every field absent from
    // `data` is dropped — only the version is derived, bumped from the old row's
    // value (mirrors Mongo's `$replaceWith` with `version: $version + 1`).
    const next = cloneValue(data);
    this._bumpVersion(next, row);

    const tuples = this._enforceUniqueIndexes(state, next, key);
    this._commitRow(state, key, row, next, tuples);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  // oxlint-disable-next-line max-params
  async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
    expectedVersion?: number,
    opts?: TDbUpdateOptions,
  ): Promise<TDbUpdateResult> {
    const keepVersion = this._versionColumnFor(opts, expectedVersion) === undefined;
    this._assertWritable();
    const sets = containsRelationFilter(filter) ? await this._relationSets(filter) : undefined;
    const state = this._peekState();
    const matched = this._selectForWrite(state, filter, expectedVersion, false, sets);
    if (!state || matched.length === 0) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const { key, row } = matched[0]!;
    this._commitUpdate(state, key, row, data, ops, keepVersion);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    this._assertWritable();
    const sets = containsRelationFilter(filter) ? await this._relationSets(filter) : undefined;
    const state = this._peekState();
    const matched = this._selectForWrite(state, filter, undefined, false, sets);
    if (!state || matched.length === 0) {
      return { deletedCount: 0 };
    }
    this._removeRow(state, matched[0]!.key, matched[0]!.row);
    return { deletedCount: 1 };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * Stable multi-key comparator from `$sort`, with a final tie-break on
   * {@link pkKey} for a deterministic total order. Returns the input unchanged
   * (insertion order) when there is no `$sort`. Delegates to the shared pure
   * {@link sortRows}, injecting {@link pkKey} as the total-order tie-break;
   * `topK` asks for the head of that order only (`$skip + $limit`).
   */
  private _sortRows(
    rows: Record<string, unknown>[],
    $sort?: Partial<Record<string, 1 | -1>>,
    topK?: number,
  ): Record<string, unknown>[] {
    return sortRows(rows, $sort, (r) => this.pkKey(r), topK);
  }

  /**
   * Compiles the `$select` projection of one read: each returned row is a
   * fresh, deep-cloned object so the store can never be mutated through it.
   *
   * - No projection → a full clone.
   * - INCLUSION form (`{ field: 1 }`) → a new object with exactly the selected
   *   paths — like the SQL adapters (since 0.1.145; it used to add the primary
   *   key, which made projected responses differ across adapters).
   * - EXCLUSION form (`{ field: 0 }`) → a clone with those paths removed.
   *
   * Top-level and nested dot-paths are supported; exotic Mongo projection
   * quirks (array positional, `$slice`, etc.) are intentionally NOT replicated.
   */
  private _projector(
    $select?: UniquSelect,
  ): (row: Record<string, unknown>) => Record<string, unknown> {
    return compileProjection($select?.asProjection, { clone: true });
  }

  /**
   * Reads the pagination/sort/projection controls with their intended types.
   * `DbControls` carries a `[key: `$${string}`]: unknown` index signature, and
   * `Omit`-ing `$select` from `UniqueryControls` widens `$sort`/`$skip`/`$limit`
   * back to `unknown` — so the casts here restore the declared shapes at a
   * single, documented boundary. `$select` keeps its explicit `UniquSelect` type.
   */
  private _readControls(controls: DbControls): {
    $sort?: Partial<Record<string, 1 | -1>>;
    $skip?: number;
    $limit?: number;
    $select?: UniquSelect;
  } {
    return {
      $sort: controls.$sort as Partial<Record<string, 1 | -1>> | undefined,
      $skip: controls.$skip as number | undefined,
      $limit: controls.$limit as number | undefined,
      $select: controls.$select,
    };
  }

  /**
   * The single "load a snapshot, apply the filter predicate" step every read
   * shares. Goes through the {@link _loadRows} seam exactly ONCE per call, so a
   * reader (and provider read-through mode) has one place that materializes the
   * working set — one provider invocation per logical read.
   *
   * Stored mode reads the table's Map in place (no snapshot copy), resolves a
   * filter pinning the whole primary key by direct lookup, and stops after
   * `limit` matches when given (an unsorted `findOne`).
   */
  private async _filteredRows(query: DbQuery, limit?: number): Promise<Record<string, unknown>[]> {
    if (!containsRelationFilter(query.filter)) {
      const match = buildMemoryPredicate(query.filter);
      if (!this._provider && this._loadRows === MemoryAdapter.prototype._loadRows) {
        const state = this._peekState();
        if (!state) {
          return [];
        }
        const pinned = this._pinnedKey(state, query.filter);
        if (pinned !== undefined) {
          const row = state.rows.get(pinned);
          return row && match(row) ? [row] : [];
        }
        return collectMatches(state.rows.values(), match, limit);
      }
      return collectMatches(await this._loadRows(), match, limit);
    }
    // Relational predicates: this table's snapshot is taken first and shared
    // with the predicates (a self relation reads the same rows).
    const own = Promise.resolve(this._loadRows());
    // `own` is awaited only after the related tables load: mark it handled
    // now so a rejection meanwhile is not an unhandled rejection (it still
    // propagates — through the predicates that share it, or the await below).
    own.catch(() => {});
    const sets = await this._relationSets(query.filter, own);
    return (await own).filter(buildMemoryPredicate(query.filter, sets));
  }

  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    const { $sort, $skip, $select } = this._readControls(query.controls ?? {});
    const index = $skip ?? 0;
    const sorted = hasSort($sort)
      ? this._sortRows(await this._filteredRows(query), $sort, index + 1)
      : await this._filteredRows(query, index + 1);
    const row = sorted[index];
    return row ? this._projector($select)(row) : null;
  }

  async findMany(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    // Same single-snapshot pipeline as findManyWithCount; the O(1) count it also
    // computes is discarded. One implementation so the two can never drift.
    return (await this.findManyWithCount(query)).data;
  }

  async count(query: DbQuery): Promise<number> {
    return (await this._filteredRows(query)).length;
  }

  /**
   * Overridden so the filtered snapshot is computed ONCE — the base default
   * runs `findMany` and `count` separately (two `_loadRows` snapshots). A
   * single snapshot is both cheaper here and the correct semantics for
   * provider (read-through) mode, where two separate reads could otherwise
   * observe different snapshots and make count/data disagree.
   */
  override async findManyWithCount(
    query: DbQuery,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    const filtered = await this._filteredRows(query);
    const { $sort, $skip, $limit, $select } = this._readControls(query.controls ?? {});
    const topK = $limit === undefined ? undefined : ($skip ?? 0) + $limit;
    const sorted = this._sortRows(filtered, $sort, topK);
    const paged = paginate(sorted, $skip, $limit);
    const data = paged.map(this._projector($select));
    return { data, count: filtered.length };
  }

  /**
   * Grouped query (`$groupBy` + aggregates, calendar buckets, `$having`,
   * `$sort`, `$skip` / `$limit`, `$count`) over ONE filtered snapshot — the
   * pure {@link aggregateRows} engine, so provider (read-through) mode works
   * unchanged. SQL-adapter semantics: null and missing group together,
   * `sum` / `avg` over no numeric value are `null`, `$count` counts the groups
   * that survive `$having`.
   *
   * `$search` never reaches here: this adapter is not searchable, so the core
   * rejects a grouped search before dispatch.
   */
  override async aggregate(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    return aggregateRows(await this._filteredRows(query), query.controls ?? {});
  }

  /**
   * Every calendar-bucket unit: labels come from the `@uniqu/core` kernel
   * (Node's ICU zone data — the list the core validates zones against, so
   * there is no zone this adapter cannot resolve).
   */
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

  /** Managed views render nothing (non-goal) — both are accepted like `aggregateFns()`. */
  override viewCapabilities(): ReadonlySet<TViewCapability> {
    return ALL_VIEW_CAPABILITIES;
  }

  // ── Batch operations ──────────────────────────────────────────────────────

  async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
    opts?: TDbUpdateOptions,
  ): Promise<TDbUpdateResult> {
    this._assertWritable();
    const sets = containsRelationFilter(filter) ? await this._relationSets(filter) : undefined;
    // updateMany never CAS-checks (locked decision row 2) — `expectedVersion` is
    // never passed. Each matched row still auto-bumps its own version (unless
    // `opts.keepVersion` — a version-exempt patch). Applied
    // sequentially and NON-atomically (a mid-loop unique/PK conflict leaves the
    // earlier rows already updated), matching `insertMany`'s v1 contract.
    const state = this._peekState();
    if (!state) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const matched = this._selectForWrite(state, filter, undefined, true, sets);
    for (const { key, row } of matched) {
      this._commitUpdate(state, key, row, data, ops, opts?.keepVersion);
    }
    return { matchedCount: matched.length, modifiedCount: matched.length };
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    this._assertWritable();
    const sets = containsRelationFilter(filter) ? await this._relationSets(filter) : undefined;
    // Mirrors Mongo: there is no native `replaceMany`, so this is a `$set` MERGE
    // + version bump on every match (via `_applyUpdate`), NOT a full-document
    // replace like `replaceOne`. Fields absent from `data` are RETAINED on each
    // matched row. Sequential + non-atomic, sibling of `updateMany`, no CAS.
    const state = this._peekState();
    if (!state) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const matched = this._selectForWrite(state, filter, undefined, true, sets);
    for (const { key, row } of matched) {
      this._commitUpdate(state, key, row, data);
    }
    return { matchedCount: matched.length, modifiedCount: matched.length };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    this._assertWritable();
    const sets = containsRelationFilter(filter) ? await this._relationSets(filter) : undefined;
    const state = this._peekState();
    if (!state) {
      return { deletedCount: 0 };
    }
    const matched = this._selectForWrite(state, filter, undefined, true, sets);
    for (const { key, row } of matched) {
      this._removeRow(state, key, row);
    }
    return { deletedCount: matched.length };
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  /**
   * Records the model's `unique` indexes for insert-time enforcement. Idempotent
   * (replaces the recorded set). Non-unique index types are ignored — an
   * in-memory scan needs no plain/fulltext/geo index to answer queries.
   */
  async syncIndexes(): Promise<void> {
    const uniqueIndexes: RecordedUniqueIndex[] = [];
    for (const index of this._table.indexes.values()) {
      if (index.type !== "unique") {
        continue;
      }
      uniqueIndexes.push(
        recordUniqueIndex(
          index.name,
          index.fields.map((f) => f.name),
          new Set(index.fields.filter((f) => f.optional).map((f) => f.name)),
        ),
      );
    }
    const state = this._state();
    state.uniqueIndexes = uniqueIndexes;
    for (const [key, row] of state.rows) {
      indexRow(uniqueIndexes, key, row);
    }
  }

  /** Creates the table's (empty) state when it does not exist. Idempotent. */
  async ensureTable(): Promise<void> {
    this._state();
  }

  /**
   * Whether the table exists in the space's in-memory database — created by
   * {@link ensureTable} (or a first write) and not dropped since. Schema sync
   * reports a table that does not exist as `create`. An external view always
   * exists: nothing in memory creates one, its rows come from a provider.
   * @since 0.1.137
   */
  async tableExists(): Promise<boolean> {
    if (isAtscriptDbView(this._table) && this._table.isExternal) {
      return true;
    }
    return this._peekState() !== undefined;
  }

  /**
   * Kind of the object stored under `name` in the space's in-memory database,
   * or `undefined` when nothing is. Lets schema sync refuse a table declared
   * where a view exists (and the reverse) and an FK to a table that is missing.
   * @since 0.1.138
   */
  async getObjectKind(name: string): Promise<TDbObjectKind | undefined> {
    return this._db.get(name)?.kind;
  }

  /**
   * Drops a table by name: its rows, unique indexes and increment counters go,
   * so the table added back starts empty. A missing table is not an error;
   * a view under that name is (`dropViewByName` drops views).
   * @since 0.1.137
   */
  async dropTableByName(tableName: string): Promise<void> {
    this._dropByName(tableName, "table");
  }

  /**
   * Drops a view by name — its (empty) state; a view holds no rows here.
   * A missing view is not an error; a table under that name is.
   * @since 0.1.137
   */
  async dropViewByName(viewName: string): Promise<void> {
    this._dropByName(viewName, "view");
  }

  private _dropByName(name: string, kind: MemoryTableState["kind"]): void {
    const state = this._db.get(name);
    if (state && state.kind !== kind) {
      throw new Error(`Cannot drop ${kind} "${name}": it is a ${state.kind}`);
    }
    this._db.delete(name);
  }
}

/** Whether a `$sort` control orders by at least one key. */
function hasSort($sort: Partial<Record<string, 1 | -1>> | undefined): boolean {
  return $sort !== undefined && Object.keys($sort).length > 0;
}

/** The rows of `rows` matching `match`, in order — at most `limit` when given. */
function collectMatches(
  rows: Iterable<Record<string, unknown>>,
  match: (row: Record<string, unknown>) => boolean,
  limit?: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (limit !== undefined && limit <= 0) {
    return out;
  }
  for (const row of rows) {
    if (match(row)) {
      out.push(row);
      if (out.length === limit) {
        break;
      }
    }
  }
  return out;
}

/**
 * Collects into `pinned` the primary-key fields `filter` pins by exact equality
 * on a string / number / boolean / `Date` value — at its top level and inside
 * (nested) `$and`s, which `walkFilter` conjoins the same way. The first pin of
 * a field wins: a contradicting second one is still checked by the predicate.
 */
function collectPins(
  filter: unknown,
  fields: readonly string[],
  pinned: Map<string, unknown>,
): void {
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
    return;
  }
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === "$and") {
      if (Array.isArray(value)) {
        for (const child of value) collectPins(child, fields, pinned);
      }
      continue;
    }
    if (pinned.has(key) || !fields.includes(key)) {
      continue;
    }
    const operand = isPlainObject(value) ? value.$eq : value;
    if (
      typeof operand === "string" ||
      typeof operand === "number" ||
      typeof operand === "boolean" ||
      operand instanceof Date
    ) {
      pinned.set(key, operand);
    }
  }
}

/**
 * Ergonomic late-binding entry point for provider (read-through) mode. Resolves
 * the ALREADY-BUILT {@link MemoryAdapter} backing `type` on `space` (reached
 * after `getTable`/`syncSchema` has constructed it via `space.getAdapter`, which
 * exists in core — so this helper needs NO core change) and installs `fn` as its
 * provider, making that one table read-only and recomputed per read.
 *
 * Throws if the resolved adapter is not a {@link MemoryAdapter} (i.e. the space
 * is backed by a different engine) so a misuse fails loudly, not silently.
 */
export function setMemoryProvider(
  space: DbSpace,
  type: TAtscriptAnnotatedType,
  fn: MemoryProviderFn,
): void {
  const adapter = space.getAdapter(type);
  if (!(adapter instanceof MemoryAdapter)) {
    throw new Error("setMemoryProvider: table is not backed by MemoryAdapter");
  }
  adapter.setProvider(fn);
}

/** @internal Drops the in-memory database of a closed space (called from `createAdapter`'s `onClose`). */
export function clearMemoryDatabase(space: DbSpace): void {
  databases.get(space)?.clear();
}
