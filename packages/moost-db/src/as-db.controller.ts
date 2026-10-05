import type { TAtscriptAnnotatedType, TAtscriptDataType } from "@atscript/typescript/utils";
import type {
  AtscriptDbTable,
  FilterExpr,
  TCrudPermissions,
  TDbRemoveGuardContext,
  TDbUpdateResult,
  TDbWriteAction,
  TDbWriteCheckContext,
  TDbWriteGuardContext,
  TDeleteOptions,
  TWriteOptions,
} from "@atscript/db";
import { DbError, isEmptyObject, isPlainObject, reconcileCas } from "@atscript/db";
import { Body, Delete, HttpError, Patch, Post, Put, Query, Url } from "@moostjs/event-http";
import { Inherit, Inject, Moost, Optional, Param } from "moost";

import { AsDbReadableController } from "./as-db-readable.controller";
import { TABLE_DEF } from "./decorators";
import { badRequest, errorEnvelope } from "./http-errors";

const SHAPE_MESSAGE = "Expected an object";

/**
 * Shape gate (since 0.1.128): a write body must be a plain object (single
 * actions) or an array of plain objects (`*Many`). Anything else — `null`, a
 * primitive, `[1, "x"]` — is rejected with the validator envelope BEFORE any
 * hook runs, so `onWrite` / `guardWrite` never see a non-object.
 */
function assertWriteShape(payload: unknown): void {
  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i++) {
      if (!isPlainObject(payload[i])) throw badRequest(`[${i}]`, SHAPE_MESSAGE);
    }
    return;
  }
  if (!isPlainObject(payload)) throw badRequest("", SHAPE_MESSAGE);
}

/** `true` when `data` still has the shape the endpoint received (object, or array of objects for `*Many`). */
function hasWriteShape(data: unknown, many: boolean): boolean {
  if (!many) return isPlainObject(data);
  return Array.isArray(data) && data.every(isPlainObject);
}

/**
 * Full CRUD database controller for Moost that works with any `AtscriptDbTable` +
 * `BaseDbAdapter`. Extends {@link AsDbReadableController} with write operations.
 *
 * Subclass and provide the table via DI:
 * ```ts
 * ‎@TableController(usersTable)
 * export class UsersController extends AsDbController<typeof UserModel> {}
 * ```
 *
 * ### Write pipeline (since 0.1.128)
 *
 * ```
 * prepareRequest (when implemented) → shape gate (400)
 *   → onWrite / onRemove (outside any transaction)
 *   → table op — the table's own transaction: validate → guardWrite / guardRemove
 *                (only when overridden) → re-validate → write → nested phases
 *                → checkWrite (only when overridden)
 *   → 404 / 409 disambiguation
 * ```
 *
 * The guard is the table's `guard` write option (`TWriteOptions.guard` /
 * `TDeleteOptions.guard`); overriding `guardWrite` / `guardRemove` is the
 * switch that passes it. `checkWrite` is the `check` write option, with
 * the same switch (since 0.1.143). Built-in failures are THROWN as `HttpError`
 * (wire-identical to returning them; a throw also rolls back a user-level
 * `withTransaction` wrapper).
 */
@Inherit()
export class AsDbController<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
> extends AsDbReadableController<T, DataType> {
  // `.table` (writable accessor) is inherited from AsDbReadableController —
  // guarded there with an instanceof check instead of this class's old cast.

  constructor(
    app: Moost,
    @Inject(TABLE_DEF)
    @Optional()
    table?: AtscriptDbTable<T>,
  ) {
    super(app, table);
    const proto = AsDbController.prototype as AsDbController;
    this._writeArgs = this._hookArgs<TWriteOptions<any>>(
      this.guardWrite !== proto.guardWrite
        ? (ctx: TDbWriteGuardContext<DataType>) => this.guardWrite(ctx)
        : undefined,
      this.checkWrite !== proto.checkWrite
        ? (ctx: TDbWriteCheckContext) => this.checkWrite(ctx)
        : undefined,
    );
    this._removeArgs = this._hookArgs<TDeleteOptions<any>>(
      this.guardRemove !== proto.guardRemove
        ? (ctx: TDbRemoveGuardContext<DataType>) => this.guardRemove(ctx)
        : undefined,
    );
  }

  protected override buildCrud(): TCrudPermissions {
    return {
      ...super.buildCrud(),
      // `insert` lists the POST controls: `onConflict` (`?$onConflict=ignore`,
      // since 0.1.148) when the adapter implements `insertManyIgnore`.
      insert: this.readable.dbAdapter?.supportsInsertIgnore() ? ["onConflict"] : [],
      update: [],
      replace: [],
      remove: [],
    };
  }

  // ── Hooks (overridable) ────────────────────────────────────────────────

  /**
   * Intercepts write operations with the UNTRUSTED body (after the shape gate:
   * an object, or an array of objects). Runs outside any transaction. Return
   * the data in the shape received — an object, or an array of objects for
   * the `*Many` actions; anything else (including `undefined`) aborts with
   * 500 "Not saved". Return an `Error` instance to respond with that error
   * (since 0.1.128 — previously passed on as data); throw to respond with
   * the thrown error's status. May be async (e.g. to enrich payloads from
   * session / permissions).
   */
  protected onWrite(action: TDbWriteAction, data: unknown): unknown {
    return data;
  }

  /**
   * Intercepts delete operations. Receives the id {@link resolveRowIds}
   * resolved (the one the request carried when it is not overridden; since
   * 0.1.148). Return `undefined` to abort (500 "Not
   * deleted"); return an `Error` instance to respond with that error.
   * Runs outside any transaction. May be async (e.g. to resolve composite
   * ids from external state).
   */
  protected onRemove(id: unknown): unknown {
    return id;
  }

  /**
   * Validated-stage write guard (since 0.1.128). Overriding it is the switch:
   * the override is passed to the table as its `guard` write option and runs
   * once inside the table's own transaction, after defaults + validation and
   * before encryption / nested-relation phases. `ctx.rows` are the validated
   * rows (defaults applied on insert/replace; `$cas` removed on update) and
   * may be enriched in place — the table validates them again afterwards.
   * Reject by throwing (an `HttpError` is recommended): the transaction rolls
   * back and the error propagates unchanged. Unmodified controllers pass no
   * guard and pay nothing.
   *
   * Do not swallow `DbError`s (on PostgreSQL the transaction is aborted after
   * a failed statement), and do not await external I/O on SQLite (the guard
   * holds the connection). On MongoDB replica sets the transaction callback —
   * and therefore this guard — may run more than once on transient errors.
   */
  protected guardWrite(_ctx: TDbWriteGuardContext<DataType>): void | Promise<void> {}

  /**
   * Validated-stage remove guard (since 0.1.128). Same switch semantics as
   * {@link guardWrite}: the override becomes `deleteOne`'s `guard` option and
   * runs inside the table's transaction once `onRemove`'s id resolved to a
   * filter. A missing row still reaches the guard — `ctx.current()` resolves
   * to `null` and the 404 comes after the guard; only an id that cannot be
   * resolved to a filter at all (malformed for the key type) is a 404 before
   * the guard.
   */
  protected guardRemove(_ctx: TDbRemoveGuardContext<DataType>): void | Promise<void> {}

  /**
   * Post-write check (since 0.1.143) — a row-level "WITH CHECK". Overriding it
   * is the switch (as with {@link guardWrite}): the override is passed to the
   * table as its `check` write option and runs once per insert / replace /
   * update call (bulk forms included), inside the table's transaction, AFTER
   * the main write and every nested-relation phase. `ctx.filters` holds one
   * exact primary-key filter per written row; `ctx.count(filter)` counts
   * inside the same transaction — e.g. verify every written row still matches
   * a policy filter:
   *
   * ```ts
   * protected async checkWrite(ctx: TDbWriteCheckContext) {
   *   const n = await ctx.count({ $and: [{ $or: ctx.filters }, tenantFilter()] })
   *   if (n !== ctx.filters.length) throw new HttpError(403)
   * }
   * ```
   *
   * Throw to reject: the transaction rolls back and the error propagates
   * unchanged. When `ctx.transactional` is `false` (the adapter's
   * transaction is a pass-through, e.g. a standalone MongoDB) the write is
   * already durable — validate before the write instead (`guardWrite`).
   * Removes have no post-image and never call it.
   */
  protected checkWrite(_ctx: TDbWriteCheckContext): void | Promise<void> {}

  // ── Transactions ───────────────────────────────────────────────────────

  /**
   * Runs `fn` inside the bound table's adapter transaction (nested calls
   * join it). For custom actions and routes that need one transaction across
   * several table operations.
   */
  protected withTransaction<R>(fn: () => Promise<R>): Promise<R> {
    return this.table.getAdapter().withTransaction(fn);
  }

  // ── Write pipeline internals ───────────────────────────────────────────

  // The controller's `DataType` and the table's `TAtscriptDataType<T>` are the
  // same type by default but independent generics, so the options are typed
  // loosely here and narrowed at the guard signature.

  /** The table write call's trailing options — see {@link _hookArgs}. */
  private readonly _writeArgs: [] | [TWriteOptions<any>];
  /** `deleteOne`'s trailing options — see {@link _hookArgs}. */
  private readonly _removeArgs: [] | [TDeleteOptions<any>];

  /**
   * A table call's trailing options, built once: `guard` / `check` only when
   * the matching hook is overridden, `isFieldVisible` only when `hasField`
   * is (an id or a PK-less payload never resolves through a hidden unique
   * key) — else nothing, so an unmodified controller calls the table exactly
   * as before.
   */
  private _hookArgs<O extends TWriteOptions<any> | TDeleteOptions<any>>(
    guard: O["guard"] | undefined,
    check?: TWriteOptions<any>["check"],
  ): [] | [O] {
    const opts = { ...this._idOpts } as O;
    if (guard) opts.guard = guard;
    if (check) (opts as TWriteOptions<any>).check = check;
    return isEmptyObject(opts as Record<string, unknown>) ? [] : [opts];
  }

  /** Resolves a hook result: `undefined` aborts with `abortMessage`, an `Error` is thrown, anything else passes. */
  private async _checkHook(pending: unknown, abortMessage: string): Promise<unknown> {
    const result = await pending;
    if (result === undefined) {
      throw new HttpError(500, abortMessage);
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }

  /** Runs `onWrite` and re-applies the shape gate to its output (a non-object is a 500 "Not saved"). */
  private async _writeBody(
    action: TDbWriteAction,
    payload: unknown,
    many: boolean,
  ): Promise<Record<string, unknown> | Array<Record<string, unknown>>> {
    const data = await this._checkHook(this.onWrite(action, payload), "Not saved");
    if (!hasWriteShape(data, many)) {
      throw new HttpError(500, "Not saved");
    }
    return data as Record<string, unknown> | Array<Record<string, unknown>>;
  }

  /**
   * Normalises the OCC shape of one write item in place through the shared
   * `reconcileCas` (since 0.1.128): a top-level `version` field in a write
   * body is a `$cas` directive, not a SET — it is lifted to
   * `$cas: { [versionColumn]: version }`; a raw SDK-shaped `$cas` is accepted
   * as sent; both present with different values → 400 at `$cas`; a malformed
   * `$cas` reports `separateCas`'s own message. Returns `true` iff the item is
   * CAS-bearing — callers use this to gate the 404/409 disambiguation
   * `findOne` on `matchedCount === 0`. On a non-versioned table nothing is
   * lifted and a raw `$cas` reaches the table, which rejects it.
   */
  private _resolveCas(
    item: Record<string, unknown>,
    versionColumn: string | undefined,
    pathPrefix = "",
  ): boolean {
    if (versionColumn === undefined) return false;
    try {
      return reconcileCas(item, versionColumn, "cas") !== undefined;
    } catch (error) {
      if (error instanceof DbError) {
        throw errorEnvelope(
          400,
          error.message,
          error.errors.map((e) => ({ path: `${pathPrefix}${e.path}`, message: e.message })),
        );
      }
      throw error;
    }
  }

  /**
   * Bulk auto-lift: each item carries its own `version` → `$cas`.
   * NOTE: per-item conflict disambiguation in the response body is deferred
   * (§6.4) — the aggregate `{ matchedCount, modifiedCount }` surfaces partial
   * application; callers can detect mismatches via `modifiedCount < N`.
   */
  private _resolveBulkCas(
    rows: Array<Record<string, unknown>>,
    versionColumn: string | undefined,
  ): void {
    if (versionColumn === undefined) return;
    for (let i = 0; i < rows.length; i++) {
      this._resolveCas(rows[i]!, versionColumn, `[${i}].`);
    }
  }

  /**
   * Deletes by id (guard forwarded when overridden) and maps "nothing
   * deleted" to 404. Since 0.1.143 the row overlay ({@link rowOverlay}) is
   * the delete's `scope`: the id is pinned among in-scope rows inside the
   * table's transaction and an out-of-scope row is not deleted — a 404,
   * exactly like a missing one.
   */
  private async _deleteOrThrow(id: unknown, scope: FilterExpr | undefined): Promise<unknown> {
    const args: [] | [TDeleteOptions<any>] = scope
      ? [{ ...this._removeArgs[0], scope }]
      : this._removeArgs;
    const result = await this.table.deleteOne(id as never, ...args);
    if (result.deletedCount < 1) {
      throw new HttpError(404);
    }
    return result;
  }

  // ── Write Endpoints ─────────────────────────────────────────────────────

  /**
   * **POST /** — inserts one or many records.
   *
   * `?$onConflict=ignore` (since 0.1.148) skips rows colliding on the primary
   * key or a unique index instead of answering 409. The response then is
   * `{ insertedId?, conflict }` for an object body and
   * `{ insertedCount, insertedIds, inserted, conflicts }` for an array body.
   * Any other `$` control on POST answers 400.
   */
  @Post("")
  async insert(@Body() payload: unknown, @Url() url?: string): Promise<unknown> {
    const { controls } = await this.parseRequest("insert", url ?? "");
    const onConflict = this._readOnConflict(controls);
    assertWriteShape(payload);
    const args: [] | [TWriteOptions<any>] = onConflict
      ? [{ ...this._writeArgs[0], onConflict } as TWriteOptions<any>]
      : this._writeArgs;
    if (Array.isArray(payload)) {
      const rows = await this._writeBody("insertMany", payload, true);
      return this.table.insertMany(rows as never, ...(args as []));
    }
    const row = await this._writeBody("insert", payload, false);
    return this.table.insertOne(row as never, ...(args as []));
  }

  /** The only POST control: `$onConflict` (`error` | `ignore`). Anything else `$…` → 400. */
  private _readOnConflict(controls: Record<string, unknown>): "ignore" | undefined {
    for (const key of Object.keys(controls)) {
      if (key !== "$onConflict") throw badRequest("", `Unsupported control "${key}" on insert`);
    }
    const mode = controls.$onConflict;
    if (mode !== undefined && mode !== "error" && mode !== "ignore") {
      throw badRequest("", `$onConflict must be "error" or "ignore", got ${JSON.stringify(mode)}`);
    }
    return mode === "ignore" ? "ignore" : undefined;
  }

  /**
   * **PUT /** — fully replaces one or many records matched by primary key.
   *
   * When the table opts into OCC (`@db.column.version`), a top-level `version`
   * field in the body is auto-lifted to `$cas` (§6.2 of VERSION_PROPOSAL.md);
   * a raw `$cas` is accepted as sent. On `matchedCount === 0` for a
   * CAS-bearing write, this disambiguates 404 (row gone) vs 409 (version
   * mismatch) via a single `findOne` after the table call.
   */
  @Put("")
  async replace(@Body() payload: unknown): Promise<unknown> {
    await this.parseRequest("replace");
    assertWriteShape(payload);
    const versionColumn = this.table.versionColumn;

    if (Array.isArray(payload)) {
      const rows = (await this._writeBody("replaceMany", payload, true)) as Array<
        Record<string, unknown>
      >;
      this._resolveBulkCas(rows, versionColumn);
      return this.table.bulkReplace(rows as never, ...this._writeArgs);
    }

    const row = (await this._writeBody("replace", payload, false)) as Record<string, unknown>;
    const hadCas = this._resolveCas(row, versionColumn);
    const result = (await this.table.replaceOne(
      row as never,
      ...this._writeArgs,
    )) as TDbUpdateResult;
    if (hadCas && result.matchedCount === 0) {
      throw await this._disambiguateMismatch(row, versionColumn!);
    }
    return result;
  }

  /**
   * **PATCH /** — partially updates one or many records matched by primary key.
   *
   * Same OCC semantics as {@link replace} (§6.2 / §6.3). A PK-only body
   * carrying `version` (or `$cas`) is a real write — the "versioned touch":
   * the CAS statement executes and bumps the version on a hit.
   */
  @Patch("")
  async update(@Body() payload: unknown): Promise<unknown> {
    await this.parseRequest("update");
    assertWriteShape(payload);
    const versionColumn = this.table.versionColumn;

    if (Array.isArray(payload)) {
      const rows = (await this._writeBody("updateMany", payload, true)) as Array<
        Record<string, unknown>
      >;
      this._resolveBulkCas(rows, versionColumn);
      return this.table.bulkUpdate(rows as never, ...this._writeArgs);
    }

    const row = (await this._writeBody("update", payload, false)) as Record<string, unknown>;
    const hadCas = this._resolveCas(row, versionColumn);
    const result = (await this.table.updateOne(
      row as never,
      ...this._writeArgs,
    )) as TDbUpdateResult;
    if (hadCas && result.matchedCount === 0) {
      throw await this._disambiguateMismatch(row, versionColumn!);
    }
    return result;
  }

  /**
   * Disambiguates a `matchedCount === 0` result on a CAS-protected write:
   * returns 404 when the row is genuinely missing, 409 with
   * `{ error: "version_mismatch", currentVersion: N }` when it's present
   * but the supplied version is stale (§6.3). Callers throw the result.
   *
   * The row is the one the write targeted (since 0.1.143): the table's
   * `recordFilter` — the write's own resolution, primary key first — so a
   * payload carrying the full primary key addresses that row only, never a
   * different row that merely shares a unique value with the payload.
   * Tables without it (partial mocks) resolve through {@link resolveRowFilter}.
   */
  protected async _disambiguateMismatch(data: unknown, versionColumn: string): Promise<HttpError> {
    const table = this.table;
    let filter: FilterExpr | null;
    if (typeof (table as Partial<typeof table>).recordFilter === "function") {
      try {
        filter = table.recordFilter(data as Record<string, unknown>, this._idOpts);
      } catch (error) {
        if (!(error instanceof DbError) || error.code === "SPACE_CLOSED") throw error;
        filter = null; // no identifying fields → nothing to report but a 404
      }
    } else {
      filter = await this.resolveRowFilter(data);
    }
    const row = filter
      ? ((await table.findOne({ filter, controls: {} } as any)) as Record<string, unknown> | null)
      : null;
    if (row === null) {
      return new HttpError(404);
    }
    // NOTE: VERSION_PROPOSAL.md §6.3 specifies `{ error: "version_mismatch",
    // currentVersion: N }`. The Wooks `HttpError.body` getter forcibly
    // overrides `error` with the canonical HTTP status text ("Conflict") and
    // `statusCode` with the constructor's code, so we can't ship the proposal's
    // exact `error` key. The rendered body becomes
    // `{ statusCode: 409, message: "version_mismatch", error: "Conflict",
    //   kind: "version_mismatch", currentVersion: N }`.
    // Clients discriminate on `message` (or the explicit `kind` field) plus
    // `currentVersion`. The framework constraint is upstream of this package.
    return new HttpError(409, {
      message: "version_mismatch",
      statusCode: 409,
      kind: "version_mismatch",
      currentVersion: row[versionColumn] as number,
    });
  }

  /**
   * **DELETE /:id** — removes a single record by primary key.
   */
  @Delete(":id")
  async remove(@Param("id") id: string): Promise<unknown> {
    await this.parseRequest("remove");
    const { id: resolved, overlay } = await this._resolveWithOverlay(id, "remove");
    const resolvedId = await this._checkHook(this.onRemove(resolved), "Not deleted");
    return this._deleteOrThrow(resolvedId, overlay);
  }

  /**
   * **DELETE /?field1=val1&field2=val2** — removes a record by composite key
   * (composite primary key or compound unique index).
   */
  @Delete("")
  async removeComposite(@Query() query: Record<string, string>): Promise<unknown> {
    await this.parseRequest("remove");
    const idObj = this.extractIdShape(query);
    if (idObj instanceof HttpError) {
      throw idObj;
    }
    const { id: resolved, overlay } = await this._resolveWithOverlay(idObj, "remove");
    const resolvedId = await this._checkHook(this.onRemove(resolved), "Not deleted");
    return this._deleteOrThrow(resolvedId, overlay);
  }
}
