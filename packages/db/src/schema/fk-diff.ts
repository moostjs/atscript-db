import type { TDbForeignKey } from "../types";
import type { TForeignKeySnapshot } from "./schema-hash";

// ── Types ────────────────────────────────────────────────────────────────

export interface TForeignKeyDiff {
  /** FKs present in desired but not in stored snapshot (new). */
  added: TDbForeignKey[];
  /** FKs present in stored snapshot but not in desired (removed). */
  removed: TForeignKeySnapshot[];
  /** FKs where fields match but target, onDelete, or onUpdate differ. */
  changed: Array<{ desired: TDbForeignKey; existing: TForeignKeySnapshot }>;
}

// ── Diff computation ─────────────────────────────────────────────────────

/** Canonical key for an FK: sorted local field names, comma-joined. */
export function fkKey(fields: readonly string[]): string {
  return [...fields].toSorted().join(",");
}

/**
 * Compares desired FK constraints against stored snapshot to detect
 * additions, removals, and property changes (target table, target fields,
 * onDelete, onUpdate).
 */
export function computeForeignKeyDiff(
  desired: ReadonlyMap<string, TDbForeignKey>,
  existingSnapshot: readonly TForeignKeySnapshot[],
): TForeignKeyDiff {
  const added: TDbForeignKey[] = [];
  const removed: TForeignKeySnapshot[] = [];
  const changed: TForeignKeyDiff["changed"] = [];

  // Index existing by canonical key
  const existingByKey = new Map<string, TForeignKeySnapshot>();
  for (const fk of existingSnapshot) {
    existingByKey.set(fkKey(fk.fields), fk);
  }

  // Walk desired FKs
  const desiredKeys = new Set<string>();
  for (const fk of desired.values()) {
    const key = fkKey(fk.fields);
    desiredKeys.add(key);
    const existing = existingByKey.get(key);
    if (!existing) {
      added.push(fk);
    } else if (fkPropertiesDiffer(fk, existing)) {
      changed.push({ desired: fk, existing });
    }
  }

  // Remaining existing keys not in desired → removed
  for (const [key, fk] of existingByKey) {
    if (!desiredKeys.has(key)) {
      removed.push(fk);
    }
  }

  return { added, removed, changed };
}

/** Whether the FK diff contains any changes. */
export function hasForeignKeyChanges(diff: TForeignKeyDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

// ── Internal ─────────────────────────────────────────────────────────────

function fkPropertiesDiffer(desired: TDbForeignKey, existing: TForeignKeySnapshot): boolean {
  if (desired.targetTable !== existing.targetTable) {
    return true;
  }
  if (fkKey(desired.targetFields) !== fkKey(existing.targetFields)) {
    return true;
  }
  if ((desired.onDelete ?? undefined) !== (existing.onDelete ?? undefined)) {
    return true;
  }
  if ((desired.onUpdate ?? undefined) !== (existing.onUpdate ?? undefined)) {
    return true;
  }
  return false;
}
