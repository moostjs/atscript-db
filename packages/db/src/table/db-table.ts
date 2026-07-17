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
import { DbError } from "../db-error";
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
  TCascadeResolver,
  TDbDeleteResult,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbUpdateResult,
  TFkLookupResolver,
  TTableResolver,
  TWriteTableResolver,
} from "../types";

import { guardFilter } from "../query/query-guards";

export { resolveDesignType } from "./db-readable";

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

/** Zero-allocation emptiness check for objects. */
function _isEmptyObj(obj: Record<string, unknown>): boolean {
  for (const _ in obj) return false;
  return true;
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

export class AtscriptDbTable<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
  FlatType = FlatOf<T>,
  A extends BaseDbAdapter = BaseDbAdapter,
  IdType = PrimaryKeyOf<T>,
  OwnProps = OwnPropsOf<T>,
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
    payload: Partial<DataType> & Record<string, unknown>,
    opts?: { maxDepth?: number },
  ): Promise<TDbInsertResult> {
    const result = await this.insertMany([payload], opts);
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
   */
  public async insertMany(
    payloads: Array<Partial<DataType> & Record<string, unknown>>,
    opts?: { maxDepth?: number },
  ): Promise<TDbInsertManyResult> {
    this._ensureBuilt();
    const { _depth, maxDepth: userMax } = (opts ?? {}) as { _depth?: number; maxDepth?: number };
    const maxDepth = userMax ?? 3;
    const depth = _depth ?? 0;
    const canNest = depth < maxDepth && this._writeTableResolver && this._meta.navFields.size > 0;
    if (!canNest && this._meta.navFields.size > 0) {
      checkDepthOverflow(payloads as Array<Record<string, unknown>>, maxDepth, this._meta);
    }

    return enrichFkViolation(this._meta, () =>
      this.adapter.withTransaction(async () => {
        // Clone + apply defaults (keep originals for FROM phase)
        const items = payloads.map((p) => this._applyDefaults({ ...p }));

        // Validate full payload (including nav fields) before any writes.
        // Depth is only enforced at the root call — nested-writer re-entries
        // already had their full tree validated upstream.
        const validator = this.getValidator("insert");
        const ctx: DbValidationContext = { mode: "insert", navFields: this._meta.navFields };
        this._applyDepthCtx(ctx, depth);
        validateBatch(validator, items, ctx);

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
          await preValidateNestedFrom(host, payloads as Array<Record<string, unknown>>);
        }

        // Phase 2: Batch main insert
        const result = await this.adapter.insertMany(prepared);

        // Phase 3: Batch FROM dependents (they need our PKs)
        if (canNest) {
          await batchInsertNestedFrom(
            host,
            payloads as Array<Record<string, unknown>>,
            result.insertedIds,
            maxDepth,
            depth,
          );
        }

        // Phase 4: Batch VIA relations (insert targets + junction entries)
        if (canNest) {
          await batchInsertNestedVia(
            host,
            payloads as Array<Record<string, unknown>>,
            result.insertedIds,
            maxDepth,
            depth,
          );
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
    payload: DataType & Record<string, unknown>,
    opts?: { maxDepth?: number },
  ): Promise<TDbUpdateResult> {
    return this.bulkReplace([payload], opts);
  }

  /**
   * Replaces multiple records with deep nested relation support.
   *
   * Supports all relation types (TO, FROM, VIA). TO dependencies are
   * replaced first (their PKs become our FKs), FROM dependents are replaced
   * after (they receive our PKs as their FKs), VIA relations clear and
   * re-create junction rows. Fully recursive up to `maxDepth` (default 3).
   */
  public async bulkReplace(
    payloads: Array<DataType & Record<string, unknown>>,
    opts?: { maxDepth?: number },
  ): Promise<TDbUpdateResult> {
    this._ensureBuilt();
    const maxDepth = opts?.maxDepth ?? 3;
    const depth = (opts as { _depth?: number })?._depth ?? 0;
    const canNest = depth < maxDepth && this._writeTableResolver && this._meta.navFields.size > 0;
    if (!canNest && this._meta.navFields.size > 0) {
      checkDepthOverflow(payloads as Array<Record<string, unknown>>, maxDepth, this._meta);
    }

    return enrichFkViolation(this._meta, () =>
      this.adapter.withTransaction(async () => {
        // Phase 0: Setup — extract $cas FIRST (on raw payload clones) so OCC state
        // never leaks into _applyDefaults, then apply defaults, then validate.
        // Hoist versionColumn — constant per table; one lookup serves the whole batch.
        const versionColumn = this.versionColumn;
        const expectedVersions: Array<number | undefined> = Array.from({
          length: payloads.length,
        });
        const items = payloads.map((p, i) => {
          const clone = { ...p } as Record<string, unknown>;
          expectedVersions[i] = separateCas(clone, versionColumn);
          return this._applyDefaults(clone);
        });
        const originals = canNest ? payloads.map((p) => ({ ...p })) : [];

        const validator = this.getValidator("bulkReplace");
        const ctx: DbValidationContext = { mode: "replace", navFields: this._meta.navFields };
        this._applyDepthCtx(ctx, depth);
        validateBatch(validator, items, ctx);

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
          const filter = this._extractRecordFilter(data);
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
    payload: Partial<DataType> & Record<string, unknown>,
    opts?: { maxDepth?: number },
  ): Promise<TDbUpdateResult> {
    return this.bulkUpdate([payload], opts);
  }

  /**
   * Partially updates multiple records with deep nested relation support.
   *
   * Only TO relations (1:1, N:1) are supported for patching. FROM/VIA
   * relations will error — use {@link bulkReplace} for those.
   * Recursive up to `maxDepth` (default 3).
   */
  public async bulkUpdate(
    payloads: Array<Partial<DataType> & Record<string, unknown>>,
    opts?: { maxDepth?: number },
  ): Promise<TDbUpdateResult> {
    this._ensureBuilt();
    const maxDepth = opts?.maxDepth ?? 3;
    const depth = (opts as { _depth?: number })?._depth ?? 0;
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
        // Work on a local `cloned` array so the caller's payload array (and
        // payload objects) are never mutated.
        const versionColumn = this.versionColumn;
        const expectedVersions: Array<number | undefined> = Array.from({
          length: payloads.length,
        });
        const cloned: Array<Record<string, unknown>> = payloads.map((p, i) => {
          const c = { ...p } as Record<string, unknown>;
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
          const filter = this._extractRecordFilter(data);

          // Strip filter keys from data — they identify the record, not in the SET clause
          for (const key of Object.keys(filter)) {
            delete data[key];
          }

          // Reject direct writes to the version column (server-managed).
          if (versionColumn !== undefined) {
            assertNoVersionWrites(data, versionColumn);
          }

          // Skip if nothing left to update (e.g. only nav props + PK in payload)
          if (_isEmptyObj(data)) {
            matchedCount += 1;
            modifiedCount += 0;
            continue;
          }

          let result: TDbUpdateResult;
          const translatedFilter = this._fieldMapper.translateFilter(filter, this._meta);
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
   * Deletes a single record by any type-compatible identifier — primary key
   * or single-field unique index. Uses the same resolution logic as `findById`.
   *
   * When the adapter does not support native foreign keys (e.g. MongoDB),
   * cascade and setNull actions are applied before the delete.
   */
  public async deleteOne(id: IdType): Promise<TDbDeleteResult> {
    this._ensureBuilt();
    const filter = this._resolveIdFilter(id);
    if (!filter) {
      return { deletedCount: 0 };
    }
    if (this._integrity.needsCascade(this._cascadeResolver)) {
      return remapDeleteFkViolation(this.tableName, () =>
        this.adapter.withTransaction(async () => {
          await this._integrity.cascadeBeforeDelete(
            filter,
            this.tableName,
            this._meta,
            this._cascadeResolver!,
            (f) => this._fieldMapper.translateFilter(f, this._meta),
            this.adapter,
          );
          return this.adapter.deleteOne(this._fieldMapper.translateFilter(filter, this._meta));
        }),
      );
    }
    return remapDeleteFkViolation(this.tableName, () =>
      this.adapter.deleteOne(this._fieldMapper.translateFilter(filter, this._meta)),
    );
  }

  // ── Batch operations ──────────────────────────────────────────────────────

  public async updateMany(
    filter: FilterExpr<FlatType>,
    data: Partial<DataType> & Record<string, unknown>,
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
    const dataCopy = { ...data } as Record<string, unknown>;
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
    return enrichFkViolation(this._meta, () =>
      this.adapter.updateMany(
        this._fieldMapper.translateFilter(filter as FilterExpr, this._meta),
        translatedUpdate,
        translatedOps,
      ),
    );
  }

  public async replaceMany(
    filter: FilterExpr<FlatType>,
    data: Record<string, unknown>,
  ): Promise<TDbUpdateResult> {
    this._ensureBuilt();
    this._guardMutationFilter(filter as FilterExpr);
    await this._integrity.validateForeignKeys(
      [data],
      this._meta,
      this._fkLookupResolver,
      this._writeTableResolver,
    );
    const dataCopy = { ...data };
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
    guardFilter(this._meta, this.adapter, filter);
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
   * Applies default values for fields that are missing from the payload.
   * Defaults handled natively by the DB engine are skipped — the field stays
   * absent so the DB's own DEFAULT clause applies.
   */
  protected _applyDefaults(data: Record<string, unknown>): Record<string, unknown> {
    const nativeValues = this.adapter.supportsNativeValueDefaults();
    const nativeFns = this.adapter.nativeDefaultFns();
    const versionField = this._meta.versionField;
    for (const [field, def] of this._meta.defaults.entries()) {
      // The version column is adapter-managed (auto-bumped on every write, and
      // initialized at insert time by the adapter when the engine has no DDL
      // DEFAULT). Skipping it here keeps `assertNoVersionWrites` happy on the
      // update/replace paths where the field MUST stay absent from the payload.
      if (field === versionField) continue;
      if (data[field] === undefined) {
        if (def.kind === "value" && !nativeValues) {
          const fieldType = this._meta.flatMap?.get(field);
          const designType =
            fieldType?.type.kind === "" && (fieldType.type as { designType: string }).designType;
          data[field] = designType === "string" ? def.value : JSON.parse(def.value);
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
   * Extracts a record-identifying filter from a payload.
   *
   * Resolution order:
   * 1. Primary key field(s) — if all PK fields are present in the payload.
   * 2. Single-field unique index — first `@db.index.unique` field found.
   * 3. Compound unique index — first compound unique index whose fields are all present.
   *
   * Throws when no identifying fields can be found.
   */
  protected _extractRecordFilter(payload: Record<string, unknown>): FilterExpr {
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

    // 2. Try single-field unique index
    for (const prop of this.uniqueProps) {
      if (payload[prop] !== undefined) {
        return { [prop]: this._prepareFilterValue(prop, payload[prop]) };
      }
    }

    // 3. Try compound unique indexes
    for (const index of this._meta.indexes.values()) {
      if (index.type !== "unique" || index.fields.length < 2) {
        continue;
      }
      let allPresent = true;
      for (const indexField of index.fields) {
        if (payload[indexField.name] === undefined) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) {
        const filter: FilterExpr = {};
        for (const indexField of index.fields) {
          filter[indexField.name] = this._prepareFilterValue(
            indexField.name,
            payload[indexField.name],
          );
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
    const prepared = items.map((raw) => this._applyDefaults({ ...raw }));
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

    // Standard modes use the shared builder. The version column is
    // server-managed — make it optional in insert/replace so callers don't
    // have to supply a meaningless value (the adapter auto-sets/auto-bumps).
    if (purpose === "insert" || purpose === "patch" || purpose === "bulkReplace") {
      const mode: ValidatorMode = purpose === "bulkReplace" ? "replace" : purpose;
      const versionField = this._meta.versionField;
      if (versionField !== undefined) {
        const plugins = adapterPlugins.length ? [...adapterPlugins, dbPlugin] : [dbPlugin];
        return this.createValidator({
          plugins,
          partial: mode === "patch" ? buildPatchPartial(this._meta.navFields) : false,
          // Make the version field optional in the type tree (server-managed:
          // the adapter sets it on insert and auto-bumps on update; callers
          // must NOT supply it). The replace callback fires per def node and
          // the validator caches the result.
          replace: (def, path) => {
            const transformed = forceNavNonOptional(def);
            if (path === versionField && !transformed.optional) {
              return { ...transformed, optional: true };
            }
            return transformed;
          },
        });
      }
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
