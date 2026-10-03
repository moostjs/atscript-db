import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { TDbForeignKey, TDbRelation } from "../types";

/**
 * Finds the FK entry that connects a `@db.rel.to` relation to its target.
 */
export function findFKForRelation(
  relation: TDbRelation,
  foreignKeys: ReadonlyMap<string, TDbForeignKey>,
): { localFields: string[]; targetFields: string[] } | undefined {
  const fk = findFKEntryForRelation(relation, foreignKeys);
  return fk && { localFields: fk.fields, targetFields: fk.targetFields };
}

/**
 * The `@db.rel.FK` entry {@link findFKForRelation} pairs with a relation: the
 * one sharing its alias, else (no alias) the first one targeting its table.
 */
export function findFKEntryForRelation(
  relation: TDbRelation,
  foreignKeys: ReadonlyMap<string, TDbForeignKey>,
): TDbForeignKey | undefined {
  if (relation.alias) {
    for (const fk of foreignKeys.values()) {
      if (fk.alias === relation.alias) return fk;
    }
    return undefined;
  }
  const targetTable = resolveRelationTargetTable(relation);
  for (const fk of foreignKeys.values()) {
    if (fk.targetTable === targetTable) return fk;
  }
  return undefined;
}

/**
 * Finds a FK on a remote table that points back to a given table name.
 */
export function findRemoteFK(
  targetTable: { foreignKeys: ReadonlyMap<string, TDbForeignKey> },
  thisTableName: string,
  alias?: string,
): TDbForeignKey | undefined {
  for (const fk of targetTable.foreignKeys.values()) {
    if (alias && fk.alias === alias && fk.targetTable === thisTableName) {
      return fk;
    }
    if (!alias && fk.targetTable === thisTableName) {
      return fk;
    }
  }
  return undefined;
}

/**
 * Physical name of an annotated type — its `@db.table`, else its `@db.view`
 * name (a view is a readable source too, since 0.1.141), else its type id
 * (`""` when none is set). The rule relations, foreign keys and view plans
 * use to name a referenced table or view.
 * @since 0.1.136
 */
export function tableNameOf(type: TAtscriptAnnotatedType | undefined): string {
  const table = type?.metadata?.get("db.table") as string | undefined;
  if (table) return table;
  const view = type?.metadata?.get("db.view") as string | true | undefined;
  return (typeof view === "string" && view) || type?.id || "";
}

/**
 * Resolves the target table name from a relation's target type metadata.
 */
export function resolveRelationTargetTable(relation: TDbRelation): string {
  return tableNameOf(relation.targetType());
}

/**
 * A string key of `fields`' values on `obj` — equal for rows that agree on
 * every field (`null` / `undefined` key distinctly from any string). `read`
 * reads one field (default: a top-level property).
 */
export function compositeKey(
  fields: readonly string[],
  obj: Record<string, unknown>,
  read: (obj: Record<string, unknown>, field: string) => unknown = (o, f) => o[f],
): string {
  let key = "";
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) {
      key += "\0\0";
    }
    const v = read(obj, fields[i]!);
    key += v === null || v === undefined ? "\0" : String(v as string | number | boolean);
  }
  return key;
}

/** `$skip` / `$limit` of a read, applied per group of rows by {@link slicePerGroup}. */
export interface TGroupPage {
  skip?: number;
  limit?: number;
}

/**
 * Keeps, of each group of `rows` sharing `keyOf(row)`, the rows `page`
 * selects — `$skip` / `$limit` applied per group, in the order of `rows`.
 * The order of the kept rows is preserved.
 */
export function slicePerGroup<R>(
  rows: readonly R[],
  keyOf: (row: R) => string,
  page: TGroupPage,
): R[] {
  const skip = page.skip ?? 0;
  const end = page.limit === undefined ? Infinity : skip + page.limit;
  const seen = new Map<string, number>();
  const kept: R[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    if (index >= skip && index < end) {
      kept.push(row);
    }
  }
  return kept;
}
