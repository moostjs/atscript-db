import type { AtscriptDbReadable } from "../table/db-readable";
import type { AtscriptDbView } from "../table/db-view";
import type { AtscriptQueryNode, AtscriptQueryFieldRef } from "../query/query-tree";
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
  /** `@db.encrypted` — toggling encryption changes the snapshot hash on every adapter. */
  encrypted?: boolean;
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

/**
 * One join of a managed view as stored in its snapshot.
 * @since 0.1.128 — `joinTables` elements were bare target-table names before;
 * the ON predicate is now part of the view definition.
 */
export interface TViewJoinSnapshot {
  targetTable: string;
  /** Canonical JSON of the join condition (see {@link canonicalizeQueryNode}). */
  condition: string;
  /** Reserved for optional joins; absent today so it does not perturb the hash. */
  kind?: "inner" | "left";
}

export interface TViewSnapshot {
  tableName: string;
  viewType: "V" | "M" | "E";
  entryTable?: string;
  /**
   * Joins in declaration order. The key keeps its historical name so a
   * join-less view (`[]`) serializes byte-identically to older snapshots.
   */
  joinTables?: TViewJoinSnapshot[];
  filterHash?: string;
  /** @since 0.1.128 — hash of the canonical `@db.view.having` predicate. */
  havingHash?: string;
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
      if (f.encrypted) {
        snap.encrypted = true;
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
  // Same table rule as the SQL renderers (`@db.table` of the referenced type,
  // entry table for an unqualified ref) — unquoted, as `"<table>.<field>"`.
  const qualify = (ref: AtscriptQueryFieldRef): string => view.resolveFieldRef(ref, (n) => n);
  const result: TViewSnapshot = {
    tableName: view.tableName,
    viewType: plan.materialized ? "M" : "V",
    entryTable: plan.entryTable,
    joinTables: plan.joins.map((j) => ({
      targetTable: j.targetTable,
      condition: JSON.stringify(canonicalizeQueryNode(j.condition, qualify)),
    })),
    materialized: plan.materialized || undefined,
    fields,
  };

  if (plan.filter) {
    result.filterHash = fnv1a(JSON.stringify(canonicalizeQueryNode(plan.filter, qualify)));
  }
  if (plan.having) {
    result.havingHash = fnv1a(JSON.stringify(canonicalizeQueryNode(plan.having, qualify)));
  }

  return result;
}

// ── Query-node canonicalization ───────────────────────────────────────────

/** Canonical (table-qualified, fixed-key-order) form of a view predicate. */
export type TCanonicalQueryNode =
  | { and: TCanonicalQueryNode[] }
  | { or: TCanonicalQueryNode[] }
  | { not: TCanonicalQueryNode }
  /** `r` is `{ f: "<table>.<field>" }` for a field-to-field comparison, else the literal. */
  | { l: string; op: string; r?: unknown };

/**
 * Converts a view predicate (join condition, `@db.view.filter`,
 * `@db.view.having`) into a serializable structure whose JSON is a stable
 * function of its MEANING: field refs become `qualify(ref)` — the view's
 * `resolveFieldRef(ref, (n) => n)`, i.e. `"<table>.<field>"`, so a predicate
 * retargeted to another table with the same field name changes — operators
 * and literal values are kept as-is, `$and`/`$or` keep declaration order, and
 * no function references survive. Two identical models produce byte-identical
 * JSON.
 * @since 0.1.128
 */
export function canonicalizeQueryNode(
  node: AtscriptQueryNode,
  qualify: (ref: AtscriptQueryFieldRef) => string,
): TCanonicalQueryNode {
  if ("$and" in node) {
    return {
      and: (node as { $and: AtscriptQueryNode[] }).$and.map((n) =>
        canonicalizeQueryNode(n, qualify),
      ),
    };
  }
  if ("$or" in node) {
    return {
      or: (node as { $or: AtscriptQueryNode[] }).$or.map((n) => canonicalizeQueryNode(n, qualify)),
    };
  }
  if ("$not" in node) {
    return { not: canonicalizeQueryNode((node as { $not: AtscriptQueryNode }).$not, qualify) };
  }
  const comp = node as { left: AtscriptQueryFieldRef; op: string; right?: unknown };
  const out: { l: string; op: string; r?: unknown } = { l: qualify(comp.left), op: comp.op };
  if (comp.right !== undefined) {
    out.r =
      comp.right !== null && typeof comp.right === "object" && "field" in (comp.right as object)
        ? { f: qualify(comp.right as AtscriptQueryFieldRef) }
        : comp.right;
  }
  return out;
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
