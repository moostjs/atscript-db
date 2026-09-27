import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { TDbForeignKey, TDbRelation } from "../types";

/**
 * Finds the FK entry that connects a `@db.rel.to` relation to its target.
 */
export function findFKForRelation(
  relation: TDbRelation,
  foreignKeys: ReadonlyMap<string, TDbForeignKey>,
): { localFields: string[]; targetFields: string[] } | undefined {
  const targetTable = resolveRelationTargetTable(relation);
  for (const fk of foreignKeys.values()) {
    if (relation.alias) {
      if (fk.alias === relation.alias) {
        return { localFields: fk.fields, targetFields: fk.targetFields };
      }
    } else if (fk.targetTable === targetTable) {
      return { localFields: fk.fields, targetFields: fk.targetFields };
    }
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
 * Table name of an annotated type — its `@db.table`, else its type id (`""`
 * when neither is set). The rule relations, foreign keys and view plans use
 * to name a referenced table.
 * @since 0.1.136
 */
export function tableNameOf(type: TAtscriptAnnotatedType | undefined): string {
  return (type?.metadata?.get("db.table") as string) || type?.id || "";
}

/**
 * Resolves the target table name from a relation's target type metadata.
 */
export function resolveRelationTargetTable(relation: TDbRelation): string {
  return tableNameOf(relation.targetType());
}
