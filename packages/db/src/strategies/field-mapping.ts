import type {
  AggregateControls,
  AggregateQuery,
  FilterExpr,
  NullsPlacement,
  ResolvedBucket,
  ResolvedRowOrderKey,
  ResolvedSelectExpr,
  Uniquery,
  UniqueryControls,
} from "@uniqu/core";
import { isAggregateExpr, isBucketExpr } from "@uniqu/core";

import { resolveAlias } from "../agg";
import type { BaseDbAdapter } from "../base-adapter";
import type { TFieldOps } from "../ops";
import type { TResolvedBucket } from "../query/buckets";
import { INTEGER_REGEX_OP } from "../shared/search-term";
import { rewriteIntegerRegex } from "../query/integer-regex";
import { rewriteObjectNullTests } from "../query/object-null";
import { arithToExprNode, computedAliases } from "../query/aggregate-expr";
import { SOURCE_VALUE_FNS } from "../query/aggregate-fns";
import {
  UniquSelect,
  type TExprAggregate,
  type TRowOrderKey,
  type TSelectExpr,
  type TUniquComputed,
} from "../query/uniqu-select";
import {
  containsRelationFilter,
  noteRelationFilter,
  resolveRelationFilterTree,
} from "../query/relation-filter";
import {
  deletePath,
  findAncestorInSet,
  getPath,
  isPlainObject,
  selfOrAncestor,
} from "../shared/object";
import type { DbControls, DbQuery, TDbFieldMeta } from "../types";
import type { TableMetadata } from "../table/table-metadata";

/**
 * The raw (logical, pre-translation) read controls a row was fetched with —
 * what {@link FieldMappingStrategy.reconstructFromRead} needs to fill
 * `@db.column.derived` fields on document adapters and to prune the source
 * paths the caller did not ask for. `$select` is the uniqu shape (array,
 * inclusion or exclusion object); `$groupBy` the grouped query's dimensions.
 * @since 0.1.141
 */
export interface TReadControls {
  $select?: unknown;
  $groupBy?: unknown;
}

/**
 * How a document-adapter read handles the table's derived fields — a pure
 * function of the logical read controls, computed once per read (the
 * translation computes it again for an exclusion projection; no state
 * travels through the adapter).
 */
interface TDerivedReadPlan {
  /** Derived fields to fill from their source after the read: name → source path segments. */
  fill: Array<[name: string, source: readonly string[]]>;
  /** Fetched logical paths the caller did NOT ask for — deleted after filling. */
  prune: TPrunePath[];
  /** Exclusion keys the translation must drop (the source of a wanted derived field lives under them). */
  unexclude: ReadonlySet<string>;
}

/**
 * A path to delete from a row after the read, with the number of leading
 * segments to keep: an ancestor left empty by the deletion goes too — unless
 * it is one of the first `keep` (something under it was requested, so the
 * row keeps it, as the adapter's own projection would).
 */
interface TPrunePath {
  segments: readonly string[];
  keep: number;
}

const NO_PLAN: TDerivedReadPlan = { fill: [], prune: [], unexclude: new Set() };

/** The no-projection plan of a table (every derived field, nothing pruned) — built once per table. */
const fullPlans = new WeakMap<TableMetadata, TDerivedReadPlan>();

/** An object-form `$select` (inclusion or exclusion) — not an array. */
function isObjectForm(select: unknown): select is Record<string, unknown> {
  return select !== null && typeof select === "object" && !Array.isArray(select);
}

/** An exclusion projection: object form whose first flag is not `1` / `true`. */
export function isExclusionProjection(select: unknown): select is Record<string, unknown> {
  if (!isObjectForm(select)) return false;
  for (const flag of Object.values(select)) return flag !== 1 && flag !== true;
  return false;
}

/**
 * The logical keys a read names, in one pass: the `$groupBy` dimensions
 * (array or single string) and the `$select` inclusions (array-form strings,
 * object-form keys flagged `1` / `true`). Empty without a projection.
 */
function requestedKeys(controls: TReadControls | undefined): string[] {
  const out: string[] = [];
  const groupBy = controls?.$groupBy;
  if (typeof groupBy === "string") {
    out.push(groupBy);
  } else if (Array.isArray(groupBy)) {
    for (const key of groupBy) if (typeof key === "string") out.push(key);
  }
  const select = controls?.$select;
  if (Array.isArray(select)) {
    for (const item of select) if (typeof item === "string") out.push(item);
  } else if (isObjectForm(select)) {
    for (const [key, flag] of Object.entries(select)) {
      if (flag === 1 || flag === true) out.push(key);
    }
  }
  return out;
}

/** {@link TPrunePath} of `path`, keeping the ancestors something in `requested` lives under. */
function prunePath(path: string, requested: ReadonlySet<string>): TPrunePath {
  const segments = path.split(".");
  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const prefix = `${segments.slice(0, depth).join(".")}.`;
    for (const r of requested) {
      if (r.startsWith(prefix)) return { segments, keep: depth };
    }
  }
  return { segments, keep: 0 };
}

/** Deletes a pruned path from a row, then every ancestor it left empty (down to `keep`). */
function pruneNestedPath(row: Record<string, unknown>, { segments, keep }: TPrunePath): void {
  deletePath(row, segments);
  for (let depth = segments.length - 1; depth > keep; depth--) {
    const ancestor = segments.slice(0, depth);
    const value = getPath(row, ancestor);
    if (!isObjectForm(value) || Object.keys(value).length > 0) return;
    deletePath(row, ancestor);
  }
}

/**
 * Fills the `@db.column.derived` fields a read asked for from their source
 * leaf (as stored — no type guard; `null` for a missing leaf) and removes
 * the source paths the caller did not select, so an inclusion `$select` of
 * a derived field never leaks its source and an exclusion of the source
 * still yields the derived value.
 */
function fillDerived(row: Record<string, unknown>, plan: TDerivedReadPlan): void {
  for (const [name, source] of plan.fill) {
    row[name] = getPath(row, source) ?? null;
  }
  for (const path of plan.prune) {
    pruneNestedPath(row, path);
  }
}

// ── Coercion helpers ────────────────────────────────────────────────────────

/** Coerces a storage value (0/1/null) back to a JS boolean. */
export function toBool(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  return !!value;
}

/**
 * Coerces the computed aliases of aggregate rows (`min` / `max` / `first` /
 * `last` of one boolean or decimal field) the way a column of that type is
 * coerced on read — the row reverse path cannot, as an alias is no column.
 * @since 0.1.148
 */
export function coerceAliasValues(
  rows: Array<Record<string, unknown>>,
  aliases: ReadonlyMap<string, TDbFieldMeta>,
): void {
  for (const row of rows) {
    for (const [alias, fd] of aliases) {
      if (alias in row) {
        row[alias] = fd.designType === "boolean" ? toBool(row[alias]) : toDecimalString(row[alias]);
      }
    }
  }
}

export function toDecimalString(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return value;
}

// ── Abstract base ───────────────────────────────────────────────────────────

/**
 * Strategy for mapping data between logical field shapes and physical storage.
 * Two implementations: {@link DocumentFieldMapper} (nested objects, NoSQL)
 * and `RelationalFieldMapper` (flattened columns, SQL).
 */
export abstract class FieldMappingStrategy {
  // ── Read path ───────────────────────────────────────────────────────────

  /**
   * Physical row → logical row. `controls` (since 0.1.141) are the raw read
   * controls the row was fetched with — document adapters fill
   * `@db.column.derived` fields from their source paths and prune sources
   * the caller did not select; relational adapters ignore them (the derived
   * column is a real column).
   */
  abstract reconstructFromRead(
    row: Record<string, unknown>,
    meta: TableMetadata,
    controls?: TReadControls,
  ): Record<string, unknown>;

  /**
   * {@link reconstructFromRead} over every row of one read — the per-read
   * work (the derived read plan on document adapters) is done once for all
   * of them. The default maps the rows one by one.
   * @since 0.1.141
   */
  reconstructRows(
    rows: Record<string, unknown>[],
    meta: TableMetadata,
    controls?: TReadControls,
  ): Record<string, unknown>[] {
    return rows.map((row) => this.reconstructFromRead(row, meta, controls));
  }

  abstract translateQuery(query: Uniquery, meta: TableMetadata): DbQuery;

  /**
   * The physical path of a logical field path — a `__`-joined column
   * (relational) or a document path with `@db.column` renames applied.
   */
  protected abstract physicalPath(logical: string, meta: TableMetadata): string;

  /**
   * Whether {@link physicalPath} can differ from the logical path for this
   * table; `false` lets the path translations hand their input back as-is.
   */
  protected renamesPaths(_meta: TableMetadata): boolean {
    return true;
  }

  /**
   * Translates a grouped query to physical names: the filter and `$having`
   * through {@link translateFilter}, and every field path in `$groupBy`,
   * `$select` (plain and computed `$field`s) and `$sort` through
   * {@link physicalPath}. Computed aliases pass through (a bucket alias never
   * equals a field name).
   *
   * `buckets` are the query's calendar buckets as the core's normalizer
   * resolved them (`normalizeComputedSelect` — `AtscriptDbReadable.aggregate`
   * runs it before the guards); they reach adapters with `field` made
   * physical and the source descriptor as `fd`. `exprs` / `rowOrder` are the
   * arithmetic entries and `$rowOrder` keys of the same normalizer
   * (`resolveComputedSelect`): they reach adapters as `$select.exprAggregates`
   * / `.exprs` / `.rowOrder` with physical names (the primary key appended to
   * the order); `$rowOrder` itself is not forwarded (since 0.1.148).
   */
  translateAggregateQuery(
    query: AggregateQuery,
    meta: TableMetadata,
    buckets: readonly ResolvedBucket[],
    exprs: readonly ResolvedSelectExpr[] = [],
    rowOrder?: readonly ResolvedRowOrderKey[],
  ): DbQuery {
    const controls = query.controls;
    const aliases = computedAliases(controls.$select);
    const physicalBuckets: TResolvedBucket[] = buckets.map((b) => ({
      ...b,
      field: this.physicalPath(b.field, meta),
      fd: meta.descriptorByPath.get(b.field)!,
    }));
    const select = controls.$select && this.physicalSelect(controls.$select, meta);
    const computed = this.physicalComputed(meta, aliases, exprs, rowOrder, controls.$select);
    return {
      filter: this.translateFilter((query.filter ?? {}) as FilterExpr, meta),
      controls: {
        ...controls,
        $with: undefined,
        $rowOrder: undefined,
        $groupBy: this.renamesPaths(meta)
          ? controls.$groupBy.map((key) => (aliases.has(key) ? key : this.physicalPath(key, meta)))
          : controls.$groupBy,
        $select: select
          ? new UniquSelect(select, meta.allPhysicalFields, physicalBuckets, computed)
          : undefined,
        $sort: controls.$sort && this.physicalSort(controls.$sort, meta, aliases),
        $nulls: controls.$nulls && this.physicalNulls(controls.$nulls, meta, aliases),
        $having: controls.$having
          ? this.translateHaving(controls.$having, meta, aliases)
          : undefined,
      },
      insights: query.insights,
    };
  }

  /**
   * `$having` with physical keys — except the computed output `aliases`,
   * which stay as written (an alias equal to a renamed field's name,
   * `first(raisedAt):raisedAt`, is the alias, exactly as in `$sort`).
   */
  private translateHaving(
    having: FilterExpr,
    meta: TableMetadata,
    aliases: ReadonlySet<string>,
  ): FilterExpr {
    if (aliases.size === 0 || !having || typeof having !== "object") {
      return this.translateFilter(having, meta);
    }
    const out: Record<string, unknown> = {};
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(having as Record<string, unknown>)) {
      if (key === "$and" || key === "$or") {
        out[key] = (value as FilterExpr[]).map((f) => this.translateHaving(f, meta, aliases));
      } else if (key === "$not") {
        out[key] = this.translateHaving(value as FilterExpr, meta, aliases);
      } else if (aliases.has(key)) {
        out[key] = value;
      } else {
        fields[key] = value;
      }
    }
    return Object.keys(fields).length > 0
      ? { ...out, ...(this.translateFilter(fields as FilterExpr, meta) as object) }
      : (out as FilterExpr);
  }

  /**
   * The arithmetic and `$rowOrder` parts of a grouped query with PHYSICAL
   * names: a row-level operand is a column; a group-level operand stays an
   * alias, or becomes the physical name of a `$groupBy` field. The primary
   * key is appended to the order as the final ascending tie-break.
   */
  private physicalComputed(
    meta: TableMetadata,
    aliases: ReadonlySet<string>,
    exprs: readonly ResolvedSelectExpr[],
    rowOrder: readonly ResolvedRowOrderKey[] | undefined,
    select: AggregateControls["$select"],
  ): TUniquComputed {
    // The columns a `min` / `max` / `first` / `last` reads, with their descriptors
    // (an adapter whose engine cannot aggregate a type directly needs the type).
    const sources = new Map<string, TDbFieldMeta>();
    for (const item of select ?? []) {
      if (!isAggregateExpr(item) || !SOURCE_VALUE_FNS.has(item.$fn)) continue;
      const fd = meta.descriptorByPath.get(item.$field);
      if (fd) sources.set(this.physicalPath(item.$field, meta), fd);
    }
    const exprAggregates: TExprAggregate[] = [];
    const groupExprs: TSelectExpr[] = [];
    for (const e of exprs) {
      const names = new Set<string>();
      const node = arithToExprNode(e.expr, (name) => {
        const resolved =
          e.level === "group" && aliases.has(name) ? name : this.physicalPath(name, meta);
        names.add(resolved);
        return resolved;
      });
      if (e.level === "row") {
        exprAggregates.push({ fn: e.fn!, alias: e.alias, expr: node, names: [...names] });
      } else {
        groupExprs.push({ alias: e.alias, expr: node, names: [...names] });
      }
    }
    let order: TRowOrderKey[] | undefined;
    if (rowOrder?.length) {
      order = rowOrder.map((k) => ({
        column: this.physicalPath(k.field, meta),
        desc: k.desc,
        ...(k.nulls && { nulls: k.nulls }),
      }));
      for (const pk of meta.primaryKeys) {
        const column = this.physicalPath(pk, meta);
        if (!order.some((k) => k.column === column)) order.push({ column, desc: false });
      }
    }
    return { exprAggregates, exprs: groupExprs, rowOrder: order, sources };
  }

  /**
   * `$select` with its field paths made physical: array-form names and
   * computed `$field`s (`'*'` kept), or the keys of the object
   * (inclusion / exclusion) form. An aggregate's output alias is fixed
   * (`$as`) from its LOGICAL field first, so a default alias never leaks a
   * physical name (`sum(amount)` over `@db.column 'amount_cents'` stays
   * `sum_amount`); a bucket's alias is already resolved.
   */
  protected physicalSelect(
    select: NonNullable<UniqueryControls["$select"]>,
    meta: TableMetadata,
  ): NonNullable<UniqueryControls["$select"]> {
    if (!this.renamesPaths(meta)) return select;
    if (Array.isArray(select)) {
      return select.map((item: unknown) => {
        if (typeof item === "string") return this.physicalPath(item, meta);
        if (isAggregateExpr(item) || isBucketExpr(item)) {
          if (item.$field === "*") return item;
          const physical = this.physicalPath(item.$field, meta);
          if (physical === item.$field) return item;
          return isAggregateExpr(item)
            ? { ...item, $as: resolveAlias(item), $field: physical }
            : { ...item, $field: physical };
        }
        return item;
      }) as NonNullable<UniqueryControls["$select"]>;
    }
    const translated: Record<string, 0 | 1> = {};
    for (const [key, flag] of Object.entries(select as Record<string, 0 | 1>)) {
      translated[this.physicalPath(key, meta)] = flag;
    }
    return translated as NonNullable<UniqueryControls["$select"]>;
  }

  /** `$sort` with physical keys; computed `aliases` (grouped queries) pass through. */
  protected physicalSort(
    sort: NonNullable<DbControls["$sort"]>,
    meta: TableMetadata,
    aliases?: ReadonlySet<string>,
  ): DbControls["$sort"] {
    return this.physicalKeys(sort as Record<string, 1 | -1>, meta, aliases);
  }

  /**
   * `$nulls` with physical keys, like {@link physicalSort}. The core hands
   * over only the resolved entries (since 0.1.153).
   */
  protected physicalNulls(
    nulls: NonNullable<DbControls["$nulls"]>,
    meta: TableMetadata,
    aliases?: ReadonlySet<string>,
  ): DbControls["$nulls"] {
    return this.physicalKeys(nulls as Record<string, NullsPlacement>, meta, aliases);
  }

  /** `map` with its field-path keys made physical; computed `aliases` pass through. */
  private physicalKeys<V>(
    map: Record<string, V>,
    meta: TableMetadata,
    aliases?: ReadonlySet<string>,
  ): Record<string, V> {
    if (!this.renamesPaths(meta)) return map;
    const translated: Record<string, V> = {};
    for (const [key, value] of Object.entries(map)) {
      translated[aliases?.has(key) ? key : this.physicalPath(key, meta)] = value;
    }
    return translated;
  }

  /**
   * Translates a logical filter for the adapter: relational predicates are
   * resolved first (`resolveRelationFilterTree`), then every key and value
   * goes through {@link translateResolvedFilter}. `depth` is the predicate
   * level of `filter` itself (0 for a query's own filter; the related tables
   * translate predicate operands at deeper levels).
   */
  translateFilter(filter: FilterExpr, meta: TableMetadata, depth = 0): FilterExpr {
    filter = rewriteObjectNullTests(rewriteIntegerRegex(filter, meta), meta);
    const has = containsRelationFilter(filter);
    const resolved = has ? resolveRelationFilterTree(filter, meta, depth) : filter;
    return this.noteTranslated(filter, this.translateResolvedFilter(resolved, meta), has);
  }

  /**
   * `out` — the translation of the caller's `filter` — with its pre-scan
   * result (`has`) cached for the adapter's repeated `containsRelationFilter`
   * checks; only when the core built it (never the caller's own object).
   */
  protected noteTranslated(filter: unknown, out: FilterExpr, has: boolean): FilterExpr {
    if (out !== filter) noteRelationFilter(out, has);
    return out;
  }

  /**
   * Recursively walks a filter expression (predicates already resolved),
   * applying `@db.column` key renames (document paths —
   * {@link TableMetadata.documentPath}) and adapter-specific value formatting
   * via `formatFilterValue`. A resolved predicate passes through under its
   * navigation-field key.
   *
   * The relational mapper overrides this to use `leafByLogical` for deeper
   * key resolution (flattened nested paths).
   */
  protected translateResolvedFilter(filter: FilterExpr, meta: TableMetadata): FilterExpr {
    if (!filter || typeof filter !== "object") {
      return filter;
    }
    if (!meta.toStorageFormatters && meta.columnMap.size === 0 && meta.derivedFields.size === 0) {
      return filter;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
      if (key === "$and" || key === "$or") {
        result[key] = (value as FilterExpr[]).map((f) => this.translateResolvedFilter(f, meta));
      } else if (key === "$not") {
        result[key] = this.translateResolvedFilter(value as FilterExpr, meta);
      } else if (meta.navFields.has(key)) {
        // A relational predicate on a navigation field — already resolved.
        result[key] = value;
      } else if (key.startsWith("$")) {
        result[key] = value;
      } else {
        // Formatters are keyed by the field descriptor's physical name.
        const physical = this.physicalPath(key, meta);
        result[physical] = this.formatFilterValue(physical, value, meta);
      }
    }
    return result as FilterExpr;
  }

  // ── Write path ──────────────────────────────────────────────────────────

  abstract prepareForWrite(
    payload: Record<string, unknown>,
    meta: TableMetadata,
    adapter: BaseDbAdapter,
  ): Record<string, unknown>;

  abstract translatePatchKeys(
    update: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown>;

  /** `$inc` / `$mul` field-op keys to physical names ({@link physicalPath}). */
  translateOpsKeys(ops: TFieldOps, meta: TableMetadata): TFieldOps {
    if (!this.renamesPaths(meta)) return ops;
    const physical = (rec: Record<string, number>) => {
      const out: Record<string, number> = {};
      for (const key in rec) out[this.physicalPath(key, meta)] = rec[key]!;
      return out;
    };
    return { inc: ops.inc && physical(ops.inc), mul: ops.mul && physical(ops.mul) };
  }

  // ── Shared implementations ──────────────────────────────────────────────

  /**
   * Reverse-maps `@db.column` renames on a row read from storage.
   * Renames physical keys back to logical names in-place.
   */
  protected reverseColumnRenames(row: Record<string, unknown>, meta: TableMetadata): void {
    for (const [logical, physical] of meta.columnMap.entries()) {
      if (physical in row) {
        row[logical] = row[physical];
        delete row[physical];
      }
    }
  }

  /**
   * Coerces field values from storage representation to JS types
   * (booleans from 0/1, decimals from number to string).
   */
  protected coerceFieldValues(
    row: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    if (meta.booleanFields.size === 0 && meta.decimalFields.size === 0) {
      return row;
    }
    for (const field of meta.booleanFields) {
      if (field in row) {
        row[field] = toBool(row[field]);
      }
    }
    for (const field of meta.decimalFields) {
      if (field in row) {
        row[field] = toDecimalString(row[field]);
      }
    }
    return row;
  }

  /**
   * Applies adapter-specific fromStorage formatting to a row read from the database.
   * Converts storage representations back to JS values (e.g. Date → epoch ms).
   */
  protected applyFromStorageFormatters(
    row: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    if (!meta.fromStorageFormatters) {
      return row;
    }
    for (const [col, fmt] of meta.fromStorageFormatters) {
      const val = row[col];
      if (val !== null && val !== undefined) {
        row[col] = fmt(val);
      }
    }
    return row;
  }

  /**
   * Sets a value at a dot-notation path, creating intermediate objects as needed.
   */
  protected setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
    const parts = dotPath.split(".");
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] === undefined || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
  }

  /**
   * If all children of a flattened parent are null, collapse the parent to null.
   */
  protected reconstructNullParent(
    obj: Record<string, unknown>,
    parentPath: string,
    meta: TableMetadata,
  ): void {
    const parts = parentPath.split(".");
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined || current[parts[i]] === null) {
        return;
      }
      current = current[parts[i]] as Record<string, unknown>;
    }

    const lastPart = parts[parts.length - 1];
    const parentObj = current[lastPart];
    if (typeof parentObj !== "object" || parentObj === null) {
      return;
    }

    let allNull = true;
    const parentKeys = Object.keys(parentObj as Record<string, unknown>);
    for (const k of parentKeys) {
      const v = (parentObj as Record<string, unknown>)[k];
      if (v !== null && v !== undefined) {
        allNull = false;
        break;
      }
    }

    if (allNull) {
      const parentType = meta.flatMap?.get(parentPath);
      current[lastPart] = parentType?.optional ? null : {};
    }
  }

  /**
   * Applies adapter-specific value formatting to a single filter value.
   * Handles direct values, operator objects ({$gt: v}), and $in/$nin arrays.
   */
  protected formatFilterValue(physicalName: string, value: unknown, meta: TableMetadata): unknown {
    const fmt = meta.toStorageFormatters?.get(physicalName);
    if (!fmt) {
      return value;
    }

    if (value === null || value === undefined) {
      return value;
    }

    // Direct value: { field: 123 } — arrays are direct values too
    // (e.g. a geoPoint tuple equality filter), not operator objects.
    if (typeof value !== "object" || Array.isArray(value)) {
      return fmt(value);
    }

    // Class instances (ObjectId, Date, ...) are direct values too — only plain
    // objects can carry operators; rebuilding an instance from its entries
    // would destroy it.
    if (!isPlainObject(value)) {
      return fmt(value);
    }

    // Operator object: { $gt: 123, $lt: 456 }
    const ops = value as Record<string, unknown>;
    const formatted: Record<string, unknown> = {};
    for (const [op, opVal] of Object.entries(ops)) {
      if (op === INTEGER_REGEX_OP) {
        formatted[op] = opVal; // a pattern over the decimal text, not a stored value
      } else if ((op === "$in" || op === "$nin") && Array.isArray(opVal)) {
        formatted[op] = opVal.map((v) => (v === null || v === undefined ? v : fmt(v)));
      } else if (op.startsWith("$") && opVal !== null && opVal !== undefined) {
        formatted[op] = fmt(opVal);
      } else {
        formatted[op] = opVal;
      }
    }
    return formatted;
  }

  /**
   * Applies adapter-specific value formatting to prepared (physical-named) data.
   */
  protected formatWriteValues(
    data: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    if (!meta.toStorageFormatters) {
      return data;
    }
    for (const [col, fmt] of meta.toStorageFormatters) {
      const val = data[col];
      if (val !== null && val !== undefined) {
        data[col] = fmt(val);
      }
    }
    return data;
  }

  /**
   * Prepares primary key values and strips ignored fields.
   * Shared pre-processing for both document and relational write paths.
   */
  protected prepareCommon(
    data: Record<string, unknown>,
    meta: TableMetadata,
    adapter: BaseDbAdapter,
  ): void {
    // Prepare primary key values
    for (const pk of meta.primaryKeys) {
      if (data[pk] !== undefined) {
        const fieldType = meta.flatMap?.get(pk);
        if (fieldType) {
          data[pk] = adapter.prepareId(data[pk], fieldType);
        }
      }
    }

    // Strip top-level ignored fields
    for (const field of meta.ignoredFields) {
      if (!field.includes(".")) {
        delete data[field];
      }
    }

    // Strip @db.column.derived fields — computed from the row, never written
    meta.stripDerived(data);
  }
}

// ── Document field mapper (NoSQL — passthrough) ─────────────────────────────

/**
 * Field mapper for document-oriented adapters (e.g. MongoDB).
 * Nested objects are preserved as-is. Only applies column renames and
 * value coercion.
 */
export class DocumentFieldMapper extends FieldMappingStrategy {
  reconstructFromRead(
    row: Record<string, unknown>,
    meta: TableMetadata,
    controls?: TReadControls,
  ): Record<string, unknown> {
    return this._reconstruct(row, meta, this._derivedPlanFor(meta, controls));
  }

  override reconstructRows(
    rows: Record<string, unknown>[],
    meta: TableMetadata,
    controls?: TReadControls,
  ): Record<string, unknown>[] {
    const plan = this._derivedPlanFor(meta, controls);
    return rows.map((row) => this._reconstruct(row, meta, plan));
  }

  private _derivedPlanFor(
    meta: TableMetadata,
    controls: TReadControls | undefined,
  ): TDerivedReadPlan | undefined {
    return meta.derivedFields.size > 0 ? this.derivedReadPlan(controls, meta) : undefined;
  }

  private _reconstruct(
    row: Record<string, unknown>,
    meta: TableMetadata,
    plan: TDerivedReadPlan | undefined,
  ): Record<string, unknown> {
    // Coerce/format while row still has physical keys, then rename
    this.coerceFieldValues(row, meta);
    this.applyFromStorageFormatters(row, meta);
    if (meta.columnMap.size > 0) {
      this.reverseColumnRenames(row, meta);
    }
    if (plan) {
      fillDerived(row, plan);
    }
    return row;
  }

  /** See {@link TDerivedReadPlan}. */
  private derivedReadPlan(
    controls: TReadControls | undefined,
    meta: TableMetadata,
  ): TDerivedReadPlan {
    if (meta.derivedFields.size === 0) return NO_PLAN;
    const select = controls?.$select;
    const groupBy = controls?.$groupBy;
    const grouped = Array.isArray(groupBy) ? groupBy.length > 0 : typeof groupBy === "string";

    // No projection (or an empty one): every derived field, nothing pruned
    if (
      !grouped &&
      (select === undefined ||
        select === null ||
        (isObjectForm(select) && Object.keys(select).length === 0))
    ) {
      let plan = fullPlans.get(meta);
      if (!plan) {
        plan = {
          fill: [...meta.derivedFields].map(([name, d]) => [name, d.sourcePath.split(".")]),
          prune: [],
          unexclude: new Set(),
        };
        fullPlans.set(meta, plan);
      }
      return plan;
    }

    // The stored paths the read asks for (a derived field is never one of its own)
    const keys = requestedKeys(controls);
    const requested = new Set(keys.filter((key) => !meta.derivedFields.has(key)));
    const fill: TDerivedReadPlan["fill"] = [];
    const prune = new Set<string>();

    if (isExclusionProjection(select)) {
      const excluded = new Set(
        Object.entries(select)
          .filter(([, flag]) => flag === 0 || flag === false)
          .map(([key]) => key),
      );
      const unexclude = new Set<string>();
      for (const [name, derived] of meta.derivedFields) {
        if (excluded.has(name)) continue;
        fill.push([name, derived.sourcePath.split(".")]);
        // The source was excluded (itself or through an ancestor): fetch that
        // subtree for the derived value, drop it again afterwards
        for (
          let key = selfOrAncestor(derived.sourcePath, excluded);
          key !== undefined;
          key = findAncestorInSet(key, excluded)
        ) {
          unexclude.add(key);
          prune.add(key);
        }
      }
      return { fill, prune: [...prune].map((p) => prunePath(p, requested)), unexclude };
    }

    // Inclusion (array / object form) or a grouped query: the derived fields
    // named are filled; a source nobody asked for is pruned
    const names = new Set(keys);
    for (const [name, derived] of meta.derivedFields) {
      if (!names.has(name)) continue;
      fill.push([name, derived.sourcePath.split(".")]);
      if (selfOrAncestor(derived.sourcePath, requested) === undefined)
        prune.add(derived.sourcePath);
    }
    return { fill, prune: [...prune].map((p) => prunePath(p, requested)), unexclude: new Set() };
  }

  /**
   * {@link FieldMappingStrategy.physicalSelect} plus the derived-field rules
   * of an exclusion projection: a derived key is not a stored path (dropping
   * it just leaves the field unfilled), and the source subtree of a wanted
   * derived field is fetched even when excluded (pruned after the read).
   */
  protected override physicalSelect(
    select: NonNullable<UniqueryControls["$select"]>,
    meta: TableMetadata,
  ): NonNullable<UniqueryControls["$select"]> {
    if (meta.derivedFields.size === 0 || !isExclusionProjection(select)) {
      return super.physicalSelect(select, meta);
    }
    const { unexclude } = this.derivedReadPlan({ $select: select }, meta);
    const stored: Record<string, unknown> = {};
    for (const [key, flag] of Object.entries(select)) {
      if (!meta.derivedFields.has(key) && !unexclude.has(key)) stored[key] = flag;
    }
    return super.physicalSelect(stored as NonNullable<UniqueryControls["$select"]>, meta);
  }

  /**
   * Every field-path position goes through `@db.column` renames
   * ({@link TableMetadata.documentPath}): filter keys, `$select` fields
   * (array, inclusion and exclusion forms) and `$sort` keys.
   */
  translateQuery(query: Uniquery, meta: TableMetadata): DbQuery {
    const controls = query.controls;
    const select = controls?.$select && this.physicalSelect(controls.$select, meta);
    return {
      filter: this.translateFilter(query.filter as FilterExpr, meta),
      controls: {
        ...controls,
        $with: undefined,
        $select: select ? new UniquSelect(select, meta.allPhysicalFields) : undefined,
        $sort: controls?.$sort && this.physicalSort(controls.$sort, meta),
        $nulls: controls?.$nulls && this.physicalNulls(controls.$nulls, meta),
      },
      insights: query.insights,
    };
  }

  /** A document path with `@db.column` renames ({@link TableMetadata.documentPath}). */
  protected physicalPath(logical: string, meta: TableMetadata): string {
    return meta.documentPath(logical);
  }

  protected override renamesPaths(meta: TableMetadata): boolean {
    return meta.columnMap.size > 0 || meta.derivedFields.size > 0;
  }

  prepareForWrite(
    payload: Record<string, unknown>,
    meta: TableMetadata,
    adapter: BaseDbAdapter,
  ): Record<string, unknown> {
    const data = { ...payload };
    this.prepareCommon(data, meta, adapter);

    // Column renames only (no flattening)
    for (const [logical, physical] of meta.columnMap.entries()) {
      if (logical in data) {
        data[physical] = data[logical];
        delete data[logical];
      }
    }
    return this.formatWriteValues(data, meta);
  }

  /** Patch keys (top-level or decomposed dotted) to document paths. */
  translatePatchKeys(
    update: Record<string, unknown>,
    meta: TableMetadata,
  ): Record<string, unknown> {
    if (this.renamesPaths(meta)) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(update)) {
        result[this.physicalPath(key, meta)] = update[key];
      }
      return this.formatWriteValues(result, meta);
    }
    return this.formatWriteValues(update, meta);
  }
}
