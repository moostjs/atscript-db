import type { TAtscriptAnnotatedType, TAtscriptDataType } from "@atscript/typescript/utils";
import type { AtscriptDbTable, TCrudPermissions, TDbUpdateResult } from "@atscript/db";
import { Body, Delete, HttpError, Patch, Post, Put, Query } from "@moostjs/event-http";
import { Inherit, Inject, Moost, Optional, Param } from "moost";

import { AsDbReadableController } from "./as-db-readable.controller";
import { TABLE_DEF } from "./decorators";

/**
 * Strips the version field from a write body and lifts it to `$cas`, in place.
 * Returns `true` iff a `$cas` predicate was actually attached — callers use
 * this to gate the 404/409 disambiguation `findOne`.
 *
 * Per §6.2 of VERSION_PROPOSAL.md, the moost-db controller treats `version` in
 * a write body as a `$cas` directive rather than a SET. No-op (returns `false`)
 * when:
 * - the payload isn't an object (rejected downstream by the SDK validator),
 * - the version field is absent (presence-based opt-out → last-write-wins),
 * - the value is not a finite number (the SDK will reject loudly via
 *   `$cas` validation — we don't shadow that with a controller-local 400).
 */
function liftVersionToCas(payload: unknown, versionColumn: string): boolean {
  if (payload === null || typeof payload !== "object") return false;
  const obj = payload as Record<string, unknown>;
  if (!(versionColumn in obj)) return false;
  const versionValue = obj[versionColumn];
  if (typeof versionValue !== "number" || !Number.isFinite(versionValue)) return false;
  delete obj[versionColumn];
  obj.$cas = { [versionColumn]: versionValue };
  return true;
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
 */
@Inherit()
export class AsDbController<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
> extends AsDbReadableController<T, DataType> {
  /** Reference to the underlying table (typed for write access). */
  protected get table(): AtscriptDbTable<T> {
    return this.readable as AtscriptDbTable<T>;
  }

  constructor(
    app: Moost,
    @Inject(TABLE_DEF)
    @Optional()
    table?: AtscriptDbTable<T>,
  ) {
    super(app, table);
  }

  protected override buildCrud(): TCrudPermissions {
    return {
      ...super.buildCrud(),
      insert: [],
      update: [],
      replace: [],
      remove: [],
    };
  }

  // ── Hooks (overridable) ────────────────────────────────────────────────

  /**
   * Intercepts write operations. Return `undefined` to abort.
   * May be async (e.g. to enrich payloads from session / permissions).
   */
  protected onWrite(
    action: "insert" | "insertMany" | "replace" | "replaceMany" | "update" | "updateMany",
    data: unknown,
  ): unknown {
    return data;
  }

  /**
   * Intercepts delete operations. Return `undefined` to abort.
   * May be async (e.g. to resolve composite ids from external state).
   */
  protected onRemove(id: unknown): unknown {
    return id;
  }

  // ── Write Endpoints ─────────────────────────────────────────────────────

  /**
   * **POST /** — inserts one or many records.
   */
  @Post("")
  async insert(@Body() payload: unknown): Promise<unknown> {
    if (Array.isArray(payload)) {
      const data = await this.onWrite("insertMany", payload);
      if (data === undefined) {
        return new HttpError(500, "Not saved");
      }
      return await this.table.insertMany(data as any);
    }

    const data = await this.onWrite("insert", payload);
    if (data === undefined) {
      return new HttpError(500, "Not saved");
    }
    return await this.table.insertOne(data as any);
  }

  /**
   * **PUT /** — fully replaces one or many records matched by primary key.
   *
   * When the table opts into OCC (`@db.column.version`), a top-level `version`
   * field in the body is auto-lifted to `$cas` (§6.2 of VERSION_PROPOSAL.md).
   * On `matchedCount === 0` for a CAS-protected write, this disambiguates
   * 404 (row gone) vs 409 (version mismatch) via a single `findOne`.
   */
  @Put("")
  async replace(@Body() payload: unknown): Promise<unknown> {
    const versionColumn = this.table.versionColumn;

    if (Array.isArray(payload)) {
      const data = await this.onWrite("replaceMany", payload);
      if (data === undefined) {
        return new HttpError(500, "Not saved");
      }
      if (versionColumn !== undefined) {
        // Bulk auto-lift: each item carries its own `version` → `$cas`.
        // NOTE: per-item conflict disambiguation in the response body is
        // deferred (§6.4) — the aggregate `{ matchedCount, modifiedCount }`
        // surfaces partial application; callers can detect mismatches via
        // `modifiedCount < N`.
        for (const item of data as unknown[]) {
          liftVersionToCas(item, versionColumn);
        }
      }
      return await this.table.bulkReplace(data as any);
    }

    const data = await this.onWrite("replace", payload);
    if (data === undefined) {
      return new HttpError(500, "Not saved");
    }
    const hadCasLift = versionColumn !== undefined && liftVersionToCas(data, versionColumn);
    const result = (await this.table.replaceOne(data as any)) as TDbUpdateResult;
    if (hadCasLift && result.matchedCount === 0) {
      return await this._disambiguateMismatch(data, versionColumn!);
    }
    return result;
  }

  /**
   * **PATCH /** — partially updates one or many records matched by primary key.
   *
   * Same OCC semantics as {@link replace} (§6.2 / §6.3).
   */
  @Patch("")
  async update(@Body() payload: unknown): Promise<unknown> {
    const versionColumn = this.table.versionColumn;

    if (Array.isArray(payload)) {
      const data = await this.onWrite("updateMany", payload);
      if (data === undefined) {
        return new HttpError(500, "Not saved");
      }
      if (versionColumn !== undefined) {
        // See bulk note on `replace` above — same deferred-disambiguation caveat.
        for (const item of data as unknown[]) {
          liftVersionToCas(item, versionColumn);
        }
      }
      return await this.table.bulkUpdate(data as any);
    }

    const data = await this.onWrite("update", payload);
    if (data === undefined) {
      return new HttpError(500, "Not saved");
    }
    const hadCasLift = versionColumn !== undefined && liftVersionToCas(data, versionColumn);
    const result = (await this.table.updateOne(data as any)) as TDbUpdateResult;
    if (hadCasLift && result.matchedCount === 0) {
      return await this._disambiguateMismatch(data, versionColumn!);
    }
    return result;
  }

  /**
   * Disambiguates a `matchedCount === 0` result on a CAS-protected write:
   * returns 404 when the row is genuinely missing, 409 with
   * `{ error: "version_mismatch", currentVersion: N }` when it's present
   * but the supplied version is stale (§6.3).
   */
  protected async _disambiguateMismatch(data: unknown, versionColumn: string): Promise<HttpError> {
    const filter = this.table.resolveIdFilter(data);
    const row = filter
      ? ((await this.table.findOne({ filter, controls: {} } as any)) as Record<
          string,
          unknown
        > | null)
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
    const resolvedId = await this.onRemove(id);
    if (resolvedId === undefined) {
      return new HttpError(500, "Not deleted");
    }

    const result = await this.table.deleteOne(resolvedId as any);
    if ((result as any).deletedCount < 1) {
      return new HttpError(404);
    }
    return result;
  }

  /**
   * **DELETE /?field1=val1&field2=val2** — removes a record by composite key
   * (composite primary key or compound unique index).
   */
  @Delete("")
  async removeComposite(@Query() query: Record<string, string>): Promise<unknown> {
    const idObj = this.extractIdShape(query);
    if (idObj instanceof HttpError) {
      return idObj;
    }

    const resolvedId = await this.onRemove(idObj);
    if (resolvedId === undefined) {
      return new HttpError(500, "Not deleted");
    }

    const result = await this.table.deleteOne(resolvedId as any);
    if ((result as any).deletedCount < 1) {
      return new HttpError(404);
    }
    return result;
  }
}
