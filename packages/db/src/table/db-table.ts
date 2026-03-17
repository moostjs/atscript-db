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
import { separateFieldOps, type TFieldOps } from "../ops";
import type { TableMetadata } from "./table-metadata";
import { resolveArrayOps, getArrayOpsFields } from "../patch/array-ops-resolver";
import { decomposePatch } from "../patch/patch-decomposer";
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
import { createDbValidatorPlugin, type DbValidationContext } from "../db-validator-plugin";
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

export { resolveDesignType } from "./db-readable";

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

/**
 * Forces nav fields non-optional so the plugin handles null/undefined
 * checks (validator skips optional+null before plugins run).
 */
function forceNavNonOptional(type: TAtscriptAnnotatedType): TAtscriptAnnotatedType {
  if (
    type.metadata?.has("db.rel.to") ||
    type.metadata?.has("db.rel.from") ||
    type.metadata?.has("db.rel.via")
  ) {
    return type.optional ? { ...type, optional: false } : type;
  }
  return type;
}

/** Makes PK, defaulted, and FK fields optional; forces nav fields non-optional. */
function insertReplace(type: TAtscriptAnnotatedType) {
  if (
    type.metadata?.has("meta.id") ||
    type.metadata?.has("db.default") ||
    type.metadata?.has("db.default.increment") ||
    type.metadata?.has("db.default.uuid") ||
    type.metadata?.has("db.default.now") ||
    type.metadata?.has("db.rel.FK")
  ) {
    return { ...type, optional: true };
  }
  return forceNavNonOptional(type);
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
    const maxDepth = opts?.maxDepth ?? 3;
    const depth = (opts as { _depth?: number })?._depth ?? 0;
    const canNest = depth < maxDepth && this._writeTableResolver && this._meta.navFields.size > 0;
    if (!canNest && this._meta.navFields.size > 0) {
      checkDepthOverflow(payloads as Array<Record<string, unknown>>, maxDepth, this._meta);
    }

    return enrichFkViolation(this._meta, () =>
      this.adapter.withTransaction(async () => {
        // Clone + apply defaults (keep originals for FROM phase)
        const items = payloads.map((p) => this._applyDefaults({ ...p }));

        // Validate full payload (including nav fields) before any writes
        const validator = this.getValidator("insert");
        const ctx: DbValidationContext = { mode: "insert" };
        validateBatch(validator, items, ctx);

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
        // Phase 0: Setup — clone + defaults, validate full payload (including nav fields)
        const items = payloads.map((p) => this._applyDefaults({ ...p }));
        const originals = canNest ? payloads.map((p) => ({ ...p })) : [];

        const validator = this.getValidator("bulkReplace");
        const ctx: DbValidationContext = { mode: "replace" };
        validateBatch(validator, items, ctx);

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

        // Phase 2: Main replace — strip nav fields, prepare, replace each
        let matchedCount = 0;
        let modifiedCount = 0;
        for (const data of items) {
          for (const navField of this._meta.navFields) {
            delete data[navField];
          }
          const filter = this._extractPrimaryKeyFilter(data);
          const prepared = this._fieldMapper.prepareForWrite(data, this._meta, this.adapter);
          const result = await this.adapter.replaceOne(
            this._fieldMapper.translateFilter(filter, this._meta),
            prepared,
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
        // Phase 0: Setup — validate full payload (plugin checks nav field constraints)
        const validator = this.getValidator("bulkUpdate");
        const ctx: DbValidationContext = { mode: "patch", flatMap: this.flatMap };
        validateBatch(validator, payloads as Array<Record<string, unknown>>, ctx);

        // Preserve originals for FROM/VIA phase (nav fields are stripped in Phase 2)
        const originals = canNest ? payloads.map((p) => ({ ...p }) as Record<string, unknown>) : [];

        const host = this as any as TNestedWriterHost;

        // Phase 1: TO relation patches
        if (canNest) {
          await batchPatchNestedTo(
            host,
            payloads as Array<Record<string, unknown>>,
            maxDepth,
            depth,
          );
        }

        // Validate FK references (application-level, for adapters without native FK support)
        await this._integrity.validateForeignKeys(
          payloads as Array<Record<string, unknown>>,
          this._meta,
          this._fkLookupResolver,
          this._writeTableResolver,
          true,
        );

        // Phase 2: Main patch — strip nav fields, separate ops, decompose, update each
        let matchedCount = 0;
        let modifiedCount = 0;
        for (const payload of payloads) {
          const data = { ...payload } as Record<string, unknown>;
          for (const navField of this._meta.navFields) {
            delete data[navField];
          }
          const filter = this._extractPrimaryKeyFilter(data);

          // Strip PK fields from data — they're in the filter, not in the SET clause
          for (const pk of this._meta.primaryKeys) {
            delete data[pk];
          }

          // Separate field ops ($inc/$dec/$mul) — mutates data, returns ops or undefined
          const ops = separateFieldOps(data);

          // Skip if nothing left to update (e.g. only nav props + PK in payload)
          if (_isEmptyObj(data) && !ops) {
            matchedCount += 1;
            modifiedCount += 0;
            continue;
          }

          let result: TDbUpdateResult;
          const translatedFilter = this._fieldMapper.translateFilter(filter, this._meta);
          const translatedOps = ops ? _translateOpsKeys(ops, this._meta) : undefined;
          if (this.adapter.supportsNativePatch()) {
            result = await this.adapter.nativePatch(translatedFilter, data, translatedOps);
          } else {
            const update = decomposePatch(data, this as AtscriptDbTable);
            const translatedUpdate = this._fieldMapper.translatePatchKeys(update, this._meta);

            // Resolve array ops via read-modify-write if any __$ keys present
            const arrayOpsFields = getArrayOpsFields(translatedUpdate);
            if (arrayOpsFields.size > 0) {
              const current = (await this.adapter.findOne({
                filter: translatedFilter,
                controls: {},
              })) as Record<string, unknown> | null;
              const resolved = resolveArrayOps(translatedUpdate, current, this as AtscriptDbTable);
              result = await this.adapter.updateOne(translatedFilter, resolved, translatedOps);
            } else {
              result = await this.adapter.updateOne(
                translatedFilter,
                translatedUpdate,
                translatedOps,
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
    await this._integrity.validateForeignKeys(
      [data as Record<string, unknown>],
      this._meta,
      this._fkLookupResolver,
      this._writeTableResolver,
      true,
    );
    const dataCopy = { ...data } as Record<string, unknown>;
    const ops = separateFieldOps(dataCopy);
    const translatedOps = ops ? _translateOpsKeys(ops, this._meta) : undefined;
    return enrichFkViolation(this._meta, () =>
      this.adapter.updateMany(
        this._fieldMapper.translateFilter(filter as FilterExpr, this._meta),
        this._fieldMapper.prepareForWrite(dataCopy, this._meta, this.adapter),
        translatedOps,
      ),
    );
  }

  public async replaceMany(
    filter: FilterExpr<FlatType>,
    data: Record<string, unknown>,
  ): Promise<TDbUpdateResult> {
    this._ensureBuilt();
    await this._integrity.validateForeignKeys(
      [data],
      this._meta,
      this._fkLookupResolver,
      this._writeTableResolver,
    );
    return enrichFkViolation(this._meta, () =>
      this.adapter.replaceMany(
        this._fieldMapper.translateFilter(filter as FilterExpr, this._meta),
        this._fieldMapper.prepareForWrite({ ...data }, this._meta, this.adapter),
      ),
    );
  }

  public async deleteMany(filter: FilterExpr<FlatType>): Promise<TDbDeleteResult> {
    this._ensureBuilt();
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

  /**
   * Applies default values for fields that are missing from the payload.
   * Defaults handled natively by the DB engine are skipped — the field stays
   * absent so the DB's own DEFAULT clause applies.
   */
  protected _applyDefaults(data: Record<string, unknown>): Record<string, unknown> {
    const nativeValues = this.adapter.supportsNativeValueDefaults();
    const nativeFns = this.adapter.nativeDefaultFns();
    for (const [field, def] of this._meta.defaults.entries()) {
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
   * Extracts primary key field(s) from a payload to build a filter.
   */
  protected _extractPrimaryKeyFilter(payload: Record<string, unknown>): FilterExpr {
    const pkFields = this.primaryKeys;
    if (pkFields.length === 0) {
      throw new DbError("NOT_FOUND", [
        { path: "", message: "No primary key defined — cannot extract filter" },
      ]);
    }
    const filter: FilterExpr = {};
    for (const field of pkFields) {
      if (payload[field] === undefined) {
        throw new DbError("NOT_FOUND", [
          { path: field, message: `Missing primary key field "${field}" in payload` },
        ]);
      }
      const fieldType = this.flatMap.get(field);
      filter[field] = fieldType
        ? this.adapter.prepareId(payload[field], fieldType)
        : payload[field];
    }
    return filter;
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

    // Type validation: apply defaults, validate full payload
    const validator = this.getValidator("insert");
    const ctx: DbValidationContext = { mode: "insert" };
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
    const dbPlugin = createDbValidatorPlugin();
    const plugins = [...this.adapter.getValidatorPlugins(), dbPlugin];

    switch (purpose) {
      case "insert": {
        return this.createValidator({
          plugins,
          replace: insertReplace,
        });
      }
      case "patch": {
        return this.createValidator({
          plugins,
          partial: true,
          replace: forceNavNonOptional,
        });
      }
      case "bulkReplace": {
        return this.createValidator({
          plugins,
          replace: insertReplace,
        });
      }
      case "bulkUpdate": {
        const navFields = this._meta.navFields;
        return this.createValidator({
          plugins,
          // Top level: partial (all fields optional in a patch).
          // Nav fields & their children: always partial (deep patch into related records).
          // Embedded objects: partial only if merge strategy; replace-strategy requires all fields.
          partial: (_def, path) => {
            if (path === "") {
              return true;
            }
            const root = path.split(".")[0];
            if (navFields.has(root)) {
              return true;
            }
            return _def.metadata.get("db.patch.strategy") === "merge";
          },
          replace: forceNavNonOptional,
        });
      }
      default: {
        return this.createValidator({ plugins });
      }
    }
  }
}
