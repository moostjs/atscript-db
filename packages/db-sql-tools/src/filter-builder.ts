import { walkFilter, type FilterExpr, type FilterVisitor, type RelationOp } from "@uniqu/core";
import {
  DbError,
  containsRelationFilter,
  isResolvedRelationFilter,
  type ResolvedRelationFilter,
  INTEGER_REGEX_OP,
} from "@atscript/db";

import type { SqlDialect, TGeoCircle, TSqlFragment } from "./dialect";
import { EMPTY_AND, EMPTY_OR } from "./dialect";

export interface TFilterVisitorOptions {
  /**
   * Renders a filter key as its SQL operand. Defaults to
   * `dialect.quoteIdentifier(field)`; the aggregate builder overrides it so a
   * `$having` key that names an aggregate alias renders the aggregate
   * expression (`SUM("amount")`) — PostgreSQL rejects SELECT aliases in HAVING.
   */
  columnRef?: (field: string) => string;
  /**
   * The quoted outer table or alias that relational predicates
   * (`{ nav: { $some | $none: … } }`) correlate to: their `EXISTS` subqueries
   * compare the related rows with `<qualifier>."<column>"`. Defaults to the
   * predicate's source table (`dialect.quoteTable(node.source.table)`), which
   * is right for every statement whose FROM is the bare table; a statement
   * that aliases its FROM (`FROM "items" AS "t"`) must pass that alias here.
   *
   * @since 0.1.147
   */
  qualifier?: string;
  /**
   * Alias sequence of the relational-predicate subqueries (`_rf1`, `_rf2`, …),
   * shared by the visitors of one statement so nested predicates get distinct
   * aliases. A visitor created without one starts its own.
   *
   * @internal
   * @since 0.1.147
   */
  aliasSeq?: TRelationAliasSeq;
}

/**
 * Alias counter of the relational-predicate subqueries of one statement.
 *
 * @internal
 * @since 0.1.147
 */
export interface TRelationAliasSeq {
  n: number;
}

/**
 * Creates a dialect-specific filter visitor for `walkFilter`.
 */
export function createFilterVisitor(
  dialect: SqlDialect,
  options?: TFilterVisitorOptions,
): FilterVisitor<TSqlFragment> {
  const columnRef = options?.columnRef ?? ((field: string) => dialect.quoteIdentifier(field));
  const qualifier = options?.qualifier;
  const aliasSeq = options?.aliasSeq ?? { n: 0 };
  return {
    comparison(field, op, value) {
      if ((op as string) === "$geoWithin") {
        if (dialect.geoWithin) {
          // Circle shape is validated by the core query guards before
          // translation — safe to cast here.
          return dialect.geoWithin(columnRef(field), value as unknown as TGeoCircle);
        }
        // No native geo support in this dialect — loud failure,
        // never a silent full scan with wrong semantics.
        throw new DbError("GEO_NOT_SUPPORTED", [
          { path: field, message: "$geoWithin is not supported by this adapter" },
        ]);
      }
      const col = columnRef(field);
      const v = dialect.toParam(value);

      switch (op as string) {
        case "$eq": {
          if (v === null) {
            return { sql: `${col} IS NULL`, params: [] };
          }
          return { sql: `${col} = ?`, params: [v] };
        }
        case "$ne": {
          if (v === null) {
            return { sql: `${col} IS NOT NULL`, params: [] };
          }
          return { sql: `${col} != ?`, params: [v] };
        }
        case "$gt": {
          return { sql: `${col} > ?`, params: [v] };
        }
        case "$gte": {
          return { sql: `${col} >= ?`, params: [v] };
        }
        case "$lt": {
          return { sql: `${col} < ?`, params: [v] };
        }
        case "$lte": {
          return { sql: `${col} <= ?`, params: [v] };
        }
        case "$in": {
          const arr = (value as unknown[]).map((x) => dialect.toParam(x));
          if (arr.length === 0) {
            return EMPTY_OR;
          }
          const placeholders = arr.map(() => "?").join(", ");
          return { sql: `${col} IN (${placeholders})`, params: arr };
        }
        case "$nin": {
          const arr = (value as unknown[]).map((x) => dialect.toParam(x));
          if (arr.length === 0) {
            return EMPTY_AND;
          }
          const placeholders = arr.map(() => "?").join(", ");
          return { sql: `${col} NOT IN (${placeholders})`, params: arr };
        }
        case "$exists": {
          return value
            ? { sql: `${col} IS NOT NULL`, params: [] }
            : { sql: `${col} IS NULL`, params: [] };
        }
        case "$regex": {
          return dialect.regex(col, value);
        }
        case INTEGER_REGEX_OP: {
          // Regex over the decimal text of an integer column.
          return dialect.regex(
            dialect.integerText ? dialect.integerText(col) : `CAST(${col} AS TEXT)`,
            value,
          );
        }
        default: {
          throw new Error(`Unsupported filter operator: ${String(op)}`);
        }
      }
    },

    and(children) {
      if (children.length === 0) {
        return EMPTY_AND;
      }
      return {
        sql: children.map((c) => c.sql).join(" AND "),
        params: children.flatMap((c) => c.params),
      };
    },

    or(children) {
      if (children.length === 0) {
        return EMPTY_OR;
      }
      return {
        sql: `(${children.map((c) => c.sql).join(" OR ")})`,
        params: children.flatMap((c) => c.params),
      };
    },

    not(child) {
      return {
        sql: `NOT (${child.sql})`,
        params: child.params,
      };
    },

    relation(field, op, operand) {
      if (!isResolvedRelationFilter(operand)) {
        throw new DbError("REL_FILTER_NOT_SUPPORTED", [
          {
            path: field,
            message: `Relational predicate "${op}" on "${field}" reached the SQL renderer unresolved`,
          },
        ]);
      }
      const outer = qualifier ?? dialect.quoteTable(operand.source.table);
      return renderRelation(dialect, op, operand, outer, aliasSeq);
    },
  };
}

/**
 * Renders one resolved relational predicate as a correlated `EXISTS`:
 *
 * ```sql
 * -- to / from
 * EXISTS (SELECT 1 FROM <target> AS "_rf1"
 *         WHERE "_rf1"."<pair.target>" = <outer>."<pair.source>" [AND …] [AND <inner>])
 * -- via
 * EXISTS (SELECT 1 FROM <junction> AS "_rf1" JOIN <target> AS "_rf2"
 *           ON "_rf2"."<toTarget.target>" = "_rf1"."<toTarget.junction>" [AND …]
 *         WHERE "_rf1"."<toSource.junction>" = <outer>."<toSource.source>" [AND …]
 *           [AND <junction filter on _rf1>] [AND <inner on _rf2>])
 * ```
 *
 * `$none` is `NOT EXISTS (…)`. Outer columns are always qualified (a bare
 * column would bind to the subquery's table on a self relation or a
 * same-named column). A NULL foreign-key component never satisfies `=`, so
 * such a row has no related row (`$some` false, `$none` true).
 */
function renderRelation(
  dialect: SqlDialect,
  op: RelationOp,
  node: ResolvedRelationFilter,
  outer: string,
  aliasSeq: TRelationAliasSeq,
): TSqlFragment {
  const q = (name: string) => dialect.quoteIdentifier(name);
  const nextAlias = () => q(`_rf${++aliasSeq.n}`);
  const conditions: string[] = [];
  const params: unknown[] = [];
  const addFilter = (filter: FilterExpr | undefined, alias: string) => {
    if (!filter || Object.keys(filter).length === 0) {
      return;
    }
    const visitor = createFilterVisitor(dialect, {
      columnRef: (field) => `${alias}.${q(field)}`,
      qualifier: alias,
      aliasSeq,
    });
    const fragment = walkFilter(filter, visitor);
    if (fragment) {
      conditions.push(fragment.sql);
      params.push(...fragment.params);
    }
  };

  let from: string;
  if (node.kind === "via") {
    const junction = node.junction;
    if (!junction) {
      throw new Error(`Relational predicate on "${node.nav}": a "via" relation needs a junction`);
    }
    const j = nextAlias();
    const t = nextAlias();
    const on = junction.toTarget.map((p) => `${t}.${q(p.target)} = ${j}.${q(p.junction)}`);
    from = `${dialect.quoteTable(junction.table)} AS ${j} JOIN ${dialect.quoteTable(node.target.table)} AS ${t} ON ${on.join(" AND ")}`;
    for (const p of junction.toSource) {
      conditions.push(`${j}.${q(p.junction)} = ${outer}.${q(p.source)}`);
    }
    addFilter(junction.filter, j);
    addFilter(node.filter, t);
  } else {
    const t = nextAlias();
    from = `${dialect.quoteTable(node.target.table)} AS ${t}`;
    for (const p of node.pairs) {
      conditions.push(`${t}.${q(p.target)} = ${outer}.${q(p.source)}`);
    }
    addFilter(node.filter, t);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  return {
    sql: `${op === "$none" ? "NOT " : ""}EXISTS (SELECT 1 FROM ${from}${where})`,
    params,
  };
}

const visitorCache = new WeakMap<SqlDialect, FilterVisitor<TSqlFragment>>();

function getVisitor(dialect: SqlDialect): FilterVisitor<TSqlFragment> {
  let visitor = visitorCache.get(dialect);
  if (!visitor) {
    visitor = createFilterVisitor(dialect);
    visitorCache.set(dialect, visitor);
  }
  return visitor;
}

/**
 * Translates a filter expression into a parameterized SQL WHERE clause.
 *
 * Relational predicates (`{ nav: { $some | $none: … } }`, resolved by the
 * core into `ResolvedRelationFilter` operands) render as correlated
 * `[NOT] EXISTS (…)` subqueries; `opts.qualifier` names the outer table or
 * alias they correlate to (default: the source table — see
 * {@link TFilterVisitorOptions.qualifier}). `opts.columnRef` overrides how
 * the filter's own columns render (e.g. `t."col"` for an aliased FROM).
 * Placeholders stay positional `?` in textual order.
 *
 * @param opts - since 0.1.147
 */
export function buildWhere(
  dialect: SqlDialect,
  filter: FilterExpr,
  opts?: TFilterVisitorOptions,
): TSqlFragment {
  if (!filter || Object.keys(filter).length === 0) {
    return EMPTY_AND;
  }
  const visitor =
    opts || containsRelationFilter(filter)
      ? createFilterVisitor(dialect, { ...opts, aliasSeq: opts?.aliasSeq ?? { n: 0 } })
      : getVisitor(dialect);
  return walkFilter(collapseOrEqualities(filter), visitor) ?? EMPTY_AND;
}

/**
 * Rewrites every `$or` whose branches include several equalities on ONE
 * field (`{ f: v }`, `{ f: { $eq: v } }`, `{ f: { $in: [...] } }`, v a
 * non-null scalar, all of one JS type) into one `{ f: { $in: [...] } }`
 * branch (since 0.1.165).
 * Same rows, but one predicate instead of an OR chain whose depth grows with
 * the batch: SQLite refuses an expression tree deeper than 1000, which a
 * per-row key filter over a large batch reached. Composite, null, operator
 * and lone branches are kept as they are. Returns `filter` itself when
 * nothing changes.
 */
export function collapseOrEqualities(filter: FilterExpr): FilterExpr {
  if (!filter || typeof filter !== "object") return filter;
  const node = filter as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  const and = node.$and;
  if (Array.isArray(and)) {
    const next = collapseEach(and);
    if (next !== and) (out ??= { ...node }).$and = next;
  }
  const or = node.$or;
  if (Array.isArray(or)) {
    let next = collapseEach(or);
    if (next.length > 1 && mayRepeatField(next)) next = mergeEqualityBranches(next);
    if (next !== or) (out ??= { ...node }).$or = next;
  }
  const not = node.$not;
  if (not && typeof not === "object") {
    const next = collapseOrEqualities(not as FilterExpr);
    if (next !== not) (out ??= { ...node }).$not = next;
  }
  return (out ?? filter) as FilterExpr;
}

/** `list` with each object child collapsed — the same array when none changed (copied on the first change). */
function collapseEach(list: unknown[]): unknown[] {
  let copy: unknown[] | undefined;
  for (let i = 0; i < list.length; i++) {
    const child = list[i];
    const next =
      child && typeof child === "object" ? collapseOrEqualities(child as FilterExpr) : child;
    if (next !== child) (copy ??= list.slice())[i] = next;
  }
  return copy ?? list;
}

/** The sole key of a one-key, non-operator branch — allocation-free. */
function soleField(branch: unknown): string | undefined {
  if (!branch || typeof branch !== "object" || Array.isArray(branch)) return undefined;
  let field: string | undefined;
  for (const key in branch) {
    if (field !== undefined) return undefined;
    field = key;
  }
  return field === undefined || field.startsWith("$") ? undefined : field;
}

/**
 * Cheap pre-check for {@link mergeEqualityBranches}: whether two branches
 * share a sole field (long lists go straight to the merge pass).
 */
function mayRepeatField(branches: readonly unknown[]): boolean {
  if (branches.length > 64) return true;
  for (let i = 1; i < branches.length; i++) {
    const field = soleField(branches[i]);
    if (field === undefined) continue;
    for (let j = 0; j < i; j++) if (soleField(branches[j]) === field) return true;
  }
  return false;
}

/** The `$or` branches with the equalities of each repeated field merged into one `$in`. */
function mergeEqualityBranches(branches: unknown[]): unknown[] {
  const eqs = branches.map(equalityOf);
  // Per field: how many branches, and the literals' JS type — `"mixed"` once
  // they differ: MySQL compares `col IN (1, 'a')` as strings, unlike
  // `col = 1 OR col = 'a'`.
  const fields = new Map<string, { count: number; type?: string; values?: unknown[] }>();
  for (const eq of eqs) {
    if (!eq) continue;
    let entry = fields.get(eq.field);
    if (!entry) fields.set(eq.field, (entry = { count: 0 }));
    entry.count++;
    for (const v of eq.values) {
      const t = typeof v;
      entry.type = entry.type === undefined || entry.type === t ? t : "mixed";
    }
  }
  const merges = (field: string) => {
    const entry = fields.get(field)!;
    return entry.count > 1 && entry.type !== "mixed";
  };
  if (!eqs.some((eq) => eq && merges(eq.field))) return branches;
  const out: unknown[] = [];
  for (let i = 0; i < branches.length; i++) {
    const eq = eqs[i];
    if (!eq || !merges(eq.field)) {
      out.push(branches[i]);
      continue;
    }
    const entry = fields.get(eq.field)!;
    if (!entry.values) {
      entry.values = [];
      out.push({ [eq.field]: { $in: entry.values } });
    }
    entry.values.push(...eq.values);
  }
  return out;
}

/** `{ field, values }` of a one-field equality branch, else `undefined`. */
function equalityOf(branch: unknown): { field: string; values: unknown[] } | undefined {
  if (!branch || typeof branch !== "object" || Array.isArray(branch)) return undefined;
  const keys = Object.keys(branch);
  if (keys.length !== 1 || keys[0]!.startsWith("$")) return undefined;
  const field = keys[0]!;
  const value = (branch as Record<string, unknown>)[field];
  if (isScalar(value)) return { field, values: [value] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ops = Object.keys(value);
  if (ops.length !== 1) return undefined;
  const operand = (value as Record<string, unknown>)[ops[0]!];
  if (ops[0] === "$eq" && isScalar(operand)) return { field, values: [operand] };
  if (ops[0] === "$in" && Array.isArray(operand) && operand.every(isScalar)) {
    return { field, values: operand };
  }
  return undefined;
}

function isScalar(value: unknown): boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" || t === "bigint";
}
