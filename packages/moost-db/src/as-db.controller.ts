import type { TAtscriptAnnotatedType, TAtscriptDataType } from "@atscript/typescript/utils";
import type { AtscriptDbTable } from "@atscript/db";
import { Body, Delete, HttpError, Patch, Post, Put, Query } from "@moostjs/event-http";
import { Inherit, Inject, Moost, Param } from "moost";

import { AsDbReadableController } from "./as-db-readable.controller";
import { TABLE_DEF } from "./decorators";

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
    @Inject(TABLE_DEF)
    table: AtscriptDbTable<T>,
    app: Moost,
  ) {
    super(table, app);
  }

  // ── Hooks (overridable) ────────────────────────────────────────────────

  /**
   * Intercepts write operations. Return `undefined` to abort.
   */
  protected onWrite(
    action: "insert" | "insertMany" | "replace" | "replaceMany" | "update" | "updateMany",
    data: unknown,
  ): unknown {
    return data;
  }

  /**
   * Intercepts delete operations. Return `undefined` to abort.
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
   */
  @Put("")
  async replace(@Body() payload: unknown): Promise<unknown> {
    if (Array.isArray(payload)) {
      const data = await this.onWrite("replaceMany", payload);
      if (data === undefined) {
        return new HttpError(500, "Not saved");
      }
      return await this.table.bulkReplace(data as any);
    }

    const data = await this.onWrite("replace", payload);
    if (data === undefined) {
      return new HttpError(500, "Not saved");
    }
    return await this.table.replaceOne(data as any);
  }

  /**
   * **PATCH /** — partially updates one or many records matched by primary key.
   */
  @Patch("")
  async update(@Body() payload: unknown): Promise<unknown> {
    if (Array.isArray(payload)) {
      const data = await this.onWrite("updateMany", payload);
      if (data === undefined) {
        return new HttpError(500, "Not saved");
      }
      return await this.table.bulkUpdate(data as any);
    }

    const data = await this.onWrite("update", payload);
    if (data === undefined) {
      return new HttpError(500, "Not saved");
    }
    return await this.table.updateOne(data as any);
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
    const idObj = this.extractCompositeId(query);
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
