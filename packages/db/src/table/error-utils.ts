import { ValidatorError } from "@atscript/typescript/utils";

import { DbError, type TDbConstraintHint, type TDbErrorEntry } from "../db-error";
import type { TDbForeignKey } from "../types";
import type { TableMetadata } from "./table-metadata";

/**
 * Prefixes error paths with a nav field context.
 * Ensures errors from child table operations (e.g., FK violations on a comment)
 * get paths like `comments[0].authorId` instead of just `authorId`.
 */
export function prefixErrorPaths<E extends { path: string }>(errors: E[], prefix: string): E[] {
  return errors.map((err) => {
    const out = { ...err, path: err.path ? `${prefix}.${err.path}` : prefix };
    // A constraint entry's `params.fields` names the same paths (since 0.1.165).
    const params = (err as { params?: { fields?: unknown } }).params;
    if (params && Array.isArray(params.fields)) {
      (out as { params?: unknown }).params = {
        ...params,
        fields: params.fields.map((f) => `${prefix}.${String(f)}`),
      };
    }
    return out;
  });
}

/**
 * Wraps an async nested operation and prefixes error paths with the nav field context.
 */
export async function wrapNestedError<R>(navField: string, fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ValidatorError) {
      throw new ValidatorError(prefixErrorPaths(error.errors, navField));
    }
    if (error instanceof DbError) {
      throw new DbError(error.code, prefixErrorPaths(error.errors, navField));
    }
    throw error;
  }
}

/**
 * Rethrows a write's constraint error normalized against the table's
 * metadata (see {@link normalizeWriteError}); anything else as is.
 */
export async function normalizeWriteErrors<R>(
  meta: TableMetadata,
  tableName: string,
  fn: () => Promise<R>,
): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    throw normalizeWriteError(meta, tableName, error);
  }
}

/**
 * The table layer's constraint-error normaliser (since 0.1.165). An adapter
 * reports a unique / foreign-key violation with whatever the engine told it
 * ({@link constraintViolation}: columns, constraint / index name); this
 * resolves that against the table's indexes and foreign keys into ONE entry
 * per logical field of the violated constraint, each with a `code`
 * (`UNIQUE` / `FK_MISSING` / `FK_RESTRICT`), `params` and the engine's raw
 * text in `details`.
 *
 * An `FK_VIOLATION` with no hint and no path (an adapter that can't tell
 * which key failed) lists every foreign-key field, `params.ambiguous: true`.
 * Errors already normalized, or of other codes, pass through unchanged.
 */
function normalizeWriteError(meta: TableMetadata, tableName: string, error: unknown): unknown {
  if (!(error instanceof DbError)) return error;
  const raw = rawText(error);
  // An update of a key other rows still reference (PG 23503 / MySQL 1451 on
  // an UPDATE): this row is the referenced one — a RESTRICT, not a missing target.
  if (error.code === "FK_VIOLATION" && error.hint?.referencedBy) {
    return new DbError("FK_VIOLATION", [
      fkRestrictEntry(tableName, {
        op: "update",
        referencedBy: error.hint.referencedBy,
        details: raw,
      }),
    ]);
  }
  if (error.hint && error.code === "CONFLICT") {
    return new DbError("CONFLICT", uniqueEntries(meta, error.hint, raw));
  }
  if (error.code === "FK_VIOLATION" && (error.hint || error.errors.every((e) => !e.path))) {
    return new DbError("FK_VIOLATION", fkEntries(meta, error.hint, raw));
  }
  return error;
}

/**
 * Wraps a delete: a native foreign-key refusal (`FK_VIOLATION`, e.g. a
 * RESTRICT) is rethrown as `CONFLICT` (409) with one `FK_RESTRICT` entry —
 * `params { table, referencedBy? }`, the engine text in `details`.
 */
export async function remapDeleteFkViolation<R>(
  tableName: string,
  fn: () => Promise<R>,
): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DbError && error.code === "FK_VIOLATION") {
      throw new DbError("CONFLICT", [
        fkRestrictEntry(tableName, {
          referencedBy: error.hint?.referencedBy,
          details: rawText(error),
        }),
      ]);
    }
    throw error;
  }
}

/** The engine text an adapter error carries (its first entry's `details`, else its message). */
function rawText(error: DbError): string {
  return error.errors[0]?.details ?? error.errors[0]?.message ?? error.message;
}

/** Whether `names` is exactly the column `set` (in any order). */
function sameColumns(names: readonly string[], set: ReadonlySet<string>): boolean {
  return names.length === set.size && names.every((n) => set.has(n));
}

/** A physical column's logical path (the column itself when unmapped). */
function logicalPath(meta: TableMetadata, column: string): string {
  return meta.physicalToPath.get(column) ?? column;
}

/**
 * The `FK_RESTRICT` entry of a write blocked by referencing rows — a delete
 * (default) or an update of a referenced key. One source for the native
 * refusal and the application-level RESTRICT check.
 * @internal
 */
export function fkRestrictEntry(
  tableName: string,
  opts: {
    op?: "delete" | "update";
    referencedBy?: string;
    count?: number;
    details?: string;
    fields?: readonly string[];
  } = {},
): TDbErrorEntry {
  const { referencedBy, count, details, fields } = opts;
  const verb = opts.op === "update" ? "update" : "delete from";
  const by =
    referencedBy === undefined
      ? "child records"
      : `${count === undefined ? "records" : `${count} record(s)`} in "${referencedBy}"${fields ? ` (${fields.join(", ")})` : ""}`;
  return {
    path: tableName,
    message: `Cannot ${verb} "${tableName}": referenced by ${by} (RESTRICT)`,
    code: "FK_RESTRICT",
    params: {
      table: tableName,
      ...(referencedBy === undefined ? {} : { referencedBy }),
      ...(fields ? { fields: [...fields] } : {}),
    },
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * The `FK_MISSING` entries of one foreign key: one per field, the same
 * message on each. @internal
 */
export function fkMissingEntries(
  fields: readonly string[],
  target: string,
  details?: string,
  ambiguous?: boolean,
): TDbErrorEntry[] {
  const message =
    fields.length === 1
      ? `References a non-existent record in "${target}"`
      : `"${fields.join('", "')}" reference a non-existent record in "${target}"`;
  return fields.map((path) => ({
    path,
    message,
    code: "FK_MISSING",
    params: { fields: [...fields], target, ...(ambiguous ? { ambiguous: true } : {}) },
    ...(details === undefined ? {} : { details }),
  }));
}

function uniqueEntries(meta: TableMetadata, hint: TDbConstraintHint, raw: string): TDbErrorEntry[] {
  const resolved = resolveUnique(meta, hint);
  const fields = resolved?.fields ?? [];
  if (fields.length === 0) {
    // Unresolved: the engine's key name is all there is.
    const params = hint.name ? { index: hint.name } : {};
    return [{ path: "", message: "Value must be unique", code: "UNIQUE", params, details: raw }];
  }
  const message =
    fields.length === 1
      ? "Value must be unique"
      : `The combination of "${fields.join('", "')}" must be unique`;
  const params = { ...(resolved?.index ? { index: resolved.index } : {}), fields: [...fields] };
  return fields.map((path) => ({ path, message, code: "UNIQUE", params, details: raw }));
}

/** The unique key a hint names — by name, then by its exact column set. */
function resolveUnique(
  meta: TableMetadata,
  hint: TDbConstraintHint,
): { index?: string; fields: string[] } | undefined {
  const logical = (column: string) => logicalPath(meta, column);
  if (hint.primaryKey) return { index: "primaryKey", fields: [...meta.primaryKeys] };
  const uniques = [...meta.indexes.values()].filter((i) => i.type === "unique");
  if (hint.name) {
    const named = uniques.find((i) => i.key === hint.name || i.name === hint.name);
    if (named) return { index: named.name, fields: named.fields.map((f) => logical(f.name)) };
  }
  if (!hint.columns?.length) return undefined;
  const columns = new Set(hint.columns);
  const sameSet = (names: readonly string[]) => sameColumns(names, columns);
  const byColumns = uniques.find((i) => sameSet(i.fields.map((f) => f.name)));
  if (byColumns) {
    return { index: byColumns.name, fields: byColumns.fields.map((f) => logical(f.name)) };
  }
  if (meta.primaryKeys.length > 0 && sameSet(meta.primaryKeys.map((k) => meta.physicalPath(k)))) {
    return { index: "primaryKey", fields: [...meta.primaryKeys] };
  }
  return { fields: hint.columns.map(logical) };
}

function fkEntries(
  meta: TableMetadata,
  hint: TDbConstraintHint | undefined,
  raw: string,
): TDbErrorEntry[] {
  const fks = [...meta.foreignKeys.values()];
  const physical = (fk: TDbForeignKey) => fk.physicalFields ?? fk.fields;
  const columns = hint?.columns;
  if (columns?.length) {
    const set = new Set(columns);
    const fk =
      fks.find((f) => sameColumns(physical(f), set)) ??
      fks.find((f) => physical(f).includes(columns[0]!));
    if (fk) return fkMissingEntries(fk.fields, fk.targetTable, raw);
    const fields = columns.map((c) => logicalPath(meta, c));
    return fields.map((path) => ({
      path,
      message: "References a non-existent record",
      code: "FK_MISSING",
      params: { fields },
      details: raw,
    }));
  }
  // The engine did not say which key failed: every foreign key, flagged.
  const all = fks.flatMap((fk) => fkMissingEntries(fk.fields, fk.targetTable, raw, fks.length > 1));
  return all.length > 0
    ? all
    : [{ path: "", message: "References a non-existent record", code: "FK_MISSING", details: raw }];
}
