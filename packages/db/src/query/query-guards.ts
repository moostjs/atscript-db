import type { AggregateExpr, AggregateQuery, FilterExpr } from "@uniqu/core";
import { isPrimitive } from "@uniqu/core";

import { DbError } from "../db-error";
import type { BaseDbAdapter } from "../base-adapter";
import { resolveAlias } from "../agg";
import { findAncestorInSet, isGeoPointType, type TableMetadata } from "../table/table-metadata";
import type { TDbFieldMeta } from "../types";

/**
 * Engine-agnostic query-time guards, applied in the core layer BEFORE filter
 * translation (field-encryption spec §6, geo-index spec §4.2):
 *
 * - filters referencing an `@db.encrypted` field (incl. nested paths into an
 *   encrypted object) → `ENC_FIELD_FILTER`
 * - `$sort` on an encrypted field → `ENC_FIELD_SORT`
 * - `$groupBy` / aggregate refs on an encrypted field → `ENC_FIELD_AGG`
 * - `$geoWithin` on a non-geoPoint field → `FILTER_TYPE_MISMATCH`
 * - `$geoWithin` with a malformed circle → `INVALID_QUERY`
 * - `$geoWithin` on an adapter without geo support → `GEO_NOT_SUPPORTED`
 * - `$exists` with a non-boolean operand → `INVALID_QUERY`
 * - every filter / `$sort` / `$select` / `$groupBy` / `$having` / aggregate
 *   path must resolve to physical storage on THIS adapter and pass the
 *   capability its position (for a filter entry: its predicate class, see
 *   {@link canFilterLeaf}) needs → `INVALID_QUERY` (see {@link guardPaths}).
 *   Runs after the checks above so `ENC_*` codes keep firing first for
 *   encrypted subtrees.
 */

/** Validates a `[lng, lat]` tuple (GeoJSON coordinate order). */
export function assertGeoPoint(point: unknown, path: string): asserts point is [number, number] {
  const valid =
    Array.isArray(point) &&
    point.length === 2 &&
    typeof point[0] === "number" &&
    typeof point[1] === "number" &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    point[0] >= -180 &&
    point[0] <= 180 &&
    point[1] >= -90 &&
    point[1] <= 90;
  if (!valid) {
    throw new DbError("INVALID_QUERY", [
      {
        path,
        message: `Invalid geo point at "${path}" — expected [lng, lat] with lng ∈ [-180, 180], lat ∈ [-90, 90]`,
      },
    ]);
  }
}

function isEncryptedRef(meta: TableMetadata, field: string): boolean {
  return (
    meta.encryptedFields.has(field) || findAncestorInSet(field, meta.encryptedFields) !== undefined
  );
}

function encryptedRefError(
  code: "ENC_FIELD_FILTER" | "ENC_FIELD_SORT" | "ENC_FIELD_AGG",
  field: string,
  what: string,
): DbError {
  return new DbError(code, [{ path: field, message: `Cannot ${what} encrypted field "${field}"` }]);
}

function guardGeoWithin(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  field: string,
  value: unknown,
): void {
  const fieldType = meta.flatMap?.get(field);
  if (!fieldType || !isGeoPointType(fieldType)) {
    throw new DbError("FILTER_TYPE_MISMATCH", [
      { path: field, message: `$geoWithin requires a db.geoPoint field; "${field}" is not one` },
    ]);
  }
  const circle = value as { center?: unknown; radius?: unknown } | null;
  if (typeof circle !== "object" || circle === null || Array.isArray(circle)) {
    throw new DbError("INVALID_QUERY", [
      { path: field, message: "$geoWithin expects { center: [lng, lat], radius: meters }" },
    ]);
  }
  assertGeoPoint(circle.center, `${field}.$geoWithin.center`);
  if (typeof circle.radius !== "number" || !Number.isFinite(circle.radius) || circle.radius <= 0) {
    throw new DbError("INVALID_QUERY", [
      { path: field, message: "$geoWithin radius must be a positive number of meters" },
    ]);
  }
  if (!adapter.isGeoSearchable()) {
    throw new DbError("GEO_NOT_SUPPORTED", [
      { path: field, message: "$geoWithin is not supported by this adapter" },
    ]);
  }
}

/**
 * Walks a filter expression, rejecting encrypted-field references and
 * validating operator operands: `$geoWithin` shapes and the boolean
 * `$exists` operand (this is the one owner of that rule).
 */
export function guardFilter(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  filter: FilterExpr | undefined,
  encCode: "ENC_FIELD_FILTER" | "ENC_FIELD_AGG" = "ENC_FIELD_FILTER",
): void {
  if (!filter || typeof filter !== "object") {
    return;
  }
  const hasEncrypted = meta.encryptedFields.size > 0;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === "$and" || key === "$or") {
      for (const child of (value as FilterExpr[]) ?? []) {
        guardFilter(meta, adapter, child, encCode);
      }
      continue;
    }
    if (key === "$not") {
      guardFilter(meta, adapter, value as FilterExpr, encCode);
      continue;
    }
    if (key.startsWith("$")) {
      continue;
    }
    if (hasEncrypted && isEncryptedRef(meta, key)) {
      throw encryptedRefError(encCode, key, "filter on");
    }
    if (!isPrimitive(value)) {
      for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
        if (op === "$geoWithin") {
          guardGeoWithin(meta, adapter, key, opValue);
        } else if (op === "$exists" && typeof opValue !== "boolean") {
          throw new DbError("INVALID_QUERY", [
            { path: key, message: `$exists on "${key}" expects true or false` },
          ]);
        }
      }
    }
  }
}

/** Rejects `$sort` keys referencing encrypted fields. */
export function guardSort(meta: TableMetadata, sort: unknown): void {
  if (!sort || typeof sort !== "object" || meta.encryptedFields.size === 0) {
    return;
  }
  for (const key of Object.keys(sort as Record<string, unknown>)) {
    if (isEncryptedRef(meta, key)) {
      throw encryptedRefError("ENC_FIELD_SORT", key, "sort by");
    }
  }
}

// ── Path guard: existence + physical capability ──────────────────────────────

/** The query positions a field path can appear in. */
export type TQueryPathOp = "filter" | "sort" | "select" | "groupBy" | "having" | "aggregate";

const OP_VERB: Record<TQueryPathOp, string> = {
  filter: "filter on",
  sort: "sort by",
  select: "select",
  groupBy: "group by",
  having: "filter ($having) on",
  aggregate: "aggregate over",
};

/** Query shape accepted by {@link guardPaths} / {@link collectQueryPaths} — the raw (pre-translation) uniqu controls. */
export interface TGuardedQuery {
  filter?: FilterExpr;
  controls?: {
    $sort?: unknown;
    $select?: unknown;
    $groupBy?: unknown;
    $having?: unknown;
  };
}

function pathError(path: string, message: string): DbError {
  return new DbError("INVALID_QUERY", [{ path, message }]);
}

/**
 * The one wording for a filter-node `$`-key that is not `$and` / `$or` /
 * `$not` (uniqu's walker would treat it as a field named `$…`). The core
 * guard and the HTTP gate both answer with it; `path` is the operator itself.
 */
export function unsupportedOperatorMessage(op: string): string {
  return `Unsupported filter operator "${op}" — use $and, $or or $not`;
}

/**
 * Normalizes every accepted `$sort` form (`"a,-b"`, `["a", "-b"]`,
 * `[{ a: 1 }]`, `{ a: 1 }`) into its field names. Mirrors the HTTP layer's
 * walker so programmatic callers get the same acceptance set.
 */
export function sortFieldNames(sort: unknown): string[] {
  if (!sort) return [];
  if (typeof sort === "string") {
    const out: string[] = [];
    for (const part of sort.split(",")) {
      const name = part.trim().replace(/^[-+]/, "").split(":")[0];
      if (name) out.push(name);
    }
    return out;
  }
  if (Array.isArray(sort)) {
    const out: string[] = [];
    for (const entry of sort) {
      if (typeof entry === "string") {
        out.push(entry.replace(/^[-+]/, ""));
      } else if (entry && typeof entry === "object") {
        out.push(...Object.keys(entry as Record<string, unknown>));
      }
    }
    return out;
  }
  if (typeof sort === "object") {
    return Object.keys(sort as Record<string, unknown>);
  }
  return [];
}

// ── Filter predicate classes (shared by the core guard and the HTTP gate) ─────

/**
 * The operator class a filter entry needs from its field (since 0.1.132):
 * - `compare` — value comparison (bare values, `$eq`, `$gt`, `$in`, `$regex`, any mix);
 * - `geo` — a `$geoWithin` entry;
 * - `exists` — an entry whose sole operator is `$exists`.
 */
export type TFilterPredicate = "compare" | "geo" | "exists";

/** One filter entry, collected per occurrence: its key and the predicate class its operators need. */
export interface TFilterRef {
  path: string;
  predicate: TFilterPredicate;
}

/** The adapter-shaped capability {@link canFilterLeaf} consults (a `BaseDbAdapter` or a readable). */
type TFilterCapabilitySource = Pick<BaseDbAdapter, "canFilterField" | "isGeoSearchable">;

/** The operator each non-`compare` predicate class stands for, in `filterOps` order. */
export const FILTER_PREDICATE_OPS = { exists: "$exists", geo: "$geoWithin" } as const;

/** Classifies one filter entry's value (`{ key: value }`); operand validity is `guardFilter`'s. */
export function filterPredicateOf(value: unknown): TFilterPredicate {
  if (isPrimitive(value)) return "compare";
  const ops = value as Record<string, unknown>;
  if ("$geoWithin" in ops) return "geo";
  const keys = Object.keys(ops);
  return keys.length === 1 && keys[0] === "$exists" ? "exists" : "compare";
}

/**
 * Whether a stored leaf physically supports a filter predicate of this class
 * — the one rule the core path guard and moost-db's HTTP capability index
 * both apply:
 *
 * - `compare` → `adapter.canFilterField(fd)`;
 * - `exists` → any stored column: it tests whether the column holds a value
 *   (SQL `IS [NOT] NULL`), never its content, so the scalar veto (JSON /
 *   array storage on relational adapters) does not apply;
 * - `geo` → a `db.geoPoint` leaf on a geo-searchable adapter.
 *
 * `@db.encrypted` vetoes every class.
 */
export function canFilterLeaf(
  fd: TDbFieldMeta,
  predicate: TFilterPredicate,
  adapter: TFilterCapabilitySource,
): boolean {
  if (fd.encrypted) return false;
  switch (predicate) {
    case "exists":
      return true;
    case "geo":
      return fd.isGeoPoint === true && adapter.isGeoSearchable();
    default:
      return adapter.canFilterField(fd);
  }
}

/**
 * The operators of the non-`compare` predicate classes a leaf physically
 * accepts — named in a value-comparison rejection by the core guard, and
 * listed (under the HTTP policy) as `/meta.fields[P].filterOps`.
 */
export function narrowerFilterOps(fd: TDbFieldMeta, adapter: TFilterCapabilitySource): string[] {
  const ops: string[] = [];
  for (const [predicate, op] of Object.entries(FILTER_PREDICATE_OPS)) {
    if (canFilterLeaf(fd, predicate as TFilterPredicate, adapter)) ops.push(op);
  }
  return ops;
}

/** The rejection suffix naming {@link narrowerFilterOps} — `""` when there are none. */
export function acceptedOperatorsHint(ops: readonly string[]): string {
  return ops.length > 0 ? ` (accepted operators: ${ops.join(", ")})` : "";
}

// ── Structural path collection ───────────────────────────────────────────────

/** Every logical path a parsed query references, grouped by position (since 0.1.128). */
export interface TQueryPathRefs {
  /**
   * Filter entries (recursing through `$and` / `$or` / `$not`), one per
   * occurrence, each with its predicate class (since 0.1.132; replaces the
   * `string[]` + `geoFilter` split).
   */
  filter: TFilterRef[];
  sort: string[];
  select: string[];
  groupBy: string[];
  having: string[];
  /** Aggregate `$field`s (`*` excluded). Only populated in aggregate mode. */
  aggregate: string[];
  /** `true` in aggregate mode: `$select` entries are aggregate expressions, aliases are exempt in `$sort` / `$having`. */
  aggregateMode: boolean;
  /**
   * First filter-node `$`-key that is not `$and` / `$or` / `$not`. uniqu's
   * walker would treat it as a field named `$…` — reject instead of 500.
   */
  unsupportedOperator?: string;
}

function collectFilterKeys(
  filter: unknown,
  push: (key: string, value: unknown) => void,
  skip: ReadonlySet<string> | undefined,
  refs: TQueryPathRefs,
): void {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (refs.unsupportedOperator) return;
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) {
        for (const child of value) collectFilterKeys(child, push, skip, refs);
      }
      continue;
    }
    if (key === "$not") {
      collectFilterKeys(value, push, skip, refs);
      continue;
    }
    if (key.startsWith("$")) {
      refs.unsupportedOperator = key;
      return;
    }
    if (skip?.has(key)) continue;
    push(key, value);
  }
}

/**
 * Walks the PARSED query structure (not the flattened insights map, which
 * cannot tell `$select=assignee.name` from `$with=assignee($select=name)`)
 * and returns the root paths per position. `$with` sub-trees are not
 * visited — they are validated against their target relation separately.
 *
 * Aggregate mode is `aggregate` when given, else the presence of `$groupBy`.
 * In aggregate mode `$select` entries are aggregate expressions whose
 * `$field` is collected and whose alias (`$as`, else `fn_field` — the core's
 * `resolveAlias`) is exempted from `$sort` / `$having`; outside it non-string
 * `$select` entries are ignored (the projection seal handles them).
 */
export function collectQueryPaths(query: TGuardedQuery, aggregate?: boolean): TQueryPathRefs {
  const refs: TQueryPathRefs = {
    filter: [],
    sort: [],
    select: [],
    groupBy: [],
    having: [],
    aggregate: [],
    aggregateMode: false,
  };
  collectFilterKeys(
    query.filter,
    (path, value) => refs.filter.push({ path, predicate: filterPredicateOf(value) }),
    undefined,
    refs,
  );
  const controls = (query.controls ?? {}) as Record<string, unknown>;
  const rawGroupBy = controls.$groupBy;
  const groupBy = Array.isArray(rawGroupBy)
    ? rawGroupBy.filter((f): f is string => typeof f === "string")
    : typeof rawGroupBy === "string"
      ? [rawGroupBy]
      : [];
  refs.aggregateMode = aggregate ?? groupBy.length > 0;
  refs.groupBy = groupBy;

  const aliases = new Set<string>();
  const select = controls.$select;
  if (Array.isArray(select)) {
    for (const item of select) {
      if (typeof item === "string") {
        refs.select.push(item);
      } else if (refs.aggregateMode && item && typeof item === "object" && "$field" in item) {
        const expr = item as AggregateExpr;
        aliases.add(resolveAlias(expr));
        if (expr.$field !== "*") refs.aggregate.push(expr.$field);
      }
    }
  } else if (select && typeof select === "object") {
    refs.select.push(...Object.keys(select as Record<string, unknown>));
  }

  for (const name of sortFieldNames(controls.$sort)) {
    if (!aliases.has(name)) refs.sort.push(name);
  }
  if (refs.aggregateMode) {
    collectFilterKeys(controls.$having, (path) => refs.having.push(path), aliases, refs);
  }
  return refs;
}

// ── Path classification (shared by the core guard and the HTTP gate) ─────────

/** What a logical path is on THIS readable / adapter (since 0.1.128). */
export type TQueryPathKind =
  /** A navigation relation or anything under one — never a column of this table. */
  | "nav"
  /** A stored leaf (a non-ignored, non-nav descriptor). */
  | "leaf"
  /** A nested-object parent: flattened away on relational adapters, an unlisted descriptor on nested-object ones. */
  | "objectParent"
  /** A descendant of a JSON-stored column that this adapter cannot address (relational adapters). */
  | "jsonDescendant"
  /** A descendant of an `@db.encrypted` field (the ciphertext column covers the subtree). */
  | "encryptedDescendant"
  /** Unknown to this table. */
  | "unknown";

/** The lookups {@link classifyQueryPath} needs — `TableMetadata` and moost-db's `FieldCapabilityIndex` both provide them. */
export interface TQueryPathSource {
  navFields: ReadonlySet<string>;
  /** Stored leaves by logical path. */
  leaves: { has(path: string): boolean };
  /** Nested-object parents by logical path. */
  objectParents: { has(path: string): boolean };
  jsonParents: ReadonlySet<string>;
  encryptedFields: ReadonlySet<string>;
}

/**
 * Classifies one logical path. The rules exist once, in this order, for the
 * core backstop ({@link guardPath}) and the HTTP capability gate alike:
 *
 * 1. navigation relations (and anything under them) — `parent` is the nav
 *    head when the path is a descendant;
 * 2. a stored leaf;
 * 3. a nested-object parent;
 * 4. a descendant of a JSON-stored column — `parent` names the column;
 * 5. a descendant of an `@db.encrypted` field — `parent` names the field;
 * 6. unknown.
 */
export function classifyQueryPath(
  source: TQueryPathSource,
  path: string,
): { kind: TQueryPathKind; parent?: string } {
  if (source.navFields.has(path)) {
    return { kind: "nav" };
  }
  const navHead = findAncestorInSet(path, source.navFields);
  if (navHead !== undefined) {
    return { kind: "nav", parent: navHead };
  }
  if (source.leaves.has(path)) {
    return { kind: "leaf" };
  }
  if (source.objectParents.has(path)) {
    return { kind: "objectParent" };
  }
  const jsonParent = findAncestorInSet(path, source.jsonParents);
  if (jsonParent !== undefined) {
    return { kind: "jsonDescendant", parent: jsonParent };
  }
  const encryptedParent = findAncestorInSet(path, source.encryptedFields);
  if (encryptedParent !== undefined) {
    return { kind: "encryptedDescendant", parent: encryptedParent };
  }
  return { kind: "unknown" };
}

/** `TableMetadata` as a {@link TQueryPathSource} (descriptors are the leaves, flattened parents the object parents). */
function pathSourceOf(meta: TableMetadata): TQueryPathSource {
  return {
    navFields: meta.navFields,
    leaves: meta.descriptorByPath,
    objectParents: meta.flattenedParents,
    jsonParents: meta.jsonParents,
    encryptedFields: meta.encryptedFields,
  };
}

/**
 * Validates ONE logical path for ONE query position against this table's
 * metadata and adapter capability — the classification of
 * {@link classifyQueryPath} plus the position's physical requirement:
 *
 * - a leaf → physical capability (`canSortField` for `$sort`; for a filter
 *   entry {@link canFilterLeaf} of its `predicate` class; `canFilterField`
 *   for `$groupBy` / `$having` / aggregate `$field`s; `$select` always passes);
 * - a nested-object parent → only `$select`, and only when it expands to
 *   leaf columns (`selectExpansion`);
 * - everything else is rejected.
 *
 * `predicate` is a filter entry's class; other positions leave the default.
 *
 * Messages are the short programmatic forms; the HTTP wording (moost-db's
 * `FieldCapabilityIndex`, with `$with` hints and leaf lists) is what clients
 * see and is authoritative — the HTTP gate always answers first.
 */
export function guardPath(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  path: string,
  op: TQueryPathOp,
  predicate: TFilterPredicate = "compare",
): void {
  const verb = OP_VERB[op];
  const { kind, parent } = classifyQueryPath(pathSourceOf(meta), path);
  switch (kind) {
    case "nav":
      throw pathError(path, `Cannot ${verb} "${path}" — navigation path`);
    case "leaf": {
      if (op === "select") return;
      const fd = meta.descriptorByPath.get(path)!;
      if (op === "sort") {
        if (!adapter.canSortField(fd)) {
          throw pathError(
            path,
            `Cannot sort by "${path}" — adapter cannot sort on this storage type`,
          );
        }
        return;
      }
      if (!canFilterLeaf(fd, predicate, adapter)) {
        // Name the narrower predicates that WOULD pass (a JSON column's `$exists`).
        const hint = op === "filter" ? acceptedOperatorsHint(narrowerFilterOps(fd, adapter)) : "";
        throw pathError(
          path,
          `Cannot ${verb} "${path}" — adapter cannot filter on this storage type${hint}`,
        );
      }
      return;
    }
    case "objectParent":
      if (op === "select" && meta.selectExpansion.has(path)) return;
      throw pathError(path, `Cannot ${verb} "${path}" — nested object; use one of its leaf fields`);
    case "jsonDescendant":
      throw pathError(path, `Cannot ${verb} "${path}" — inside JSON-stored column "${parent}"`);
    case "encryptedDescendant":
      throw pathError(
        path,
        op === "select"
          ? `Cannot select "${path}" — inside encrypted field "${parent}"; select "${parent}" instead`
          : `Cannot ${verb} encrypted field "${path}"`,
      );
    default:
      throw pathError(path, `Unknown field "${path}"`);
  }
}

/**
 * Core backstop for every read / aggregate / mutation-filter entry point:
 * each referenced path (see {@link collectQueryPaths}) must exist on THIS
 * adapter with the physical capability the position needs (see
 * {@link guardPath}). Adapters may therefore assume every path they receive
 * is physical.
 *
 * In aggregate mode (`aggregate = true`) `$select` entries are aggregate
 * expressions whose `$field` is checked, `$groupBy` fields are checked, and
 * aggregate aliases (`$as` or `fn_field`) are exempt in `$sort` / `$having`.
 *
 * Returns the collected refs so callers can run further structural rules
 * (see {@link checkHavingKeys}) without walking the query again.
 */
export function guardPaths(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  query: TGuardedQuery | undefined,
  aggregate = false,
): TQueryPathRefs | undefined {
  if (!query) {
    return undefined;
  }
  const refs = collectQueryPaths(query, aggregate);
  if (refs.unsupportedOperator !== undefined) {
    throw pathError(refs.unsupportedOperator, unsupportedOperatorMessage(refs.unsupportedOperator));
  }
  for (const ref of refs.filter) guardPath(meta, adapter, ref.path, "filter", ref.predicate);
  for (const path of refs.sort) guardPath(meta, adapter, path, "sort");
  for (const path of refs.select) guardPath(meta, adapter, path, "select");
  for (const path of refs.aggregate) guardPath(meta, adapter, path, "aggregate");
  for (const path of refs.groupBy) guardPath(meta, adapter, path, "groupBy");
  for (const path of refs.having) guardPath(meta, adapter, path, "having");
  return refs;
}

/** Shared read-path guard: filter + $sort encryption checks, then the path guard. */
export function guardQuery(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  query: TGuardedQuery | undefined,
): void {
  if (!query) {
    return;
  }
  guardFilter(meta, adapter, query.filter);
  guardSort(meta, query.controls?.$sort);
  guardPaths(meta, adapter, query);
}

/**
 * `$having` is a post-aggregation filter, so a key is either an aggregate
 * alias (`$as`, else `fn_field` — already exempt in {@link collectQueryPaths})
 * or a `$groupBy` field (exact logical-path match: `metadata.clicks` grouped
 * stays valid). Any other key — a real but non-grouped column included — is
 * rejected here, once, for SDK and HTTP callers alike, instead of by the
 * engine (PostgreSQL / MySQL error, SQLite tolerance, Mongo `[]`). Returns
 * the first offending key as an error entry (`path` = the bare key, as the
 * `Unknown field` rejection uses); `undefined` when every key is valid.
 */
export function checkHavingKeys(
  refs: TQueryPathRefs,
): { path: string; message: string } | undefined {
  if (refs.having.length === 0) {
    return undefined;
  }
  const grouped = new Set(refs.groupBy);
  for (const key of refs.having) {
    if (!grouped.has(key)) {
      return {
        path: key,
        message: `$having key "${key}" must be an aggregate alias or a $groupBy field`,
      };
    }
  }
  return undefined;
}

/**
 * Aggregate-path guard: $groupBy / $select / $having encryption refs + filter
 * + $sort, then the path guard, then the `$having` key rule
 * ({@link checkHavingKeys} — after the path guard so an unknown key still
 * reads `Unknown field`).
 */
export function guardAggregate(
  meta: TableMetadata,
  adapter: BaseDbAdapter,
  query: AggregateQuery,
): void {
  guardFilter(meta, adapter, query.filter as FilterExpr | undefined);
  const controls = query.controls;
  if (meta.encryptedFields.size > 0) {
    for (const field of controls.$groupBy ?? []) {
      if (isEncryptedRef(meta, field)) {
        throw encryptedRefError("ENC_FIELD_AGG", field, "group by");
      }
    }
    if (controls.$select) {
      for (const item of controls.$select) {
        const field = typeof item === "string" ? item : item.$field;
        if (field !== "*" && isEncryptedRef(meta, field)) {
          throw encryptedRefError("ENC_FIELD_AGG", field, "aggregate over");
        }
      }
    }
    if (controls.$having) {
      guardFilter(meta, adapter, controls.$having, "ENC_FIELD_AGG");
    }
    guardSort(meta, controls.$sort);
  }
  const refs = guardPaths(meta, adapter, query as TGuardedQuery, true);
  const having = refs ? checkHavingKeys(refs) : undefined;
  if (having) {
    throw new DbError("INVALID_QUERY", [having]);
  }
}
