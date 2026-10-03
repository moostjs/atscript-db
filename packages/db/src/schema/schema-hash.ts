import type { AtscriptDbReadable } from "../table/db-readable";
import type { AtscriptDbView } from "../table/db-view";
import type {
  AtscriptExprNode,
  AtscriptQueryNode,
  AtscriptQueryFieldRef,
} from "../query/query-tree";
import { findAncestorInSet } from "../shared/object";
import { fkColumns } from "./fk-diff";
import type {
  TDbDefaultValue,
  TDbFieldMeta,
  TDbStorageType,
  TDerivedColumn,
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
  /**
   * `@db.column.derived` — what the generated column reads (physical JSON
   * column, path, leaf type). Present for derived fields only, so a table
   * without one hashes exactly as before; the column diff compares it with
   * the model to detect an expression change (engines normalize the stored
   * expression text, so the snapshot is the baseline).
   * @since 0.1.141
   */
  derived?: Omit<TDerivedColumn, "sourcePath">;
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
  /**
   * Scope name of the join: the physical table / view, or the `@db.alias`
   * type name when the join is aliased (then {@link table} holds the physical name).
   */
  targetTable: string;
  /**
   * Physical table / view of an aliased join. Emitted only when the target
   * is a `@db.alias` type — a plain join serializes exactly as before.
   * @since 0.1.141
   */
  table?: string;
  /** Canonical JSON of the join condition (see {@link canonicalizeQueryNode}). */
  condition: string;
  /** Emitted only for `"left"` — an inner join (the default) carries no key. @since 0.1.136 */
  kind?: "inner" | "left";
  /**
   * First-row joins only: canonical JSON `[["<scope>.<column>", 1 | -1], …]`
   * of the ordering, the appended primary key included. @since 0.1.147
   */
  order?: string;
}

/**
 * One column of a managed view as stored in its snapshot — the PHYSICAL
 * source it reads, so a source rename (`@db.column`, flattening, a moved
 * JSON leaf) or an aggregate change recreates the view.
 * @since 0.1.136
 */
export interface TViewColumnSnapshot {
  column: string;
  sourceTable: string;
  sourceColumn: string;
  /** JSON array of the path segments inside a JSON source column. */
  jsonPath?: string;
  jsonType?: string;
  aggFn?: string;
  aggField?: string;
  /** Canonical JSON of a conditional aggregate's predicate. */
  aggFilter?: string;
  /**
   * Computed columns only: canonical JSON of the `@db.compute` expression —
   * leaves `{c: "<viewColumn>"}`, literals `{n: x}`, nodes `{op, a: [...]}`.
   * @since 0.1.147
   */
  expr?: string;
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
  /** @since 0.1.136 — view columns and their physical sources, sorted by `column`. */
  columns?: TViewColumnSnapshot[];
  filterHash?: string;
  /** @since 0.1.128 — hash of the canonical `@db.view.having` predicate. */
  havingHash?: string;
  materialized?: boolean;
  /**
   * @since 0.1.137 — the adapter's `viewRenderRevision()`, present only when
   * the adapter defines one (managed views only).
   */
  renderRevision?: string;
  fields: TFieldSnapshot[];
}

/**
 * The physical sources a stored view snapshot reads: its entry table and the
 * physical table of every join (an aliased join's `table`). External views
 * (no plan) yield `[]`.
 * @since 0.1.141
 */
export function viewSnapshotSources(snapshot: TViewSnapshot): string[] {
  const sources = (snapshot.joinTables ?? []).map((j) => j.table ?? j.targetTable);
  return snapshot.entryTable ? [snapshot.entryTable, ...sources] : sources;
}

// ── Shared helpers ────────────────────────────────────────────────────────

/**
 * The descriptors a snapshot lists: the non-ignored ones — plus, on a
 * nested-object adapter, the subfields of navigation properties. Those are
 * `ignored` since 0.1.141 (never columns: out of the plan, the column diff
 * and every write), but earlier releases wrote them into a document
 * adapter's snapshot; they stay listed so the upgrade leaves every stored
 * hash unchanged. {@link snapshotToExistingColumns} (given the readable)
 * leaves them out when a stored snapshot stands in for the live columns.
 */
function snapshotFields(readable: AtscriptDbReadable): readonly TDbFieldMeta[] {
  const nav = readable.navFields;
  if (!nav?.size || !readable.dbAdapter.supportsNestedObjects()) {
    return readable.fieldDescriptors.filter((f) => !f.ignored);
  }
  return readable.fieldDescriptors.filter(
    (f) => !f.ignored || findAncestorInSet(f.path, nav) !== undefined,
  );
}

/** Extracts sorted field snapshots from a readable's {@link snapshotFields}. */
function extractFieldSnapshots(
  readable: AtscriptDbReadable,
  typeMapper?: (field: TDbFieldMeta) => string,
): TFieldSnapshot[] {
  return snapshotFields(readable)
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
      if (f.derived) {
        snap.derived = {
          sourceColumn: f.derived.sourceColumn,
          jsonPath: [...f.derived.jsonPath],
          type: f.derived.type,
        };
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
  const fields = extractFieldSnapshots(readable, typeMapper);

  const indexes: TIndexSnapshot[] = [...readable.indexes.values()]
    .map((idx) => ({
      key: idx.key,
      type: idx.type,
      fields: idx.fields.map((f) => ({ name: f.name, sort: f.sort })),
    }))
    .toSorted((a, b) => a.key.localeCompare(b.key));

  // Physical column names (`@db.column` renames applied) — compared with the
  // desired FKs by `computeForeignKeyDiff` (since 0.1.147; logical before).
  const foreignKeys: TForeignKeySnapshot[] = [...readable.foreignKeys.values()]
    .map((fk) => ({
      fields: [...fkColumns(fk).fields].toSorted(),
      targetTable: fk.targetTable,
      targetFields: [...fkColumns(fk).targetFields].toSorted(),
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
  const fields = extractFieldSnapshots(view);

  if (view.isExternal) {
    return {
      tableName: view.tableName,
      viewType: "E",
      fields,
    };
  }

  const plan = view.viewPlan;
  // Same table + physical-column rule as the SQL renderers (`@db.table` of
  // the referenced type, entry table for an unqualified ref) — unquoted, as
  // `"<table>.<column>"`.
  const qualify = (ref: AtscriptQueryFieldRef): string => view.resolveFieldRef(ref, (n) => n);
  const canonical = (node: AtscriptQueryNode): string =>
    JSON.stringify(canonicalizeQueryNode(node, qualify));

  const mappings = view.getViewColumnMappings();
  const columnOf = new Map(mappings.map((m) => [m.viewPath, m.viewColumn]));
  const columns = mappings
    .map((m) => {
      const col: TViewColumnSnapshot = {
        column: m.viewColumn,
        sourceTable: m.sourceTable,
        sourceColumn: m.sourceColumn,
      };
      if (m.json) {
        col.jsonPath = JSON.stringify(m.json.path);
        col.jsonType = m.json.type;
      }
      if (m.aggFn) col.aggFn = m.aggFn;
      if (m.aggField) col.aggField = m.aggField;
      if (m.aggFilter) col.aggFilter = canonical(m.aggFilter);
      if (m.expr !== undefined) {
        col.expr = JSON.stringify(
          canonicalizeViewExpr(m.expr, (path) => columnOf.get(path) ?? path),
        );
      }
      return col;
    })
    .toSorted((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));

  // Key order is part of the hash: tableName, viewType, entryTable,
  // joinTables, columns, filterHash, havingHash, materialized,
  // renderRevision, fields. Optional keys are omitted when unset, so an
  // adapter without a render revision hashes exactly as before 0.1.137, and
  // a view without aliased joins or view sources exactly as before 0.1.141
  // (an upstream view's own definition is NOT embedded — sync recreates
  // dependents when an upstream view is recreated instead).
  const result: Omit<TViewSnapshot, "fields"> = {
    tableName: view.tableName,
    viewType: plan.materialized ? "M" : "V",
    entryTable: plan.entryTable,
    joinTables: plan.joins.map((j) => {
      const join: TViewJoinSnapshot = {
        targetTable: j.scope,
        // Key order: targetTable, table (aliased joins only), condition, kind, order
        ...(j.scope !== j.targetTable ? { table: j.targetTable } : {}),
        condition: canonical(j.condition),
      };
      if (j.kind === "left") join.kind = "left";
      if (j.first) {
        join.order = JSON.stringify(
          j.first.order.map((item) => [qualify(item.ref), item.desc ? -1 : 1]),
        );
      }
      return join;
    }),
    columns,
  };
  if (plan.filter) {
    result.filterHash = fnv1a(canonical(plan.filter));
  }
  if (plan.having) {
    result.havingHash = fnv1a(canonical(plan.having));
  }
  if (plan.materialized) {
    result.materialized = true;
  }
  const renderRevision = view.dbAdapter.viewRenderRevision();
  if (renderRevision !== undefined) {
    result.renderRevision = renderRevision;
  }
  return { ...result, fields };
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

/** Canonical form of a computed-column expression (see {@link TViewColumnSnapshot.expr}). */
export type TCanonicalViewExpr =
  | { c: string }
  | { n: number }
  | { op: string; a: TCanonicalViewExpr[] };

/**
 * Converts a `@db.compute` expression into a serializable structure whose
 * JSON is a stable function of its meaning: leaves become the view column
 * they read (`column(path)`), literals `{ n }`, operations `{ op, a }`.
 * @since 0.1.147
 */
export function canonicalizeViewExpr(
  expr: AtscriptExprNode,
  column: (path: string) => string,
): TCanonicalViewExpr {
  if (typeof expr === "number") return { n: expr };
  if ("field" in expr) return { c: column(expr.field) };
  return { op: expr.op, a: expr.args.map((arg) => canonicalizeViewExpr(arg, column)) };
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
 * falling back to `designType`. Derived fields are left out (since 0.1.141):
 * an adapter without column introspection stores no derived column, and a
 * `physicalName` of one is its SOURCE path — reporting it as an existing
 * column would have the diff drop the source leaf.
 *
 * With `readable`, the subfields of its navigation properties are left out
 * too: a document adapter's snapshot lists them (for hash stability — see
 * `snapshotFields`) although nothing is stored under a nav field — they are
 * not columns to drop.
 */
export function snapshotToExistingColumns(
  snapshot: TTableSnapshot,
  readable?: AtscriptDbReadable,
): TExistingColumn[] {
  const navPrefixes =
    readable && readable.navFields.size > 0
      ? readable.fieldDescriptors
          .filter((fd) => readable.navFields.has(fd.path))
          .map((fd) => `${fd.physicalName}.`)
      : [];
  return snapshot.fields
    .filter((f) => !f.derived && !navPrefixes.some((p) => f.physicalName.startsWith(p)))
    .map((f) => ({
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
