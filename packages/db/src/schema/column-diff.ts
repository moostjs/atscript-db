import type { TDbFieldMeta, TDerivedChangeReason, TExistingColumn, TColumnDiff } from "../types";
import { serializeDefaultValue, type TFieldSnapshot, type TTableSnapshot } from "./schema-hash";
import { fkKey } from "./fk-diff";

/**
 * Why a derived column (desired, live, or both) must be dropped and re-added,
 * or `undefined` when it is unchanged. Nullability and defaults are never
 * compared for one: a generated column is nullable and has no DEFAULT.
 */
function derivedChangeReason(
  field: TDbFieldMeta,
  existingCol: TExistingColumn,
  typeMapper: ((field: TDbFieldMeta) => string) | undefined,
  snap: TFieldSnapshot | undefined,
): TDerivedChangeReason | undefined {
  if (!field.derived) {
    return existingCol.generated ? "kind" : undefined;
  }
  if (!existingCol.generated) {
    return "kind";
  }
  const stored = snap?.derived;
  if (
    stored &&
    (stored.sourceColumn !== field.derived.sourceColumn ||
      stored.type !== field.derived.type ||
      stored.jsonPath.length !== field.derived.jsonPath.length ||
      stored.jsonPath.some((seg, i) => seg !== field.derived!.jsonPath[i]))
  ) {
    return "expression";
  }
  if (typeMapper && isColumnTypeChanged(existingCol.type, typeMapper(field))) {
    return "type";
  }
  return undefined;
}

/**
 * Whether a live column's type differs from the type the adapter's
 * `typeMapper` gives the field — the one rule schema sync diffs column types
 * by (case-insensitive). Exported for adapters that must agree with it (the
 * PostgreSQL recreate converts exactly the columns this reports changed).
 * @since 0.1.137
 */
export function isColumnTypeChanged(existingType: string, expectedType: string): boolean {
  return existingType.toUpperCase() !== expectedType.toUpperCase();
}

/**
 * Computes the difference between desired schema fields and existing database columns.
 *
 * @param desired - Field descriptors from the Atscript type (after flattening) —
 *                  the readable's `columnDescriptors`; ignored descriptors are skipped.
 * @param existing - Columns currently in the database (from introspection).
 * @param typeMapper - Optional function to map field metadata to DB-native type strings.
 *                     Receives the full field meta (design type, annotations, PK status, etc.)
 *                     so adapters can produce context-aware types (e.g., `VARCHAR(255)` from maxLength).
 *                     Required for type change detection.
 * @param opts.snapshot - The table's stored snapshot (since 0.1.141) — the baseline a
 *                        derived column's expression is compared with (the engine normalizes
 *                        the expression it stores, so the live column cannot be). Without
 *                        one, only a kind or type drift is seen.
 */
export function computeColumnDiff(
  desired: readonly TDbFieldMeta[],
  existing: TExistingColumn[],
  typeMapper?: (field: TDbFieldMeta) => string,
  opts?: { snapshot?: TTableSnapshot | null },
): TColumnDiff {
  const existingByName = new Map(existing.map((c) => [c.name, c]));
  const snapshotByName = opts?.snapshot
    ? new Map(opts.snapshot.fields.map((f) => [f.physicalName, f]))
    : undefined;
  const derivedChanged: NonNullable<TColumnDiff["derivedChanged"]> = [];
  const desiredByName = new Map<string, TDbFieldMeta>();
  const renamedOldNames = new Set<string>();

  const added: TDbFieldMeta[] = [];
  const renamed: TColumnDiff["renamed"] = [];
  const typeChanged: TColumnDiff["typeChanged"] = [];
  const nullableChanged: TColumnDiff["nullableChanged"] = [];
  const defaultChanged: TColumnDiff["defaultChanged"] = [];
  const conflicts: TColumnDiff["conflicts"] = [];

  /**
   * A derived column (on either side) is compared as a whole — any drift is a
   * drop + add, and nullability / defaults are not the model's to manage.
   * `true` when the pair was a derived one (handled here).
   */
  const checkDerived = (field: TDbFieldMeta, col: TExistingColumn, snapKey: string): boolean => {
    if (!field.derived && !col.generated) {
      return false;
    }
    const reason = derivedChangeReason(field, col, typeMapper, snapshotByName?.get(snapKey));
    if (reason) {
      derivedChanged.push({ field, reason });
    }
    return true;
  };

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
      } else if (!checkDerived(field, existingCol, field.physicalName)) {
        // Check type change (requires typeMapper)
        if (typeMapper) {
          if (isColumnTypeChanged(existingCol.type, typeMapper(field))) {
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
      // Column exists under old name → rename. A derived column that also
      // changed its expression (or kind) is rebuilt after the rename, under
      // its new name — the rename alone would keep the old expression.
      renamed.push({ field, oldName: field.renamedFrom });
      renamedOldNames.add(field.renamedFrom);
      checkDerived(field, existingByName.get(field.renamedFrom)!, field.renamedFrom);
    } else {
      added.push(field);
    }
  }

  // Exclude renamed old names from "removed"
  const removed: TExistingColumn[] = existing.filter(
    (c) => !desiredByName.has(c.name) && !renamedOldNames.has(c.name),
  );

  const diff: TColumnDiff = {
    added,
    removed,
    renamed,
    typeChanged,
    nullableChanged,
    defaultChanged,
    conflicts,
  };
  if (derivedChanged.length > 0) {
    diff.derivedChanged = derivedChanged;
  }

  // Primary-key field set — only meaningful when the table exists. Compared
  // as sorted sets (consistent with the schema hash, which stores
  // `isPrimaryKey` per field sorted by name and cannot see a reorder either).
  // A renamed PK column is mapped to its new name before comparing so a plain
  // `@db.column.renamed` on the key is not mistaken for a key change.
  if (existing.length > 0) {
    const newNameByOld = new Map(renamed.map((r) => [r.oldName, r.field.physicalName]));
    const from = existing.filter((c) => c.pk).map((c) => newNameByOld.get(c.name) ?? c.name);
    const to = desired.filter((f) => !f.ignored && f.isPrimaryKey).map((f) => f.physicalName);
    if (fkKey(from) !== fkKey(to)) {
      diff.primaryKeyChanged = { from, to };
    }
  }

  return diff;
}
