import { BaseDbAdapter, DbError, DbSpace } from "@atscript/db";
import type {
  DbQuery,
  DbControls,
  FilterExpr,
  TFieldOps,
  TDbFieldMeta,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "@atscript/db";
// `@atscript/db` does NOT re-export the annotated-type; it comes from the
// atscript compiler's utils entry (same import `db-space.ts` uses).
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { buildMemoryPredicate, getPath, valuesEqual } from "./memory-filter";
import { projectRow, setPath, sortRows } from "./memory-engine";
import type { UniquSelect } from "@atscript/db";

/**
 * Provider (read-through) backing closure. Recomputes and returns the table's
 * rows on demand — a fresh snapshot every call (sync or async). See
 * {@link MemoryAdapter.setProvider} / {@link setMemoryProvider}.
 */
export type MemoryProviderFn = () =>
  | Array<Record<string, unknown>>
  | Promise<Array<Record<string, unknown>>>;

/**
 * A unique index recorded by {@link MemoryAdapter.syncIndexes}. `fields` holds
 * the ordered PHYSICAL field names (dot-paths); `optionalFields` are the subset
 * declared `field?:` in the model — a present-only (partial) index skips a row
 * whose optional member is absent/`null`, matching SQL's `NULLS DISTINCT`.
 */
interface RecordedUniqueIndex {
  name: string;
  fields: string[];
  optionalFields: Set<string>;
}

/**
 * In-memory {@link BaseDbAdapter} implementation.
 *
 * Runs in one of two modes:
 * - STORED mode (default): storage is a plain `Map` living on the adapter
 *   instance — adapter instances are 1:1 with a readable (table/view), so the
 *   Map is this table's whole store. Documents are kept in their nested PHYSICAL
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
   * The table's store, keyed by {@link pkKey}. Values are the stored rows in
   * nested physical shape. An instance field — no `ensureTable` DDL needed.
   */
  private rows = new Map<string, Record<string, unknown>>();

  /** Unique indexes recorded by {@link syncIndexes}. Enforced on insert. */
  private uniqueIndexes: RecordedUniqueIndex[] = [];

  /** Memoized physical PK field names — stable for the adapter's lifetime. */
  private _pkFieldsCache?: string[];

  /**
   * Memoized map of PHYSICAL field name → optional `start` for every field
   * carrying `@db.default.increment`. Stable per adapter (see
   * {@link _incrementFields}).
   */
  private _incrementFieldsCache?: Map<string, number | undefined>;

  /**
   * Running per-field auto-increment counters (PHYSICAL name → last value
   * handed out). Lives on the adapter INSTANCE, so it resets whenever a new
   * DbSpace/adapter is built — correct for an in-memory store (parity with
   * SQLite `:memory:`, whose sequence also restarts with a fresh DB). Never
   * persisted.
   */
  private _incrementCounters = new Map<string, number>();

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

  /**
   * Physical names of the primary-key field(s). Single `@meta.id` resolves via
   * {@link AtscriptDbReadable.metaIdPhysical}; a composite key maps each logical
   * PK path through `pathToPhysical` (falling back to the name itself). Memoized
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
      : this._table.primaryKeys.map((pk) => this._table.pathToPhysical.get(pk) ?? pk);
    this._pkFieldsCache = fields;
    return fields;
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
   * collection; an in-memory store just keeps the counter on the instance):
   *
   * - No value for the field → assign the next counter value. First use starts
   *   at `start ?? 1` (`max(counter, (start ?? 1) - 1) + 1`); thereafter it is
   *   the previous value + 1. Sequential across an `insertMany` batch because
   *   {@link _insertRow} runs per item in `insertedIds` order against the shared
   *   counter.
   * - Explicit value present → keep it, but advance the counter to
   *   `max(counter, value)` so a later auto value can never collide with it.
   */
  private _applyIncrements(row: Record<string, unknown>): void {
    const fields = this._incrementFields();
    if (fields.size === 0) {
      return;
    }
    for (const [physical, start] of fields) {
      // `base` already defaults to `floor` when the counter is unset, and every
      // counter write below keeps it >= floor, so `base >= floor` is invariant —
      // the next auto value is simply `base + 1` (no `Math.max(base, floor)`).
      const floor = (start ?? 1) - 1;
      const base = this._incrementCounters.get(physical) ?? floor;
      const current = row[physical];
      if (current === undefined || current === null) {
        const next = base + 1;
        row[physical] = next;
        this._incrementCounters.set(physical, next);
      } else if (typeof current === "number") {
        // Explicit id: don't overwrite, but never let a future auto value reuse it.
        this._incrementCounters.set(physical, Math.max(base, current));
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
    const values = this._physicalPkFields().map((field) => getPath(row, field));
    return JSON.stringify(values);
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
   * 500 — the same choice `aggregate()` makes) since there is no dedicated
   * read-only error code.
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
   * - Stored mode reads the instance Map directly (insertion order preserved).
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
    return [...this.rows.values()];
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /**
   * Clones the payload in, applies the version default, generates any
   * `@db.default.increment` values, enforces PK + unique constraints, stores
   * the row, and returns the resolved inserted id. Clone-in (`structuredClone`)
   * is what makes post-insert mutation of the caller's object never leak into
   * the store. Called once per item by both `insertOne` and `insertMany`, so
   * increment values advance sequentially across a batch.
   */
  private _insertRow(data: Record<string, unknown>): unknown {
    const row = structuredClone(data);

    // Memory has no DDL DEFAULT; fill version=0 at insert when missing so OCC
    // stays consistent with the SQL/Mongo adapters.
    const versionColumn = this._table.versionColumn;
    if (versionColumn !== undefined && !(versionColumn in row)) {
      row[versionColumn] = 0;
    }

    // Memory has no DB sequence; the adapter generates @db.default.increment
    // values here — BEFORE pkKey, so an increment PK yields a real inserted id
    // (parity with SQL autoincrement / the Mongo counter-collection).
    this._applyIncrements(row);

    const key = this.pkKey(row);
    if (this.rows.has(key)) {
      throw this._pkConflict();
    }

    this._enforceUniqueIndexes(row);
    this.rows.set(key, row);
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
   * tuple → `CONFLICT`.
   *
   * `excludeKey` (when given) skips the row stored under that {@link pkKey} — so
   * a row updating its own unique value does not false-conflict with itself.
   */
  private _enforceUniqueIndexes(row: Record<string, unknown>, excludeKey?: string): void {
    for (const index of this.uniqueIndexes) {
      const tuple: unknown[] = [];
      let skip = false;
      for (const field of index.fields) {
        const value = getPath(row, field);
        if (index.optionalFields.has(field) && (value === null || value === undefined)) {
          skip = true;
          break;
        }
        tuple.push(value);
      }
      if (skip) {
        continue;
      }
      for (const [existingKey, existing] of this.rows) {
        if (excludeKey !== undefined && existingKey === excludeKey) {
          continue;
        }
        let equal = true;
        for (let i = 0; i < index.fields.length; i++) {
          if (!valuesEqual(getPath(existing, index.fields[i]!), tuple[i])) {
            equal = false;
            break;
          }
        }
        if (equal) {
          throw new DbError("CONFLICT", [
            {
              path: index.fields[0] ?? index.name,
              message: `Duplicate value for unique index "${index.name}"`,
            },
          ]);
        }
      }
    }
  }

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    this._assertWritable();
    return { insertedId: this._insertRow(data) };
  }

  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    this._assertWritable();
    // Ordered, non-atomic (v1 limitation): a collision throws after the prior
    // items are already stored. The table layer routes `insertOne` through
    // `insertMany([one])` and the sync lock relies on a duplicate-PK insert
    // throwing, so a single-element collision MUST throw — which it does.
    const insertedIds = data.map((item) => this._insertRow(item));
    return { insertedCount: data.length, insertedIds };
  }

  // ── Write helpers ─────────────────────────────────────────────────────────

  /**
   * Selects the stored rows a write should touch, as `{ key, row }` pairs so
   * callers can mutate in place and re-key. Stored mode scans the instance Map
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
   * When `many` is `false` at most the first match is returned.
   */
  private _selectForWrite(
    filter: FilterExpr,
    expectedVersion: number | undefined,
    many: boolean,
  ): Array<{ key: string; row: Record<string, unknown> }> {
    const versionColumn = this._table.versionColumn;
    if (expectedVersion !== undefined && versionColumn === undefined) {
      throw new Error("expectedVersion requires a versioned table");
    }
    const match = buildMemoryPredicate(filter);
    const matched: Array<{ key: string; row: Record<string, unknown> }> = [];
    for (const [key, row] of this.rows) {
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
    const versionColumn = this._table.versionColumn;
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
   *   (dot-free) keys behave as a plain assignment. `data` is `structuredClone`d
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
    const patch = structuredClone(data);
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
   * Places `next` into the store under its (possibly changed) {@link pkKey},
   * re-keying when a mutation/replace moved the primary key. A collision on the
   * NEW key (some other row already owns it) throws `CONFLICT`. Throws BEFORE
   * touching the Map so a failed re-key leaves the store unchanged.
   */
  private _commitRow(oldKey: string, next: Record<string, unknown>): void {
    const newKey = this.pkKey(next);
    if (newKey !== oldKey && this.rows.has(newKey)) {
      throw this._pkConflict();
    }
    if (newKey !== oldKey) {
      this.rows.delete(oldKey);
    }
    this.rows.set(newKey, next);
  }

  /**
   * Update-then-commit for a single matched row: clones the pristine `row`,
   * applies the merge update, bumps the version LAST (read from the pristine old
   * `row`), enforces unique indexes on the result EXCLUDING the row's own key (so
   * a row keeping/rewriting its own unique value never self-conflicts), then
   * commits. Nothing is written to the store until both the unique and PK checks
   * pass, so a conflict leaves the store untouched.
   */
  private _commitUpdate(
    oldKey: string,
    row: Record<string, unknown>,
    data: Record<string, unknown>,
    ops?: TFieldOps,
  ): void {
    const next = structuredClone(row);
    this._applyUpdate(next, data, ops);
    this._bumpVersion(next, row);
    this._enforceUniqueIndexes(next, oldKey);
    this._commitRow(oldKey, next);
  }

  async replaceOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<TDbUpdateResult> {
    this._assertWritable();
    const matched = this._selectForWrite(filter, expectedVersion, false);
    if (matched.length === 0) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const { key, row } = matched[0]!;

    // FULL replace: `next` is the payload verbatim, so every field absent from
    // `data` is dropped — only the version is derived, bumped from the old row's
    // value (mirrors Mongo's `$replaceWith` with `version: $version + 1`).
    const next = structuredClone(data);
    this._bumpVersion(next, row);

    this._enforceUniqueIndexes(next, key);
    this._commitRow(key, next);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
    expectedVersion?: number,
  ): Promise<TDbUpdateResult> {
    this._assertWritable();
    const matched = this._selectForWrite(filter, expectedVersion, false);
    if (matched.length === 0) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const { key, row } = matched[0]!;
    this._commitUpdate(key, row, data, ops);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    this._assertWritable();
    const matched = this._selectForWrite(filter, undefined, false);
    if (matched.length === 0) {
      return { deletedCount: 0 };
    }
    this.rows.delete(matched[0]!.key);
    return { deletedCount: 1 };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * Stable multi-key comparator from `$sort`, with a final tie-break on
   * {@link pkKey} for a deterministic total order. Returns the input unchanged
   * (insertion order) when there is no `$sort`. Delegates to the shared pure
   * {@link sortRows}, injecting {@link pkKey} as the total-order tie-break.
   */
  private _sortRows(
    rows: Record<string, unknown>[],
    $sort?: Partial<Record<string, 1 | -1>>,
  ): Record<string, unknown>[] {
    return sortRows(rows, $sort, (r) => this.pkKey(r));
  }

  /** Applies `$skip` then `$limit` (both optional) via a single slice. */
  private _paginate(
    rows: Record<string, unknown>[],
    skip?: number,
    limit?: number,
  ): Record<string, unknown>[] {
    const start = skip ?? 0;
    const end = limit === undefined ? undefined : start + limit;
    // No-op pagination (the common unpaginated list read) returns the input
    // as-is: `rows` here is always a fresh, non-store-aliased array and the
    // caller deep-clones each row on output, so skip the whole-array `.slice`
    // copy that `slice(0, undefined)` would otherwise make.
    if (start === 0 && end === undefined) {
      return rows;
    }
    return rows.slice(start, end);
  }

  /**
   * Projects a stored row per `$select` and returns a fresh, deep-cloned object
   * so the store can never be mutated through a returned value.
   *
   * - No projection → a full clone.
   * - INCLUSION form (`{ field: 1 }`) → a new object with only the selected
   *   paths PLUS the primary-key field(s) (mirrors Mongo including `_id`).
   * - EXCLUSION form (`{ field: 0 }`) → a clone with those paths removed.
   *
   * Top-level and nested dot-paths are supported; exotic Mongo projection
   * quirks (array positional, `$slice`, etc.) are intentionally NOT replicated.
   */
  private _projectAndClone(
    row: Record<string, unknown>,
    $select?: UniquSelect,
  ): Record<string, unknown> {
    // Delegate to the shared pure {@link projectRow}: pass the resolved
    // projection map and this table's physical PK fields (added by inclusion),
    // and force `clone: true` so a returned value can never mutate the store.
    return projectRow(row, $select?.asProjection, {
      pkFields: this._physicalPkFields(),
      clone: true,
    });
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
   */
  private async _filteredRows(query: DbQuery): Promise<Record<string, unknown>[]> {
    const match = buildMemoryPredicate(query.filter);
    return (await this._loadRows()).filter(match);
  }

  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    const filtered = await this._filteredRows(query);
    const { $sort, $skip, $select } = this._readControls(query.controls ?? {});
    const sorted = this._sortRows(filtered, $sort);
    const row = sorted[$skip ?? 0];
    return row ? this._projectAndClone(row, $select) : null;
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
    const sorted = this._sortRows(filtered, $sort);
    const paged = this._paginate(sorted, $skip, $limit);
    const data = paged.map((row) => this._projectAndClone(row, $select));
    return { data, count: filtered.length };
  }

  /**
   * Aggregation (`$groupBy`) is a documented v1 non-goal for the in-memory
   * adapter. The inherited base default throws a PLAIN `Error`, which a readable
   * REST controller would surface as an unhandled HTTP 500 when a `?$groupBy=`
   * query routes here. Throwing a typed {@link DbError} with `INVALID_QUERY`
   * instead converts that into a clean client error — moost-db's validation
   * interceptor maps `INVALID_QUERY` → HTTP 400.
   */
  override async aggregate(_query: DbQuery): Promise<Array<Record<string, unknown>>> {
    throw new DbError("INVALID_QUERY", [
      { path: "", message: "Aggregation ($groupBy) is not supported by the in-memory adapter" },
    ]);
  }

  // ── Batch operations ──────────────────────────────────────────────────────

  async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
  ): Promise<TDbUpdateResult> {
    this._assertWritable();
    // updateMany never CAS-checks (locked decision row 2) — `expectedVersion` is
    // never passed. Each matched row still auto-bumps its own version. Applied
    // sequentially and NON-atomically (a mid-loop unique/PK conflict leaves the
    // earlier rows already updated), matching `insertMany`'s v1 contract.
    const matched = this._selectForWrite(filter, undefined, true);
    for (const { key, row } of matched) {
      this._commitUpdate(key, row, data, ops);
    }
    return { matchedCount: matched.length, modifiedCount: matched.length };
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    this._assertWritable();
    // Mirrors Mongo: there is no native `replaceMany`, so this is a `$set` MERGE
    // + version bump on every match (via `_applyUpdate`), NOT a full-document
    // replace like `replaceOne`. Fields absent from `data` are RETAINED on each
    // matched row. Sequential + non-atomic, sibling of `updateMany`, no CAS.
    const matched = this._selectForWrite(filter, undefined, true);
    for (const { key, row } of matched) {
      this._commitUpdate(key, row, data);
    }
    return { matchedCount: matched.length, modifiedCount: matched.length };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    this._assertWritable();
    const matched = this._selectForWrite(filter, undefined, true);
    for (const { key } of matched) {
      this.rows.delete(key);
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
    this.uniqueIndexes = [];
    for (const index of this._table.indexes.values()) {
      if (index.type !== "unique") {
        continue;
      }
      this.uniqueIndexes.push({
        name: index.name,
        fields: index.fields.map((f) => f.name),
        optionalFields: new Set(index.fields.filter((f) => f.optional).map((f) => f.name)),
      });
    }
  }

  /**
   * No-op: the store is the instance-level {@link rows} Map, which already
   * exists. Safe to call repeatedly.
   */
  async ensureTable(): Promise<void> {}
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
