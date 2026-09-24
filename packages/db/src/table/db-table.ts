import {
  type FlatOf,
  type PrimaryKeyOf,
  type OwnPropsOf,
  type NavPropsOf,
  type TAtscriptAnnotatedType,
  type TAtscriptDataType,
  type Validator,
} from "@atscript/typescript/utils";

import type { FilterExpr } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import { CasMismatchError, DbError } from "../db-error";
import type { TGenericLogger } from "../logger";
import { separateCas, separateFieldOps, type TFieldOps } from "../ops";
import type { TableMetadata } from "./table-metadata";
import { resolveArrayOps, getArrayOpsFields } from "../patch/array-ops-resolver";
import { assertNoVersionWrites, decomposePatch } from "../patch/patch-decomposer";
import { AtscriptDbReadable } from "./db-readable";
import { enrichFkViolation, remapDeleteFkViolation } from "./error-utils";
import {
  type TNestedWriterHost,
  checkDepthOverflow,
  validateBatch,
  preValidateNestedFrom,
  batchInsertNestedTo,
  batchInsertNestedFrom,
  batchInsertNestedVia,
  batchReplaceNestedTo,
  batchReplaceNestedFrom,
  batchReplaceNestedVia,
  batchPatchNestedTo,
  batchPatchNestedFrom,
  batchPatchNestedVia,
} from "../rel/nested-writer";
import { type DbValidationContext } from "../db-validator-plugin";
import {
  buildDbValidator,
  buildPatchPartial,
  dbPlugin,
  forceNavNonOptional,
  type ValidatorMode,
} from "../validator";
import type { IntegrityStrategy } from "../strategies/integrity";
import { NativeIntegrity } from "../strategies/integrity";
import { ApplicationIntegrity } from "../strategies/application-integrity";
import type {
  DbPatch,
  DbRow,
  TCascadeResolver,
  TDbDeleteResult,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbRemoveGuardContext,
  TDbUpdateResult,
  TDbWriteAction,
  TDbWriteGuardContext,
  TDeleteOptions,
  TFkLookupResolver,
  TIdResolveOptions,
  TTableResolver,
  TWriteOptions,
  TTouchManyOptions,
  TWriteTableResolver,
  NullableOptional,
} from "../types";
import { isEmptyObject, isPlainObject } from "../shared/object";

import { guardFilter, guardPaths } from "../query/query-guards";

import { resolveDesignType } from "./db-readable";

export { resolveDesignType };

/** Returns true when `value` is a plain object carrying any `$`-prefixed key (an operator object). */
function _hasOperatorKeys(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  for (const key in value) {
    if (key.startsWith("$")) {
      return true;
    }
  }
  return false;
}

/**
 * Generic database table abstraction driven by Atscript `@db.*` annotations.
 *
 * Extends {@link AtscriptDbReadable} (read operations, field metadata, query
 * translation, relation loading) with write operations, validators, and
 * schema management.
 *
 * ```typescript
 * const adapter = new MongoAdapter(db)
 * const users = new AtscriptDbTable(UsersType, adapter)
 * await users.insertOne({ name: 'John', email: 'john@example.com' })
 * ```
 *
 * @typeParam T - The Atscript annotated type for this table.
 * @typeParam DataType - The inferred data shape from the annotated type.
 */

/**
 * Clones a write payload while dropping every own key whose value is
 * `=== undefined` (`undefined` ≡ absent; `null` stays an explicit NULL), so
 * that defaults, validation, encryption and decomposition never see an
 * `undefined` prop.
 *
 * Recurses into plain objects and into arrays at any depth (plain-object
 * elements are cloned, elements are never dropped or reordered) and never
 * into class instances (`Date`, `Uint8Array`/`Buffer`, `ObjectId`, …), which
 * are kept by reference. Arrays without plain-object elements anywhere below
 * them are kept by reference too. The caller's payload tree is never mutated.
 * @internal exported for the core spec only — not part of the package surface.
 */
export function _cloneWritePayload(source: Record<string, unknown>): Record<string, unknown> {
  if (typeof source !== "object" || source === null) {
    // Mirrors the former `{ ...p }` clone: a null / primitive payload becomes an
    // (empty) object the validator rejects with a proper ValidatorError.
    return { ...(source as unknown as object) };
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined) continue;
    out[key] = _cloneWriteValue(value);
  }
  return out;
}

function _cloneWriteValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    let cloned: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const el: unknown = value[i];
      if (isPlainObject(el) || Array.isArray(el)) {
        const c = _cloneWriteValue(el);
        if (c !== el) {
          cloned ??= value.slice();
          cloned[i] = c;
        }
      }
    }
    return cloned ?? value;
  }
  return isPlainObject(value) ? _cloneWritePayload(value) : value;
}

/**
 * The clone for a nested re-entry (`_depth > 0`) and for `preValidateItems`:
 * the root call already deep-pruned the whole tree, so only the row's own
 * keys are (re-)pruned — no recursion, no per-level re-cloning of subtrees.
 */
function _shallowPrunedClone(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key in source) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Write options with the internal fields the nested writer and the `*One` wrappers pass through. */
type TInternalWriteOptions<Row> = TWriteOptions<Row> & {
  _depth?: number;
  _action?: TDbWriteAction;
};

/**
 * {@link TDbWriteGuardContext} handed to a write guard: a sparse per-index
 * cache of pre-image reads, allocated only when `current(i)` is first used.
 */
class WriteGuardContext<Row> implements TDbWriteGuardContext<Row> {
  private _pending?: Array<Promise<Row | null> | undefined>;

  constructor(
    readonly action: TDbWriteAction,
    readonly rows: Row[],
    readonly expectedVersions: ReadonlyArray<number | undefined>,
    private readonly _table: AtscriptDbTable,
  ) {}

  current(i: number): Promise<Row | null> {
    const cache = (this._pending ??= []);
    let pending = cache[i];
    if (!pending) {
      pending = this._table._readPreImage(this.rows[i]) as Promise<Row | null>;
      cache[i] = pending;
    }
    return pending;
  }
}

/** {@link TDbRemoveGuardContext} handed to a delete guard (one memoised pre-image read). */
class RemoveGuardContext<Row> implements TDbRemoveGuardContext<Row> {
  private _pending?: Promise<Row | null>;

  constructor(
    readonly id: unknown,
    readonly filter: FilterExpr,
    private readonly _table: AtscriptDbTable,
  ) {}

  current(): Promise<Row | null> {
    this._pending ??= this._table.findOne({
      filter: this.filter,
      controls: {},
    } as never) as Promise<Row | null>;
    return this._pending;
  }
}

/** Translates a single ops record from logical to physical column names. */
function _translateOpsRecord(
  rec: Record<string, number>,
  meta: TableMetadata,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key in rec) {
    out[meta.leafByLogical.get(key)?.physicalName ?? key] = rec[key]!;
  }
  return out;
}

/** Translates ops keys from logical field names to physical column names. */
function _translateOpsKeys(ops: TFieldOps, meta: TableMetadata): TFieldOps {
  return {
    inc: ops.inc ? _translateOpsRecord(ops.inc, meta) : undefined,
    mul: ops.mul ? _translateOpsRecord(ops.mul, meta) : undefined,
  };
}

/** Upper bound of keys per `touchMany` UPDATE statement (parameter-count safety). */
const TOUCH_MANY_CHUNK = 500;

/** `touchMany` input rejection — always `INVALID_QUERY`, path names the key. */
function invalidTouchKey(path: string, message: string): DbError {
  return new DbError("INVALID_QUERY", [{ path, message }]);
}

export class AtscriptDbTable<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
  FlatType = NullableOptional<FlatOf<T>>,
  A extends BaseDbAdapter = BaseDbAdapter,
  IdType = PrimaryKeyOf<T>,
  OwnProps = NullableOptional<OwnPropsOf<T>>,
  NavType extends Record<string, unknown> = NavPropsOf<T>,
> extends AtscriptDbReadable<T, DataType, FlatType, A, IdType, OwnProps, NavType> {
  // ── Cascade resolver ─────────────────────────────────────────────────────

  protected _cascadeResolver?: TCascadeResolver;
  protected _fkLookupResolver?: TFkLookupResolver;

  // ── Integrity strategy ──────────────────────────────────────────────────

  protected readonly _integrity: IntegrityStrategy;

  // ── Validators ────────────────────────────────────────────────────────────

  protected readonly validators = new Map<string, Validator<T, DataType>>();

  private _fromDepthMap?: ReadonlyMap<string, number>;

  constructor(
    _type: T,
    adapter: A,
    logger?: TGenericLogger,
    _tableResolver?: TTableResolver,
    _writeTableResolver?: TWriteTableResolver,
  ) {
    super(_type, adapter, logger, _tableResolver);
    if (_writeTableResolver) {
      this._writeTableResolver = _writeTableResolver;
    }
    this._integrity = adapter.supportsNativeForeignKeys()
      ? new NativeIntegrity()
      : new ApplicationIntegrity();
  }

  /**
   * Sets the cascade resolver for application-level cascade deletes.
   * Called by DbSpace after table creation.
   */
  setCascadeResolver(resolver: TCascadeResolver): void {
    this._cascadeResolver = resolver;
  }

  /**
   * Sets the FK lookup resolver for application-level FK validation.
   * Called by DbSpace after table creation.
   */
  setFkLookupResolver(resolver: TFkLookupResolver): void {
    this._fkLookupResolver = resolver;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  /**
   * Returns a cached validator for the given purpose.
   * Built with adapter plugins from {@link BaseDbAdapter.getValidatorPlugins}.
   *
   * Standard purposes: `'insert'`, `'update'`, `'patch'`.
   * Adapters may define additional purposes.
   */
  public getValidator(purpose: string): Validator<T, DataType> {
    if (!this.validators.has(purpose)) {
      const validator = this._buildValidator(purpose);
      this.validators.set(purpose, validator);
    }
    return this.validators.get(purpose)!;
  }

  // ── CRUD operations ───────────────────────────────────────────────────────

  /**
   * Inserts a single record. Delegates to {@link insertMany} for unified
   * nested creation support.
   */
  public async insertOne(
    payload: DbPatch<DataType>,
    opts?: TWriteOptions<DataType>,
  ): Promise<TDbInsertResult> {
    const result = await this.insertMany([payload], {
      ...opts,
      _action: "insert",
    } as TInternalWriteOptions<DataType>);
    return { insertedId: result.insertedIds[0] };
  }

  /**
   * Inserts multiple records with batch-optimized nested creation.
   *
   * Supports **nested creation**: if payloads include data for navigation
   * fields (`@db.rel.to` / `@db.rel.from`), related records are created
   * automatically in batches. TO dependencies are batch-created first
   * (their PKs become our FKs), FROM dependents are batch-created after
   * (they receive our PKs as their FKs). Fully recursive — nested records
   * with their own nav data trigger further batch inserts at each level.
   * Recursive up to `maxDepth` (default 3).
   *
   * `opts.guard` (since 0.1.128) runs once inside the transaction, after
   * defaults + validation, with the prepared rows — see {@link TWriteOptions}.
   */
  public async insertMany(
    payloads: Array<DbPatch<DataType>>,
    opts?: TWriteOptions<DataType>,
  ): Promise<TDbInsertManyResult> {
    this._ensureBuilt();
    const {
      _depth,
      _action,
      maxDepth: userMax,
      guard,
    } = (opts ?? {}) as TInternalWriteOptions<DataType>;
    const maxDepth = userMax ?? 3;
    const depth = _depth ?? 0;
    const canNest = depth < maxDepth && this._writeTableResolver && this._meta.navFields.size > 0;
    if (!canNest && this._meta.navFields.size > 0) {
      checkDepthOverflow(payloads as Array<Record<string, unknown>>, maxDepth, this._meta);
    }

    return enrichFkViolation(this._meta, () =>
      this.adapter.withTransaction(async () => {
        // Clone (dropping `undefined` props — deep at the root call only, the
        // nested re-entries receive already-pruned subtrees) + apply defaults.
        const clone = depth === 0 ? _cloneWritePayload : _shallowPrunedClone;
        const items = payloads.map((p) => this._applyDefaults(clone(p)));
        // Nav data for the FROM / VIA phases, read from the pruned rows (nav
        // fields are stripped from `items` before the main insert).
        const originals = canNest ? items.map((item) => ({ ...item })) : [];

        // Validate full payload (including nav fields) before any writes.
        // Depth is only enforced at the root call — nested-writer re-entries
        // already had their full tree validated upstream.
        const validator = this.getValidator("insert");
        const ctx: DbValidationContext = { mode: "insert", navFields: this._meta.navFields };
        this._applyDepthCtx(ctx, depth);
        validateBatch(validator, items, ctx);

        // Validated-stage guard: sees the plaintext rows (defaults applied, nav
        // data attached) and may enrich them — validated again afterwards.
        if (guard) {
          await guard(
            new WriteGuardContext<DataType>(
              _action ?? "insertMany",
              items as DataType[],
              Array.from({ length: items.length }),
              this as AtscriptDbTable,
            ),
          );
          validateBatch(validator, items, ctx);
        }

        // Encrypt @db.encrypted fields AFTER plaintext validation, BEFORE the adapter.
        await this._encryptItems(items, "write");

        // Phase 1: Batch TO dependencies (they must exist before we can set our FKs)
        const host = this as any as TNestedWriterHost;
        if (canNest) {
          await batchInsertNestedTo(host, items, maxDepth, depth);
        }

        // Strip nav fields, prepare for write
        const prepared: Array<Record<string, unknown>> = [];
        for (const data of items) {
          for (const navField of this._meta.navFields) {
            delete data[navField];
          }
          prepared.push(this._fieldMapper.prepareForWrite(data, this._meta, this.adapter));
        }

        // Validate FK references (application-level, for adapters without native FK support)
        await this._integrity.validateForeignKeys(
          items,
          this._meta,
          this._fkLookupResolver,
          this._writeTableResolver,
        );

        // Pre-validate FROM children (types + FK constraints) before the main insert.
        // Catches errors early (before the parent is committed), essential for
        // adapters without transaction support.
        if (canNest) {
          await preValidateNestedFrom(host, originals);
        }

        // Phase 2: Batch main insert
        const result = await this.adapter.insertMany(prepared);

        // Phase 3: Batch FROM dependents (they need our PKs)
        if (canNest) {
          await batchInsertNestedFrom(host, originals, result.insertedIds, maxDepth, depth);
        }

        // Phase 4: Batch VIA relations (insert targets + junction entries)
        if (canNest) {
          await batchInsertNestedVia(host, originals, result.insertedIds, maxDepth, depth);
        }

        return result;
      }),
    );
  }

  /**
   * Replaces a single record identified by primary key(s).
   * Delegates to {@link bulkReplace} for unified nested relation support.
   */
  public async replaceOne(
    payload: DbRow<DataType>,
    opts?: TWriteOptions<DataType>,
  ): Promise<TDbUpdateResult> {
    return this.bulkReplace([payload], {
      ...opts,
      _action: "replace",
    } as TInternalWriteOptions<DataType>);
  }

  /**
   * Replaces multiple records with deep nested relation support.
   *
   * Supports all relation types (TO, FROM, VIA). TO dependencies are
   * replaced first (their PKs become our FKs), FROM dependents are replaced
   * after (they receive our PKs as their FKs), VIA relations clear and
   * re-create junction rows. Fully recursive up to `maxDepth` (default 3).
   *
   * `opts.guard` (since 0.1.128) runs once inside the transaction, after
   * `$cas` extraction, defaults + validation — see {@link TWriteOptions}.
   */
  public async bulkReplace(
    payloads: Array<DbRow<DataType>>,
    opts?: TWriteOptions<DataType>,
  ): Promise<TDbUpdateResult> {
    this._ensureBuilt();
    const {
      _depth,
      _action,
      maxDepth: userMax,
      guard,
    } = (opts ?? {}) as TInternalWriteOptions<DataType>;
    const maxDepth = userMax ?? 3;
    const depth = _depth ?? 0;
    const canNest = depth < maxDepth && this._writeTableResolver && this._meta.navFields.size > 0;
    if (!canNest && this._meta.navFields.size > 0) {
      checkDepthOverflow(payloads as Array<Record<string, unknown>>, maxDepth, this._meta);
    }

    return enrichFkViolation(this._meta, () =>
      this.adapter.withTransaction(async () => {
        // Phase 0: Setup — clone (dropping `undefined` props), extract $cas FIRST
        // so OCC state never leaks into _applyDefaults, then apply defaults, then
        // validate. Hoist versionColumn — constant per table; one lookup serves
        // the whole batch.
        const versionColumn = this.versionColumn;
        const expectedVersions: Array<number | undefined> = Array.from({
          length: payloads.length,
        });
        const clone = depth === 0 ? _cloneWritePayload : _shallowPrunedClone;
        const items = payloads.map((p, i) => {
          const c = clone(p);
          expectedVersions[i] = separateCas(c, versionColumn);
          return this._applyDefaults(c);
        });
        // Nav data for the FROM / VIA phases, read from the pruned rows.
        const originals = canNest ? items.map((item) => ({ ...item })) : [];

        const validator = this.getValidator("bulkReplace");
        const ctx: DbValidationContext = { mode: "replace", navFields: this._meta.navFields };
        this._applyDepthCtx(ctx, depth);
        validateBatch(validator, items, ctx);

        if (guard) {
          await guard(
            new WriteGuardContext<DataType>(
              _action ?? "replaceMany",
              items as DataType[],
              expectedVersions,
              this as AtscriptDbTable,
            ),
          );
          validateBatch(validator, items, ctx);
        }

        // Encrypt @db.encrypted fields AFTER plaintext validation, BEFORE the adapter.
        await this._encryptItems(items, "write");

        const host = this as any as TNestedWriterHost;

        // Phase 1: TO dependencies (replace parents)
        if (canNest) {
          await batchReplaceNestedTo(host, items, maxDepth, depth);
        }

        // Validate FK references (application-level, for adapters without native FK support)
        await this._integrity.validateForeignKeys(
          items,
          this._meta,
          this._fkLookupResolver,
          this._writeTableResolver,
        );

        // Pre-validate FROM children (types + FK constraints) before the main replace
        if (canNest) {
          await preValidateNestedFrom(host, originals);
        }

        // Phase 2: Main replace — strip nav fields, reject direct version writes,
        // prepare, replace each (with per-item expectedVersion when supplied).
        let matchedCount = 0;
        let modifiedCount = 0;
        for (let i = 0; i < items.length; i++) {
          const data = items[i]!;
          for (const navField of this._meta.navFields) {
            delete data[navField];
          }
          if (versionColumn !== undefined) {
            assertNoVersionWrites(data, versionColumn);
          }
          const filter = this._extractRecordFilter(data, opts);
          const prepared = this._fieldMapper.prepareForWrite(data, this._meta, this.adapter);
          const result = await this.adapter.replaceOne(
            this._fieldMapper.translateFilter(filter, this._meta),
            prepared,
            expectedVersions[i],
          );
          matchedCount += result.matchedCount;
          modifiedCount += result.modifiedCount;
        }

        // Phase 3: FROM dependencies (replace children)
        if (canNest) {
          await batchReplaceNestedFrom(host, originals, maxDepth, depth);
        }

        // Phase 4: VIA dependencies (replace junction records)
        if (canNest) {
          await batchReplaceNestedVia(host, originals, maxDepth, depth);
        }

        return { matchedCount, modifiedCount };
      }),
    );
  }

  /**
   * Partially updates a single record identified by primary key(s).
   * Delegates to {@link bulkUpdate} for unified nested relation support.
   */
  public async updateOne(
    payload: DbPatch<DataType>,
    opts?: TWriteOptions<DataType>,
  ): Promise<TDbUpdateResult> {
    return this.bulkUpdate([payload], {
      ...opts,
      _action: "update",
    } as TInternalWriteOptions<DataType>);
  }

  /**
   * Partially updates multiple records with deep nested relation support.
   *
   * Only TO relations (1:1, N:1) are supported for patching. FROM/VIA
   * relations will error — use {@link bulkReplace} for those.
   * Recursive up to `maxDepth` (default 3).
   *
   * `opts.guard` (since 0.1.128) runs once inside the transaction, after
   * `$cas` extraction and validation, with the patches (identifying fields
   * present, `$cas` removed) — see {@link TWriteOptions}.
   */
  public async bulkUpdate(
    payloads: Array<DbPatch<DataType>>,
    opts?: TWriteOptions<DataType>,
  ): Promise<TDbUpdateResult> {
    this._ensureBuilt();
    const {
      _depth,
      _action,
      maxDepth: userMax,
      guard,
    } = (opts ?? {}) as TInternalWriteOptions<DataType>;
    const maxDepth = userMax ?? 3;
    const depth = _depth ?? 0;
    const canNest = depth < maxDepth && this._writeTableResolver && this._meta.navFields.size > 0;
    if (!canNest && this._meta.navFields.size > 0) {
      checkDepthOverflow(payloads as Array<Record<string, unknown>>, maxDepth, this._meta);
    }

    return enrichFkViolation(this._meta, () =>
      this.adapter.withTransaction(async () => {
        // OCC: extract $cas from each payload BEFORE validation. The strict
        // validator would otherwise reject $cas as an unknown top-level key
        // (it's not part of the schema). Hoist versionColumn once — constant
        // per table; per-payload lookups in a hot loop would waste cycles.
        // Work on a local `cloned` array (with `undefined` props dropped) so the
        // caller's payload array (and payload objects) are never mutated.
        const versionColumn = this.versionColumn;
        const expectedVersions: Array<number | undefined> = Array.from({
          length: payloads.length,
        });
        const clone = depth === 0 ? _cloneWritePayload : _shallowPrunedClone;
        const cloned: Array<Record<string, unknown>> = payloads.map((p, i) => {
          const c = clone(p);
          expectedVersions[i] = separateCas(c, versionColumn);
          return c;
        });

        // Phase 0: Setup — validate full payload (plugin checks nav field constraints)
        const validator = this.getValidator("bulkUpdate");
        const ctx: DbValidationContext = {
          mode: "patch",
          flatMap: this.flatMap,
          navFields: this._meta.navFields,
        };
        this._applyDepthCtx(ctx, depth);
        validateBatch(validator, cloned, ctx);

        if (guard) {
          await guard(
            new WriteGuardContext<DataType>(
              _action ?? "updateMany",
              cloned as DataType[],
              expectedVersions,
              this as AtscriptDbTable,
            ),
          );
          validateBatch(validator, cloned, ctx);
        }

        // Preserve originals for FROM/VIA phase (nav fields are stripped in Phase 2)
        const originals = canNest ? cloned.map((p) => ({ ...p })) : [];

        // Encrypt @db.encrypted fields AFTER plaintext validation, BEFORE the adapter.
        // Patch mode also rejects operator objects on encrypted fields (ENC_FIELD_PATCH_OP).
        await this._encryptItems(cloned, "patch");

        const host = this as any as TNestedWriterHost;

        // Phase 1: TO relation patches
        if (canNest) {
          await batchPatchNestedTo(host, cloned, maxDepth, depth);
        }

        // Validate FK references (application-level, for adapters without native FK support)
        await this._integrity.validateForeignKeys(
          cloned,
          this._meta,
          this._fkLookupResolver,
          this._writeTableResolver,
          true,
        );

        // Phase 2: Main patch — strip nav fields, separate ops, decompose, update each.
        // $cas has already been stripped above; direct-write rejection still runs
        // here so the version column never reaches the SET path.
        let matchedCount = 0;
        let modifiedCount = 0;
        for (let i = 0; i < cloned.length; i++) {
          const payload = cloned[i]!;
          const expectedVersion = expectedVersions[i];
          const data = { ...payload } as Record<string, unknown>;
          for (const navField of this._meta.navFields) {
            delete data[navField];
          }
          const filter = this._extractRecordFilter(data, opts);

          // Strip filter keys from data — they identify the record, not in the SET clause
          for (const key of Object.keys(filter)) {
            delete data[key];
          }

          // Reject direct writes to the version column (server-managed).
          if (versionColumn !== undefined) {
            assertNoVersionWrites(data, versionColumn);
          }

          const translatedFilter = this._fieldMapper.translateFilter(filter, this._meta);

          // Empty patch (e.g. only nav props + PK in payload) — three-way split:
          //  1. empty + `$cas`     → falls through and EXECUTES the CAS statement
          //     (`UPDATE … SET version = version + 1 WHERE <pk> AND version = ?`):
          //     the "versioned touch". Hit → { 1, 1 } and a bump; stale/missing
          //     → { 0, 0 }. A CAS predicate is never silently dropped.
          //  2. empty + no `$cas`  → no statement (a no-op must not invalidate
          //     other clients' versions), but `matchedCount` is honest: one
          //     PK-indexed count tells whether the row exists.
          //  3. non-empty          → unchanged below.
          if (isEmptyObject(data) && expectedVersion === undefined) {
            const exists = await this.adapter.count({ filter: translatedFilter, controls: {} });
            matchedCount += exists > 0 ? 1 : 0;
            continue;
          }

          let result: TDbUpdateResult;
          if (this.adapter.supportsNativePatch()) {
            // Native patch path: separate top-level ops; patcher handles nested ops internally
            const ops = separateFieldOps(data);
            const translatedOps = ops ? _translateOpsKeys(ops, this._meta) : undefined;
            const translatedData = this._fieldMapper.translatePatchKeys(data, this._meta);
            result = await this.adapter.nativePatch(
              translatedFilter,
              translatedData,
              translatedOps,
              expectedVersion,
            );
          } else {
            // Decompose flattens nested objects into dot-paths, preserving field ops verbatim.
            // A single separateFieldOps pass after flattening catches both top-level and nested ops.
            const update = decomposePatch(data, this as AtscriptDbTable);
            const ops = separateFieldOps(update);
            const translatedOps = ops ? _translateOpsKeys(ops, this._meta) : undefined;
            const translatedUpdate = this._fieldMapper.translatePatchKeys(update, this._meta);

            // Resolve array ops via read-modify-write if any __$ keys present
            const arrayOpsFields = getArrayOpsFields(translatedUpdate);
            if (arrayOpsFields.size > 0) {
              const current = (await this.adapter.findOne({
                filter: translatedFilter,
                controls: {},
              })) as Record<string, unknown> | null;
              const resolved = resolveArrayOps(translatedUpdate, current, this as AtscriptDbTable);
              result = await this.adapter.updateOne(
                translatedFilter,
                resolved,
                translatedOps,
                expectedVersion,
              );
            } else {
              result = await this.adapter.updateOne(
                translatedFilter,
                translatedUpdate,
                translatedOps,
                expectedVersion,
              );
            }
          }
          matchedCount += result.matchedCount;
          modifiedCount += result.modifiedCount;
        }

        // Phase 3: FROM relation patches
        if (canNest) {
          await batchPatchNestedFrom(host, originals, maxDepth, depth);
        }

        // Phase 4: VIA relation patches
        if (canNest) {
          await batchPatchNestedVia(host, originals, maxDepth, depth);
        }

        return { matchedCount, modifiedCount };
      }),
    );
  }

  /**
   * Batch versioned touch (since 0.1.129): bumps the version of every listed
   * row by exactly one, each row guarded by its own expected version. This is
   * the batch fence `updateMany(orFilter, {})` used to be before 0.1.128 (an
   * empty patch is a no-op since then and takes no lock).
   *
   * Each key carries the primary key field(s) (composite supported) plus the
   * version column and NOTHING else — a touch has no payload. Unique indexes
   * do not identify a touch key. `undefined`-valued properties are ignored,
   * like in every write payload. Empty `keys` → `{ 0, 0 }` without a statement.
   *
   * `require: 'all'` (default): one count over the whole key set runs FIRST;
   * a stale or missing row throws {@link CasMismatchError} before any write.
   * The bumps then run as `updateMany(orFilter, {})` chunks of at most
   * {@link TOUCH_MANY_CHUNK} keys inside one adapter transaction; a summed
   * `matchedCount` short of `keys.length` (a row moved between the count and
   * the bump) throws the same error — SQL engines roll every bump back. The
   * pre-count is therefore a deliberate double check on SQL: it is what makes
   * the guarantee hold on adapters whose `withTransaction` is a passthrough
   * (the memory adapter, a Mongo standalone topology) — there it covers the
   * common stale case and the residual race window is accepted.
   * `require: 'any'`: no pre-count, the honest summed result is returned.
   *
   * No `guard`, no `onWrite`; not exposed over HTTP.
   */
  public async touchMany(
    keys: Array<DbPatch<DataType>>,
    opts?: TTouchManyOptions,
  ): Promise<TDbUpdateResult> {
    this._ensureBuilt();
    const versionField = this._meta.versionField;
    if (versionField === undefined) {
      throw invalidTouchKey("", "touchMany requires @db.column.version");
    }
    if (keys.length === 0) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const pkFields = this.primaryKeys;
    const seen = new Set<string>();
    const pairs: FilterExpr[] = [];
    for (const [i, key] of (keys as Array<Record<string, unknown>>).entries()) {
      const pair: Record<string, unknown> = {};
      for (const pk of pkFields) {
        if (key[pk] === undefined) {
          throw invalidTouchKey(`[${i}].${pk}`, `touchMany: each key must carry its "${pk}"`);
        }
        pair[pk] = key[pk];
      }
      const version = key[versionField];
      if (typeof version !== "number" || !Number.isFinite(version)) {
        throw invalidTouchKey(
          `[${i}].${versionField}`,
          `touchMany: each key must carry its expected "${versionField}" (number)`,
        );
      }
      for (const [prop, value] of Object.entries(key)) {
        if (value !== undefined && prop !== versionField && !(prop in pair)) {
          throw invalidTouchKey(
            `[${i}].${prop}`,
            `touchMany: a touch carries no payload — keys hold the primary key and "${versionField}" only, got "${prop}"`,
          );
        }
      }
      const identity = JSON.stringify(pair);
      if (seen.has(identity)) {
        throw invalidTouchKey(`[${i}]`, `touchMany: duplicate key ${identity}`);
      }
      seen.add(identity);
      pair[versionField] = version;
      pairs.push(pair as FilterExpr);
    }

    const orFilter: FilterExpr = { $or: pairs };
    this._guardMutationFilter(orFilter);
    // Translate the pairs once; the count and every chunk reuse them.
    const translated = (
      this._fieldMapper.translateFilter(orFilter, this._meta) as { $or: FilterExpr[] }
    ).$or;
    const requireAll = (opts?.require ?? "all") === "all";

    if (requireAll) {
      const matched = await this.adapter.count({ filter: { $or: translated }, controls: {} });
      if (matched < keys.length) {
        throw new CasMismatchError(matched, keys.length);
      }
    }

    return this.adapter.withTransaction(async () => {
      let matchedCount = 0;
      let modifiedCount = 0;
      for (let start = 0; start < translated.length; start += TOUCH_MANY_CHUNK) {
        const chunk = translated.slice(start, start + TOUCH_MANY_CHUNK);
        // Direct adapter call: an empty patch on a versioned table renders
        // exactly `SET version = version + 1` (Mongo: `$inc`); the table's
        // own `updateMany` short-circuits empty patches on purpose.
        const result = await this.adapter.updateMany({ $or: chunk }, {}, undefined);
        matchedCount += result.matchedCount;
        modifiedCount += result.modifiedCount;
      }
      if (requireAll && matchedCount !== keys.length) {
        throw new CasMismatchError(matchedCount, keys.length);
      }
      return { matchedCount, modifiedCount };
    });
  }

  /**
   * Deletes a single record by any type-compatible identifier — primary key
   * or single-field unique index. Uses the same resolution logic as `findById`.
   *
   * When the adapter does not support native foreign keys (e.g. MongoDB),
   * cascade and setNull actions are applied before the delete.
   *
   * `opts.guard` (since 0.1.128) runs inside the transaction once the id has
   * resolved to a filter, before cascade / delete — see {@link TDeleteOptions}.
   * An id that resolves to no filter answers `{ deletedCount: 0 }` without
   * calling the guard.
   */
  public async deleteOne(id: IdType, opts?: TDeleteOptions<DataType>): Promise<TDbDeleteResult> {
    this._ensureBuilt();
    const filter = this._resolveIdFilter(id, opts);
    if (!filter) {
      return { deletedCount: 0 };
    }
    const guard = opts?.guard;
    const needsCascade = this._integrity.needsCascade(this._cascadeResolver);
    const translated = this._fieldMapper.translateFilter(filter, this._meta);
    const run = async (): Promise<TDbDeleteResult> => {
      if (guard) {
        await guard(new RemoveGuardContext<DataType>(id, filter, this as AtscriptDbTable));
      }
      if (needsCascade) {
        await this._integrity.cascadeBeforeDelete(
          filter,
          this.tableName,
          this._meta,
          this._cascadeResolver!,
          (f) => this._fieldMapper.translateFilter(f, this._meta),
          this.adapter,
        );
      }
      return this.adapter.deleteOne(translated);
    };
    return remapDeleteFkViolation(this.tableName, () =>
      guard || needsCascade ? this.adapter.withTransaction(run) : run(),
    );
  }

  // ── Batch operations ──────────────────────────────────────────────────────

  public async updateMany(
    filter: FilterExpr<FlatType>,
    data: DbPatch<DataType>,
  ): Promise<TDbUpdateResult> {
    this._ensureBuilt();
    this._guardMutationFilter(filter as FilterExpr);
    await this._integrity.validateForeignKeys(
      [data as Record<string, unknown>],
      this._meta,
      this._fkLookupResolver,
      this._writeTableResolver,
      true,
    );
    const dataCopy = _cloneWritePayload(data);
    // updateMany never CAS-checks (locked decision row 2): a single
    // expectedVersion cannot sensibly match N rows with different versions
    // — use bulkUpdate with per-row $cas instead. The auto-bump still
    // happens inside the adapter on every versioned UPDATE. Reject $cas
    // here so callers fail loud instead of silently losing the predicate.
    const versionColumn = this.versionColumn;
    if ("$cas" in dataCopy) {
      throw new DbError("INVALID_QUERY", [
        {
          path: "$cas",
          message:
            "$cas is not supported on updateMany — use bulkUpdate with per-row $cas " +
            "for version-locked batch updates",
        },
      ]);
    }
    if (versionColumn !== undefined) {
      assertNoVersionWrites(dataCopy, versionColumn);
    }
    // Encrypt @db.encrypted fields BEFORE decomposition so the patch carries
    // envelope strings; operator objects on encrypted fields are rejected.
    await this._encryptItems([dataCopy], "patch");
    // Decompose flattens nested merge-strategy objects into dot-paths so that
    // separateFieldOps catches nested ops like { account: { failedLoginAttempts: { $inc: 1 } } }.
    const update = decomposePatch(dataCopy, this as AtscriptDbTable);
    const ops = separateFieldOps(update);
    const translatedOps = ops ? _translateOpsKeys(ops, this._meta) : undefined;
    const translatedUpdate = this._fieldMapper.translatePatchKeys(update, this._meta);
    const translatedFilter = this._fieldMapper.translateFilter(filter as FilterExpr, this._meta);
    // Empty patch: nothing to SET (an empty SET list is a SQL syntax error) and
    // a bulk no-op must not bump versions — report the honest match count only.
    if (translatedOps === undefined && isEmptyObject(translatedUpdate)) {
      const matchedCount = await this.adapter.count({ filter: translatedFilter, controls: {} });
      return { matchedCount, modifiedCount: 0 };
    }
    return enrichFkViolation(this._meta, () =>
      this.adapter.updateMany(translatedFilter, translatedUpdate, translatedOps),
    );
  }

  public async replaceMany(
    filter: FilterExpr<FlatType>,
    data: DbRow<DataType>,
  ): Promise<TDbUpdateResult> {
    this._ensureBuilt();
    this._guardMutationFilter(filter as FilterExpr);
    await this._integrity.validateForeignKeys(
      [data as Record<string, unknown>],
      this._meta,
      this._fkLookupResolver,
      this._writeTableResolver,
    );
    const dataCopy = _cloneWritePayload(data);
    await this._encryptItems([dataCopy], "write");
    return enrichFkViolation(this._meta, () =>
      this.adapter.replaceMany(
        this._fieldMapper.translateFilter(filter as FilterExpr, this._meta),
        this._fieldMapper.prepareForWrite(dataCopy, this._meta, this.adapter),
      ),
    );
  }

  public async deleteMany(filter: FilterExpr<FlatType>): Promise<TDbDeleteResult> {
    this._ensureBuilt();
    this._guardMutationFilter(filter as FilterExpr);
    if (this._integrity.needsCascade(this._cascadeResolver)) {
      return remapDeleteFkViolation(this.tableName, () =>
        this.adapter.withTransaction(async () => {
          await this._integrity.cascadeBeforeDelete(
            filter as FilterExpr,
            this.tableName,
            this._meta,
            this._cascadeResolver!,
            (f) => this._fieldMapper.translateFilter(f, this._meta),
            this.adapter,
          );
          return this.adapter.deleteMany(
            this._fieldMapper.translateFilter(filter as FilterExpr, this._meta),
          );
        }),
      );
    }
    return remapDeleteFkViolation(this.tableName, () =>
      this.adapter.deleteMany(this._fieldMapper.translateFilter(filter as FilterExpr, this._meta)),
    );
  }

  // ── Schema operations ─────────────────────────────────────────────────────

  /**
   * Synchronizes indexes between Atscript definitions and the database.
   */
  public async syncIndexes(): Promise<void> {
    this._ensureBuilt();
    return this.adapter.syncIndexes();
  }

  /**
   * Ensures the table/collection exists in the database.
   */
  public async ensureTable(): Promise<void> {
    this._ensureBuilt();
    return this.adapter.ensureTable();
  }

  // ── Internal: write preparation ───────────────────────────────────────────

  /** Engine-agnostic guard for user-supplied mutation filters (updateMany/deleteMany/…). */
  protected _guardMutationFilter(filter: FilterExpr): void {
    // Encrypted / geo checks first so `ENC_FIELD_*` codes keep firing, then the
    // path guard: a JSON-descendant or unknown path must never reach the driver.
    guardFilter(this._meta, this.adapter, filter);
    guardPaths(this._meta, this.adapter, { filter });
  }

  /**
   * Encrypts `@db.encrypted` field values in place on (already validated)
   * write payloads — between validation and `prepareForWrite`, so adapters
   * only ever see envelope strings.
   *
   * Parent objects along an encrypted path are shallow-cloned before
   * mutation so caller-shared nested objects are never modified.
   *
   * In `patch` mode, operator objects (`$inc`, `$insert`, …) targeting an
   * encrypted field are rejected with `ENC_FIELD_PATCH_OP` — ciphertext is
   * opaque; only plain re-assignment (which re-encrypts) is allowed.
   */
  protected async _encryptItems(
    items: Array<Record<string, unknown>>,
    mode: "write" | "patch",
  ): Promise<void> {
    const enc = this._encryption;
    if (this._meta.encryptedFields.size === 0 || !enc) {
      return;
    }
    for (const item of items) {
      for (const { path, segments, leaf } of this._encryptedPaths) {
        const parent = this._walkToLeafParent(item, segments, true);
        if (!parent) {
          continue;
        }
        const value = parent[leaf];
        if (value === undefined || value === null) {
          continue;
        }
        if (mode === "patch" && _hasOperatorKeys(value)) {
          throw new DbError("ENC_FIELD_PATCH_OP", [
            {
              path,
              message:
                `Operator patch ops are not allowed on encrypted field "${path}" — ` +
                `assign a plain value instead (it re-encrypts)`,
            },
          ]);
        }
        parent[leaf] = await enc.encrypt(value);
      }
    }
  }

  /**
   * Lazy pre-image read for a guard's `current(i)`: `null` when the row has
   * no identifying key (e.g. an auto-increment insert) or the key cannot be
   * resolved — never throws for a missing key.
   * @internal
   */
  async _readPreImage(row: unknown): Promise<DataType | null> {
    if (!row) return null;
    let filter: FilterExpr | null;
    try {
      filter = this._resolveIdFilter(row);
    } catch {
      return null;
    }
    if (!filter) return null;
    return (await this.findOne({ filter, controls: {} } as never)) as DataType | null;
  }

  /**
   * Applies `@db.default` values in place to a row's absent fields — the
   * defaults pass every insert / replace path runs before validation.
   * Static value defaults (`@db.default 'x'`) are filled on EVERY adapter
   * (since 0.1.128 — writing the column's own default explicitly is
   * equivalent to leaving it to the DDL `DEFAULT`, and write guards see the
   * full row). Function defaults (`now` / `uuid` / `increment` / custom) the
   * adapter handles natively are NOT filled — the field stays absent so the
   * engine's own default applies. The version column is never touched.
   */
  protected _applyDefaults(data: Record<string, unknown>): Record<string, unknown> {
    const nativeFns = this.adapter.nativeDefaultFns();
    const versionField = this._meta.versionField;
    for (const [field, def] of this._meta.defaults.entries()) {
      // The version column is adapter-managed (auto-bumped on every write, and
      // initialized at insert time by the adapter when the engine has no DDL
      // DEFAULT). Skipping it here keeps `assertNoVersionWrites` happy on the
      // update/replace paths where the field MUST stay absent from the payload.
      if (field === versionField) continue;
      if (data[field] === undefined) {
        if (def.kind === "value") {
          data[field] = this._parseValueDefault(field, def.value);
        } else if (def.kind === "fn" && !nativeFns.has(def.fn)) {
          switch (def.fn) {
            case "now": {
              data[field] = Date.now();
              break;
            }
            case "uuid": {
              data[field] = crypto.randomUUID();
              break;
            }
            // 'increment' is left to the DB (e.g. INTEGER PRIMARY KEY in SQLite)
          }
        }
      }
    }
    return data;
  }

  /**
   * The JS value for a `@db.default 'literal'`: strings (including unions of
   * string literals) are used as-is, every other design type is parsed as
   * JSON — the same value the SQL adapters put into the DDL `DEFAULT` clause.
   * A literal that is not valid JSON falls back to the raw string so the
   * validator reports it against the field instead of a bare `SyntaxError`.
   */
  private _parseValueDefault(field: string, literal: string): unknown {
    const fieldType = this._meta.flatMap?.get(field);
    const designType = fieldType ? resolveDesignType(fieldType) : "string";
    if (designType === "string") return literal;
    try {
      return JSON.parse(literal) as unknown;
    } catch {
      return literal;
    }
  }

  /**
   * Extracts a record-identifying filter from a payload.
   *
   * Resolution order:
   * 1. Primary key field(s) — if all PK fields are present in the payload.
   * 2. Single-field unique index — first `@db.index.unique` field found.
   * 3. Compound unique index — first compound unique index whose fields are all present.
   *
   * Throws when no identifying fields can be found. With `isFieldVisible`
   * (since 0.1.134), a unique index over a hidden field is skipped, as if it
   * did not exist — see {@link identificationsVisibleTo}.
   */
  protected _extractRecordFilter(
    payload: Record<string, unknown>,
    opts?: TIdResolveOptions,
  ): FilterExpr {
    const pkFields = this.primaryKeys;

    // 1. Try primary key
    if (pkFields.length > 0) {
      let allPresent = true;
      for (const field of pkFields) {
        if (payload[field] === undefined) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) {
        const filter: FilterExpr = {};
        for (const field of pkFields) {
          filter[field] = this._prepareFilterValue(field, payload[field]);
        }
        return filter;
      }
    }

    const identifications = this.identificationsVisibleTo(opts?.isFieldVisible);

    // 2. Try single-field unique index (in `uniqueProps` order)
    const singleFields = new Set<string>();
    for (const ident of identifications) {
      if (ident.source !== "primaryKey" && ident.fields.length === 1) {
        singleFields.add(ident.fields[0]!);
      }
    }
    for (const prop of this.uniqueProps) {
      if (singleFields.has(prop) && payload[prop] !== undefined) {
        return { [prop]: this._prepareFilterValue(prop, payload[prop]) };
      }
    }

    // 3. Try compound unique indexes
    for (const ident of identifications) {
      if (ident.source === "primaryKey" || ident.fields.length < 2) {
        continue;
      }
      if (ident.fields.every((field) => payload[field] !== undefined)) {
        const filter: FilterExpr = {};
        for (const field of ident.fields) {
          filter[field] = this._prepareFilterValue(field, payload[field]);
        }
        return filter;
      }
    }

    // Nothing found — throw
    if (pkFields.length === 0) {
      throw new DbError("NOT_FOUND", [
        { path: "", message: "No primary key defined — cannot extract filter" },
      ]);
    }
    throw new DbError("NOT_FOUND", [
      { path: pkFields[0], message: `Missing primary key field "${pkFields[0]}" in payload` },
    ]);
  }

  private _prepareFilterValue(field: string, value: unknown): unknown {
    const fieldType = this.flatMap.get(field);
    return fieldType ? this.adapter.prepareId(value, fieldType) : value;
  }

  /**
   * Lazy — builds a `normalized-path → from-depth` map from `this._meta.flatMap`
   * on first use. Only paths reachable through an unbroken chain of `db.rel.from`
   * nav fields from the root are included (chains crossing `to`/`via` are excluded).
   */
  private _getFromDepthMap(): ReadonlyMap<string, number> {
    if (!this._fromDepthMap) {
      const out = new Map<string, number>();
      for (const [path, def] of this._meta.flatMap) {
        const md = def.metadata;
        if (!md?.has("db.rel.from")) continue;
        const segments = path.split(".");
        let prefix = "";
        let depth = 0;
        let valid = true;
        for (let i = 0; i < segments.length; i++) {
          prefix = prefix ? `${prefix}.${segments[i]}` : segments[i]!;
          const pdef = this._meta.flatMap.get(prefix);
          const pmd = pdef?.metadata;
          if (pmd?.has("db.rel.to") || pmd?.has("db.rel.via")) {
            valid = false;
            break;
          }
          if (pmd?.has("db.rel.from")) depth++;
        }
        if (valid) out.set(path, depth);
      }
      this._fromDepthMap = out;
    }
    return this._fromDepthMap;
  }

  /**
   * Populate the depth-limit bundle on a `DbValidationContext`. Only the root
   * write call (`depth === 0`) enforces — nested re-entries leave `depthCheck`
   * unset so the full tree is validated once at the root.
   */
  private _applyDepthCtx(ctx: DbValidationContext, depth: number): void {
    if (depth !== 0 || this._meta.navFields.size === 0) return;
    ctx.depthCheck = {
      limit: (this.type.metadata.get("db.depth.limit") as number | undefined) ?? 0,
      fromDepthMap: this._getFromDepthMap(),
    };
  }

  /**
   * Pre-validate items (type validation + FK constraints) without inserting them.
   * Used by parent tables to validate FROM children before the main insert,
   * ensuring errors are caught before the parent is committed.
   *
   * @param opts.excludeFkTargetTable - Skip FK validation to this table (the parent).
   */
  public async preValidateItems(
    items: Array<Record<string, unknown>>,
    opts?: { excludeFkTargetTable?: string },
  ): Promise<void> {
    this._ensureBuilt();

    // Type + FK pre-validation only. Depth is authoritatively checked at the
    // root write call against the root table's `@db.depth.limit`; re-applying
    // the child's own limit here would reject children whose own table is
    // unannotated but whose parent's limit admits them.
    const validator = this.getValidator("insert");
    const ctx: DbValidationContext = { mode: "insert", navFields: this._meta.navFields };
    // Children arrive from an already deep-pruned root payload: own keys only.
    const prepared = items.map((raw) => this._applyDefaults(_shallowPrunedClone(raw)));
    validateBatch(validator, prepared, ctx);

    // FK validation
    await this._integrity.validateForeignKeys(
      items,
      this._meta,
      this._fkLookupResolver,
      this._writeTableResolver,
      false,
      opts?.excludeFkTargetTable,
    );
  }

  // ── Internal: validator building ──────────────────────────────────────────

  /**
   * Builds a validator for a given purpose with adapter plugins.
   *
   * Uses annotation-based `replace` callback to make `@meta.id` and
   * `@db.default` fields optional — works at all nesting levels
   * (including inside nav field target types).
   */
  protected _buildValidator(purpose: string): Validator<T, DataType> {
    const adapterPlugins = this.adapter.getValidatorPlugins();

    // Standard modes use the shared builder — the same one `@atscript/db-client`
    // runs, so server and client preflight cannot drift. Server-managed fields
    // (`@db.default*`, `@db.rel.FK`, `@db.column.version`) are accepted when
    // absent by the shared plugin's skip list, at every nesting depth.
    if (purpose === "insert" || purpose === "patch" || purpose === "bulkReplace") {
      const mode: ValidatorMode = purpose === "bulkReplace" ? "replace" : purpose;
      return buildDbValidator(this.type, mode, adapterPlugins) as Validator<T, DataType>;
    }

    // bulkUpdate: path-aware partial — root + nav sub-trees + merge branches stay
    // partial; everything else is strict so a missing required leaf can't reach
    // the storage layer (it'd surface as a NOT NULL violation).
    if (purpose === "bulkUpdate") {
      const plugins = adapterPlugins.length ? [...adapterPlugins, dbPlugin] : [dbPlugin];
      return this.createValidator({
        plugins,
        partial: buildPatchPartial(this._meta.navFields),
        replace: forceNavNonOptional,
      });
    }

    return this.createValidator({ plugins: adapterPlugins });
  }
}
