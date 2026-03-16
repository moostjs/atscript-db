import type { TDbFieldMeta, TExistingColumn, TColumnDiff } from "../types";
import { serializeDefaultValue } from "./schema-hash";

/**
 * Computes the difference between desired schema fields and existing database columns.
 *
 * @param desired - Field descriptors from the Atscript type (after flattening).
 * @param existing - Columns currently in the database (from introspection).
 * @param typeMapper - Optional function to map field metadata to DB-native type strings.
 *                     Receives the full field meta (design type, annotations, PK status, etc.)
 *                     so adapters can produce context-aware types (e.g., `VARCHAR(255)` from maxLength).
 *                     Required for type change detection.
 */
export function computeColumnDiff(
  desired: readonly TDbFieldMeta[],
  existing: TExistingColumn[],
  typeMapper?: (field: TDbFieldMeta) => string,
): TColumnDiff {
  const existingByName = new Map(existing.map((c) => [c.name, c]));
  const desiredByName = new Map<string, TDbFieldMeta>();
  const renamedOldNames = new Set<string>();

  const added: TDbFieldMeta[] = [];
  const renamed: TColumnDiff["renamed"] = [];
  const typeChanged: TColumnDiff["typeChanged"] = [];
  const nullableChanged: TColumnDiff["nullableChanged"] = [];
  const defaultChanged: TColumnDiff["defaultChanged"] = [];
  const conflicts: TColumnDiff["conflicts"] = [];

  for (const field of desired) {
    if (field.ignored) {
      continue;
    }
    desiredByName.set(field.physicalName, field);

    const existingCol = existingByName.get(field.physicalName);
    if (existingCol) {
      // Column exists with current name — but if this field also has renamedFrom
      // pointing to another existing column, the rename target conflicts
      if (field.renamedFrom && existingByName.has(field.renamedFrom)) {
        conflicts.push({ field, oldName: field.renamedFrom, conflictsWith: field.physicalName });
        renamedOldNames.add(field.renamedFrom);
      } else {
        // Check type change (requires typeMapper)
        if (typeMapper) {
          const expectedType = typeMapper(field);
          if (expectedType.toUpperCase() !== existingCol.type.toUpperCase()) {
            typeChanged.push({ field, existingType: existingCol.type });
          }
        }

        // Check nullable change — skip primary keys (SQLite PRAGMA reports notnull=0
        // for INTEGER PRIMARY KEY even though it enforces non-null on them)
        if (!field.isPrimaryKey && !existingCol.pk) {
          const desiredNotNull = !field.optional;
          if (existingCol.notnull !== desiredNotNull) {
            nullableChanged.push({ field, wasNullable: !existingCol.notnull });
          }
        }

        // Check default value change — only when a baseline exists.
        // When existingCol.dflt_value is undefined, we have no baseline
        // (e.g., old DDL without DEFAULT clause) and can't detect changes.
        const desiredDefault = serializeDefaultValue(field.defaultValue);
        if (existingCol.dflt_value !== undefined && existingCol.dflt_value !== desiredDefault) {
          defaultChanged.push({
            field,
            oldDefault: existingCol.dflt_value,
            newDefault: desiredDefault,
          });
        }
      }
    } else if (field.renamedFrom && existingByName.has(field.renamedFrom)) {
      // Column exists under old name → rename
      renamed.push({ field, oldName: field.renamedFrom });
      renamedOldNames.add(field.renamedFrom);
    } else {
      added.push(field);
    }
  }

  // Exclude renamed old names from "removed"
  const removed: TExistingColumn[] = existing.filter(
    (c) => !desiredByName.has(c.name) && !renamedOldNames.has(c.name),
  );

  return { added, removed, renamed, typeChanged, nullableChanged, defaultChanged, conflicts };
}
