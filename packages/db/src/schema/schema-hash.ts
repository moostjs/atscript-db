import type { AtscriptDbReadable } from "../table/db-readable";
import type { AtscriptDbView } from "../table/db-view";
import type {
  TDbDefaultValue,
  TDbFieldMeta,
  TDbStorageType,
  TExistingColumn,
  TExistingTableOption,
} from "../types";

// ── Snapshot types ────────────────────────────────────────────────────────

export interface TFieldSnapshot {
  physicalName: string;
  designType: string;
  optional: boolean;
  isPrimaryKey: boolean;
  storage: TDbStorageType;
  defaultValue?: TDbDefaultValue;
  /** Adapter-specific mapped type (e.g., "VARCHAR(255)", "INTEGER"). */
  mappedType?: string;
}

interface TIndexSnapshot {
  key: string;
  type: string;
  fields: Array<{ name: string; sort: string }>;
}

export interface TForeignKeySnapshot {
  fields: string[];
  targetTable: string;
  targetFields: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface TTableSnapshot {
  tableName: string;
  fields: TFieldSnapshot[];
  indexes: TIndexSnapshot[];
  foreignKeys: TForeignKeySnapshot[];
  /** Adapter-specific table-level options (e.g., MySQL engine/charset, MongoDB capped). */
  tableOptions?: TExistingTableOption[];
}

export interface TViewSnapshot {
  tableName: string;
  viewType: "V" | "M" | "E";
  entryTable?: string;
  joinTables?: string[];
  filterHash?: string;
  materialized?: boolean;
  fields: TFieldSnapshot[];
}

// ── Shared helpers ────────────────────────────────────────────────────────

/** Extracts sorted field snapshots from a readable's field descriptors. */
function extractFieldSnapshots(
  fields: readonly TDbFieldMeta[],
  typeMapper?: (field: TDbFieldMeta) => string,
): TFieldSnapshot[] {
  return fields
    .filter((f: TDbFieldMeta) => !f.ignored)
    .map((f: TDbFieldMeta) => {
      const snap: TFieldSnapshot = {
        physicalName: f.physicalName,
        designType: f.designType,
        optional: f.optional,
        isPrimaryKey: f.isPrimaryKey,
        storage: f.storage,
      };
      if (f.defaultValue) {
        snap.defaultValue = f.defaultValue;
      }
      if (typeMapper) {
        snap.mappedType = typeMapper(f);
      }
      return snap;
    })
    .toSorted((a, b) => a.physicalName.localeCompare(b.physicalName));
}

// ── Table snapshot ────────────────────────────────────────────────────────

/**
 * Extracts a canonical, serializable snapshot from a readable's metadata.
 * Sorted deterministically so the hash is stable across runs.
 *
 * @param readable - The table/view readable.
 * @param typeMapper - Optional adapter-specific type mapper. When provided,
 *   each field's mapped type (e.g., "VARCHAR(255)") is stored in the snapshot
 *   for precise type change detection.
 */
export function computeTableSnapshot(
  readable: AtscriptDbReadable,
  typeMapper?: (field: TDbFieldMeta) => string,
  tableOptions?: TExistingTableOption[],
): TTableSnapshot {
  const fields = extractFieldSnapshots(readable.fieldDescriptors, typeMapper);

  const indexes: TIndexSnapshot[] = [...readable.indexes.values()]
    .map((idx) => ({
      key: idx.key,
      type: idx.type,
      fields: idx.fields.map((f) => ({ name: f.name, sort: f.sort })),
    }))
    .toSorted((a, b) => a.key.localeCompare(b.key));

  const foreignKeys: TForeignKeySnapshot[] = [...readable.foreignKeys.values()]
    .map((fk) => ({
      fields: [...fk.fields].toSorted(),
      targetTable: fk.targetTable,
      targetFields: [...fk.targetFields].toSorted(),
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    }))
    .toSorted((a, b) => a.fields.join(",").localeCompare(b.fields.join(",")));

  const snapshot: TTableSnapshot = {
    tableName: readable.tableName,
    fields,
    indexes,
    foreignKeys,
  };

  if (tableOptions?.length) {
    snapshot.tableOptions = [...tableOptions].toSorted((a, b) => a.key.localeCompare(b.key));
  }

  return snapshot;
}

// ── View snapshot ─────────────────────────────────────────────────────────

/**
 * Extracts a canonical, serializable snapshot from a view's metadata.
 * Captures view plan (entry table, joins, filter, materialization) for
 * detecting view definition changes.
 */
export function computeViewSnapshot(view: AtscriptDbView): TViewSnapshot {
  const fields = extractFieldSnapshots(view.fieldDescriptors);

  if (view.isExternal) {
    return {
      tableName: view.tableName,
      viewType: "E",
      fields,
    };
  }

  const plan = view.viewPlan;
  const result: TViewSnapshot = {
    tableName: view.tableName,
    viewType: plan.materialized ? "M" : "V",
    entryTable: plan.entryTable,
    joinTables: plan.joins.map((j) => j.targetTable),
    materialized: plan.materialized || undefined,
    fields,
  };

  if (plan.filter) {
    // Hash the filter — AtscriptQueryNode may contain function refs
    result.filterHash = fnv1a(
      JSON.stringify(plan.filter, (_, v) => (typeof v === "function" ? "[fn]" : v)),
    );
  }

  return result;
}

// ── Hash functions ────────────────────────────────────────────────────────

/**
 * Computes a deterministic hash string from multiple table snapshots.
 * Uses FNV-1a for speed — not cryptographic, just needs stability + collision resistance.
 */
export function computeSchemaHash(snapshots: Array<TTableSnapshot | TViewSnapshot>): string {
  const sorted = [...snapshots].toSorted((a, b) => a.tableName.localeCompare(b.tableName));
  const json = JSON.stringify(sorted);
  return fnv1a(json);
}

/**
 * Computes a hash for a single table/view snapshot.
 * Used for per-table change detection via stored snapshots.
 */
export function computeTableHash(snapshot: TTableSnapshot | TViewSnapshot): string {
  return fnv1a(JSON.stringify(snapshot));
}

// ── Snapshot conversion ───────────────────────────────────────────────────

/**
 * Converts stored snapshot fields to `TExistingColumn[]` format
 * for use with `computeColumnDiff`. Used by adapters that lack
 * native column introspection (e.g., MongoDB).
 *
 * The `type` field uses `mappedType` when available (adapter-specific),
 * falling back to `designType`.
 */
export function snapshotToExistingColumns(snapshot: TTableSnapshot): TExistingColumn[] {
  return snapshot.fields.map((f) => ({
    name: f.physicalName,
    type: f.mappedType ?? f.designType,
    notnull: !f.optional,
    pk: f.isPrimaryKey,
    dflt_value: serializeDefaultValue(f.defaultValue),
  }));
}

/**
 * Extracts table options from a stored snapshot for diff comparison.
 * Used as fallback when an adapter lacks native table option introspection.
 */
export function snapshotToExistingTableOptions(snapshot: TTableSnapshot): TExistingTableOption[] {
  return snapshot.tableOptions ?? [];
}

/** Serializes a TDbDefaultValue to a comparable string. */
export function serializeDefaultValue(dv: TDbDefaultValue | undefined): string | undefined {
  if (!dv) {
    return undefined;
  }
  if (dv.kind === "value") {
    return dv.value;
  }
  return `fn:${dv.fn}`;
}

// ── Internal ──────────────────────────────────────────────────────────────

/** FNV-1a 32-bit hash → hex string */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.codePointAt(i)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.trunc(hash).toString(16).padStart(8, "0");
}
