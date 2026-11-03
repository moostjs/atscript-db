import {
  type AggregateExpr,
  BUCKET_UNITS,
  type FilterExpr,
  WEEK_STARTS,
  walkFilter,
} from "@uniqu/core";
import {
  DbError,
  aggregateColumns,
  type DbControls,
  type TResolvedBucket,
  type UniquSelect,
} from "@atscript/db";
import { assertAggregateFn, resolveAlias, type TDbAggregateFn } from "@atscript/db/agg";

import { sqlTimeZoneLiteral } from "./common";
import type { SqlDialect, TSqlFragment } from "./dialect";
import {
  EMPTY_AND,
  finalizeParams,
  havingGroupRef,
  nullsPlacementOf,
  orderKeySql,
} from "./dialect";
import { renderArith } from "./arith";
import { buildWhere, createFilterVisitor } from "./filter-builder";
import {
  fromSourceHint,
  fromSourceParams,
  fromSourceSql,
  type TSqlDerivedSource,
  type TSqlFromSource,
} from "./from-source";

/**
 * SQL function name of each single-name aggregate. `countDistinct` is not a
 * name but a form (`COUNT(DISTINCT x)`) — see {@link renderAggCall}.
 */
export const AGG_FN_SQL: Readonly<
  Record<Exclude<TDbAggregateFn, "countDistinct" | "first" | "last">, string>
> = {
  sum: "SUM",
  avg: "AVG",
  count: "COUNT",
  min: "MIN",
  max: "MAX",
};

/**
 * Renders one aggregate call over an already-rendered argument (`*`, a quoted
 * column, a `CASE` expression): `SUM(x)`, `COUNT(DISTINCT x)`, …
 * Re-asserts the name first (`INVALID_QUERY` on an unknown one), so nothing
 * unchecked reaches SQL.
 */
export function renderAggCall(fn: unknown, arg: string, path?: string): string {
  assertAggregateFn(fn, path);
  if (fn === "countDistinct") return `COUNT(DISTINCT ${arg})`;
  // `first` / `last` are never a plain call: they read the derived table's window columns.
  return `${AGG_FN_SQL[fn as keyof typeof AGG_FN_SQL]}(${arg})`;
}

/**
 * `MIN` / `MAX` of a column the engine may not aggregate directly: a boolean
 * on a dialect with {@link SqlDialect.booleanAggregates} (PostgreSQL has no
 * `MIN(boolean)`) renders its stand-in.
 */
function pickSql(
  dialect: SqlDialect,
  select: UniquSelect | undefined,
  fn: "min" | "max",
  column: string,
  sql: string,
): string {
  const bool =
    select?.sources.get(column)?.designType === "boolean"
      ? dialect.booleanAggregates?.[fn]
      : undefined;
  return bool ? `${bool}(${sql})` : renderAggCall(fn, sql);
}

/**
 * `call(arg)` restricted to the rows whose condition column `when` (quoted)
 * is true — `<call> FILTER (WHERE <when>)`, or the argument wrapped in
 * `CASE WHEN <when> THEN <arg> END` (`*` → `1`) on a `"case"` dialect — or
 * plain `call(arg)` without a condition.
 */
function conditional(
  dialect: SqlDialect,
  arg: string,
  when: string | undefined,
  call: (arg: string) => string,
): string {
  if (when === undefined) return call(arg);
  if (dialect.conditionalAggregate === "filter") return `${call(arg)} FILTER (WHERE ${when})`;
  return call(`CASE WHEN ${when} THEN ${arg === "*" ? "1" : arg} END`);
}

/**
 * The bare aggregate call, e.g. `SUM("amount")` / `COUNT(*)` /
 * `COUNT(DISTINCT "region")`; `when` is the quoted condition column of a
 * conditional aggregate. A `countDistinct` over a field list renders
 * {@link SqlDialect.countDistinctColumns}.
 */
function aggFnSql(
  dialect: SqlDialect,
  select: UniquSelect | undefined,
  expr: AggregateExpr,
  when?: string,
) {
  const field = expr.$field as string | readonly string[];
  if (typeof field !== "string") {
    assertAggregateFn(expr.$fn);
    if (expr.$fn !== "countDistinct" || !dialect.countDistinctColumns) {
      throw new DbError("AGG_FIELD_LIST_NOT_SUPPORTED", [
        {
          path: "$select",
          message: "countDistinct over several fields is not supported by this adapter",
        },
      ]);
    }
    const columns = field.map((f) => dialect.quoteIdentifier(f));
    if (when === undefined) return dialect.countDistinctColumns(columns);
    return dialect.conditionalAggregate === "filter"
      ? `${dialect.countDistinctColumns(columns)} FILTER (WHERE ${when})`
      : dialect.countDistinctColumns(columns, when);
  }
  if (field === "*") return conditional(dialect, "*", when, (arg) => renderAggCall(expr.$fn, arg));
  const quoted = dialect.quoteIdentifier(field);
  return conditional(dialect, quoted, when, (arg) =>
    expr.$fn === "min" || expr.$fn === "max"
      ? pickSql(dialect, select, expr.$fn as "min" | "max", field, arg)
      : renderAggCall(expr.$fn, arg),
  );
}

/** Prefix of the row source's condition columns (one per conditional aggregate). */
const CONDITION_PREFIX = "__as_w";

/** The conditional aggregates of a level: alias → its condition column, and the columns in order. */
interface TConditions {
  /** Alias of a conditional aggregate → its condition column (quoted). */
  whenOf: ReadonlyMap<string, string>;
  /** The condition columns of the row source, in order: `(<filter>) AS "<name>"`. */
  columns: ReadonlyArray<{ name: string; where: FilterExpr }>;
}

/**
 * The conditions of a level's conditional aggregates (`$where`): each one is
 * a boolean column of the aggregate's row source (`__as_w0`, …), so the
 * aggregate renders parameter-free and the condition's bind parameters stay
 * where the row source renders them. `undefined` without any.
 */
function conditionsOf(
  dialect: SqlDialect,
  select: UniquSelect | undefined,
): TConditions | undefined {
  const entries: Array<{ alias: string; where: FilterExpr }> = [];
  for (const expr of select?.aggregates ?? []) {
    if (expr.$where !== undefined) entries.push({ alias: resolveAlias(expr), where: expr.$where });
  }
  for (const e of select?.exprAggregates ?? []) {
    if (e.where !== undefined) entries.push({ alias: e.alias, where: e.where });
  }
  if (entries.length === 0) return undefined;
  if (!dialect.conditionalAggregate) {
    throw new DbError("AGG_WHERE_NOT_SUPPORTED", [
      { path: "$select", message: "Conditional aggregates are not supported by this adapter" },
    ]);
  }
  const whenOf = new Map<string, string>();
  const columns = entries.map(({ alias, where }, i) => {
    const name = `${CONDITION_PREFIX}${i}`;
    whenOf.set(alias, dialect.quoteIdentifier(name));
    return { name, where };
  });
  return { whenOf, columns };
}

const BUCKET_UNIT_SET: ReadonlySet<string> = new Set(BUCKET_UNITS);
const WEEK_START_SET: ReadonlySet<string> = new Set(WEEK_STARTS);

/**
 * The dialect's label expression for one calendar bucket.
 *
 * Internal assertions, once for every dialect, before it renders:
 * - the dialect has `calendarBucket` — the user-facing `BUCKET_NOT_SUPPORTED`
 *   is the core's (`calendarBucketUnits()`), so only an adapter advertising
 *   units its dialect cannot render reaches this throw;
 * - the literals a dialect inlines (the expression is parameter-free) are in
 *   their closed sets — unit, week start, ISO week start 1..7 — and the zone
 *   passes `sqlTimeZoneLiteral`'s charset. Defense in depth: the core's
 *   normalizer already validated all of them.
 */
function bucketSql(dialect: SqlDialect, bucket: TResolvedBucket): string {
  if (!dialect.calendarBucket) {
    throw new DbError("BUCKET_NOT_SUPPORTED", [
      { path: "$select", message: "Calendar buckets are not supported by this adapter" },
    ]);
  }
  const { unit, weekStart, weekStartIso } = bucket;
  for (const [ok, value] of [
    [BUCKET_UNIT_SET.has(unit), unit],
    [WEEK_START_SET.has(weekStart), weekStart],
    [Number.isInteger(weekStartIso) && weekStartIso >= 1 && weekStartIso <= 7, weekStartIso],
  ] as const) {
    if (!ok) {
      throw new DbError("INVALID_QUERY", [
        { path: "$select", message: `Invalid calendar bucket argument "${String(value)}"` },
      ]);
    }
  }
  sqlTimeZoneLiteral(bucket.tz);
  return dialect.calendarBucket(dialect.quoteIdentifier(bucket.field), bucket);
}

/**
 * The SQL a `$groupBy` key renders as: a calendar-bucket alias renders the
 * bucket EXPRESSION (`dialect.calendarBucket`), anything else the quoted
 * column. GROUP BY, HAVING and the count query's GROUP BY use it — PostgreSQL
 * rejects SELECT aliases in HAVING and lets an input column of the same name
 * win in GROUP BY, so the expression form is the legal, unambiguous rendering
 * there (HAVING on MySQL is the exception — see `SqlDialect.bucketAliasInHaving`).
 * SELECT and GROUP BY render identical, parameter-free text (PostgreSQL /
 * MySQL `ONLY_FULL_GROUP_BY` match them structurally); ORDER BY keeps the
 * bare output alias.
 */
export function groupKeySql(dialect: SqlDialect, controls: DbControls, key: string): string {
  const bucket = controls.$select?.bucketByAlias(key);
  return bucket ? bucketSql(dialect, bucket) : dialect.quoteIdentifier(key);
}

/** Alias of the derived table `first` / `last` aggregates read from. */
const ROWS_ALIAS = "__as_rows";

/** The derived-table column of the `i`-th `first` / `last` entry. */
const firstLastColumn = (i: number) => `__as_fl${i}`;

/**
 * The SQL each computed alias stands for where an alias is not usable
 * (HAVING; other expressions): an aggregate's call, a `first` / `last`
 * derived column (aggregated: constant within its group), a row-level
 * expression aggregate's call, and every group-level expression rendered over
 * those (in dependency order, operands cast to double). A grouped column
 * renders as its quoted name.
 */
function aliasSqlMap(
  dialect: SqlDialect,
  controls: DbControls,
  conditions: TConditions | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  const select = controls.$select;
  const quote = (name: string) => dialect.quoteIdentifier(name);
  for (const expr of select?.aggregates ?? []) {
    const alias = resolveAlias(expr);
    map.set(alias, aggFnSql(dialect, select, expr, conditions?.whenOf.get(alias)));
  }
  for (const e of select?.exprAggregates ?? []) {
    map.set(
      e.alias,
      conditional(
        dialect,
        renderArith(dialect, e.expr, quote),
        conditions?.whenOf.get(e.alias),
        (arg) => renderAggCall(e.fn, arg),
      ),
    );
  }
  (select?.firstLast ?? []).forEach((fl, i) => {
    // constant within its group: any value of it, whatever the column type
    const col = quote(firstLastColumn(i));
    map.set(
      fl.alias,
      dialect.anyValue
        ? dialect.anyValue(col, select?.sources.get(fl.column))
        : renderAggCall("min", col),
    );
  });
  for (const e of select?.exprs ?? []) {
    map.set(
      e.alias,
      renderArith(dialect, e.expr, (name) => map.get(name) ?? quote(name)),
    );
  }
  return map;
}

/** A rendered HAVING and the keys its predicate names. */
interface THaving extends TSqlFragment {
  refs: ReadonlySet<string>;
}

/**
 * ` HAVING <predicate>` (leading space) + params for `controls.$having`, or
 * `undefined` when there is nothing to render. Shared by the row and the
 * count builders so both filter the same group set.
 *
 * A key that names a computed alias (`$as`, else `fn_field`) renders what the
 * alias stands for — `SUM("amount") > ?`, an expression's arithmetic — because
 * PostgreSQL does not allow a SELECT alias in HAVING (MySQL and SQLite
 * tolerate it, so the expression form keeps all three identical). A
 * calendar-bucket alias renders its bucket expression ({@link groupKeySql}),
 * or its quoted alias when the dialect sets `SqlDialect.bucketAliasInHaving`
 * (`havingGroupRef`). Other keys (grouped columns) render as plain columns.
 * `aliasSql` is the query's {@link aliasSqlMap} when the caller has built it.
 */
function havingClause(
  dialect: SqlDialect,
  controls: DbControls,
  conditions: TConditions | undefined,
  aliasSql?: ReadonlyMap<string, string>,
): THaving | undefined {
  const having = controls.$having;
  if (!having) return undefined;
  const exprByAlias = aliasSql ?? aliasSqlMap(dialect, controls, conditions);
  const refs = new Set<string>();
  const visitor = createFilterVisitor(dialect, {
    columnRef: (field) => {
      refs.add(field);
      const aggExpr = exprByAlias.get(field);
      if (aggExpr) return aggExpr;
      const bucket = controls.$select?.bucketByAlias(field);
      return bucket
        ? havingGroupRef(dialect, bucketSql(dialect, bucket), field)
        : dialect.quoteIdentifier(field);
    },
  });
  const fragment = walkFilter(having, visitor);
  if (!fragment || fragment.sql === EMPTY_AND.sql) return undefined;
  return { sql: ` HAVING ${fragment.sql}`, params: fragment.params, refs };
}

/** `<bucket expr> AS "alias"` for every calendar bucket in `$select`. */
function bucketSelectParts(dialect: SqlDialect, controls: DbControls): string[] {
  return (controls.$select?.buckets ?? []).map(
    (bucket) => `${bucketSql(dialect, bucket)} AS ${dialect.quoteIdentifier(bucket.alias)}`,
  );
}

/** ` GROUP BY <keys>` (leading space), or `""` for the whole table as one group. */
function groupByClause(dialect: SqlDialect, controls: DbControls): string {
  const keys = (controls.$groupBy as string[] | undefined) ?? [];
  return keys.length
    ? ` GROUP BY ${keys.map((key) => groupKeySql(dialect, controls, key)).join(", ")}`
    : "";
}

/**
 * Whether any of the HAVING keys is a `first` / `last` alias or a conditional
 * aggregate's — values only the row source carries — or an expression over one.
 */
function readsRowSource(
  select: UniquSelect | undefined,
  conditions: TConditions | undefined,
  refs: ReadonlySet<string>,
): boolean {
  const targets = new Set([
    ...(select?.firstLast ?? []).map((fl) => fl.alias),
    ...(conditions?.whenOf.keys() ?? []),
  ]);
  if (targets.size === 0) return false;
  const names = new Map((select?.exprs ?? []).map((e) => [e.alias, e.names] as const));
  const visit = (name: string, seen: Set<string>): boolean => {
    if (targets.has(name)) return true;
    const deps = names.get(name);
    if (!deps || seen.has(name)) return false;
    seen.add(name);
    return deps.some((dep) => visit(dep, seen));
  };
  return [...refs].some((key) => visit(key, new Set()));
}

/**
 * The columns the outer query reads from the derived table of a `first` /
 * `last` aggregate: group keys (a bucket's source for its alias), plain
 * `$select` fields, aggregate fields and the leaves of row-level expressions.
 * The `$rowOrder` columns and the `first` / `last` sources stay inside the
 * window; a group-level expression, `$having` and `$sort` read aliases or
 * group keys only.
 */
function rowColumns(controls: DbControls): string[] {
  const select = controls.$select;
  const columns = new Set<string>();
  for (const key of (controls.$groupBy as string[] | undefined) ?? []) {
    if (!select?.bucketByAlias(key)) columns.add(key);
  }
  for (const bucket of select?.buckets ?? []) columns.add(bucket.field);
  for (const field of select?.asArray ?? []) columns.add(field);
  for (const expr of select?.aggregates ?? []) {
    for (const column of aggregateColumns(expr)) columns.add(column);
  }
  for (const e of select?.exprAggregates ?? []) {
    for (const name of e.names) columns.add(name);
  }
  return [...columns];
}

/**
 * The row source of an aggregate: `FROM <table> WHERE <where>`; with `first` /
 * `last` or conditional aggregates (and `withRows`) a derived table instead —
 * the table's rows that pass the WHERE, only the columns {@link rowColumns}
 * lists, plus one boolean `(<condition>) AS "__as_w<i>"` column per
 * conditional aggregate (rendered by the filter compiler, so a condition
 * means what the same filter means) and one
 * `FIRST_VALUE(col) OVER (PARTITION BY <group keys> ORDER BY <rowOrder>)`
 * column per `first` / `last` entry (`last` over the reversed order). Each
 * group then reads its representative row's value as an aggregate (constant
 * within the group). The WHERE moves inside unchanged.
 *
 * `params` are the source's bind parameters in text order: the conditions',
 * the FROM source's (the inner level of a two-level aggregate), the WHERE's.
 */
function aggSource(
  dialect: SqlDialect,
  table: TSqlFromSource,
  where: TSqlFragment,
  controls: DbControls,
  withRows: boolean,
  conditions: TConditions | undefined,
): { hint: string; sql: string; params: unknown[] } {
  const quotedTable = fromSourceSql(dialect, table);
  const tableParams = fromSourceParams(table);
  const select = controls.$select;
  const rowOrder = select?.rowOrder;
  const firstLast = withRows && rowOrder?.length ? (select?.firstLast ?? []) : [];
  const flags = withRows ? (conditions?.columns ?? []) : [];
  if (firstLast.length === 0 && flags.length === 0) {
    return {
      hint: fromSourceHint(table),
      sql: `FROM ${quotedTable} WHERE ${where.sql}`,
      params: [...tableParams, ...where.params],
    };
  }
  const groupBy = controls.$groupBy as string[] | undefined;
  const partition = groupBy?.length
    ? `PARTITION BY ${groupBy.map((key) => groupKeySql(dialect, controls, key)).join(", ")} `
    : "";
  const order = (reverse: boolean) =>
    (rowOrder ?? [])
      .map((k) =>
        // `last` reads the forward order reversed — its NULL placement too.
        orderKeySql(
          dialect,
          dialect.quoteIdentifier(k.column),
          k.desc !== reverse,
          k.nulls && reverse ? (k.nulls === "first" ? "last" : "first") : k.nulls,
        ),
      )
      .join(", ");
  const flagParams: unknown[] = [];
  const columns = [
    ...rowColumns(controls).map((column) => dialect.quoteIdentifier(column)),
    ...flags.map(({ name, where: condition }) => {
      const predicate = buildWhere(dialect, condition);
      flagParams.push(...predicate.params);
      return `(${predicate.sql}) AS ${dialect.quoteIdentifier(name)}`;
    }),
    ...firstLast.map((fl, i) => {
      const col = dialect.quoteIdentifier(firstLastColumn(i));
      return `FIRST_VALUE(${dialect.quoteIdentifier(fl.column)}) OVER (${partition}ORDER BY ${order(fl.fn === "last")}) AS ${col}`;
    }),
  ];
  return {
    hint: "",
    sql: `FROM (SELECT ${fromSourceHint(table)}${columns.join(", ")} FROM ${quotedTable} WHERE ${where.sql}) AS ${dialect.quoteIdentifier(ROWS_ALIAS)}`,
    params: [...flagParams, ...tableParams, ...where.params],
  };
}

/** Alias of the derived table a two-level aggregate's outer level reads its inner rows from. */
const INNER_ALIAS = "__as_inner";

/**
 * The outer level of a two-level aggregate as a single-level build's
 * arguments: the inner level as its FROM source (`(<inner aggregate>) AS
 * "__as_inner"`, its bind parameters kept in order), no WHERE, and the
 * controls without their inner level.
 */
function outerLevel(
  dialect: SqlDialect,
  table: TSqlFromSource,
  where: TSqlFragment,
  controls: DbControls,
): [TSqlFromSource, TSqlFragment, DbControls] {
  const { $from: innerControls, ...outer } = controls;
  const inner = aggregateSelectRaw(dialect, table, where, innerControls as DbControls);
  const source: TSqlDerivedSource = {
    sql: `(${inner.sql}) AS ${dialect.quoteIdentifier(INNER_ALIAS)}`,
    hint: "",
    params: inner.params,
  };
  return [source, EMPTY_AND, outer];
}

/**
 * Builds a SELECT ... GROUP BY statement with aggregate functions.
 *
 * SELECT lists the plain grouped columns, then `<bucket expr> AS "alias"`
 * per calendar bucket, then every computed alias (aggregates, row-level
 * expression aggregates, `first` / `last`, group-level expressions — the
 * order of `UniquSelect.computedAliases`). Bucket expressions and the
 * aggregates are parameter-free (a condition is a column of the row source),
 * so the bind parameters follow the text: the row source's (conditions, the
 * inner level, WHERE), HAVING, LIMIT, OFFSET.
 *
 * A two-level aggregate (`controls.$from`, since 0.1.168) reads the inner
 * level's rows: `SELECT … FROM (<inner aggregate>) AS "__as_inner" …` — its
 * columns are the inner `$groupBy` keys and aliases.
 */
export function buildAggregateSelect(
  dialect: SqlDialect,
  table: TSqlFromSource,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  return finalizeParams(dialect, aggregateSelectRaw(dialect, table, where, controls));
}

/** {@link buildAggregateSelect} with positional `?` placeholders (not yet numbered). */
function aggregateSelectRaw(
  dialect: SqlDialect,
  table: TSqlFromSource,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  if (controls.$from) {
    return aggregateSelectRaw(dialect, ...outerLevel(dialect, table, where, controls));
  }
  const select = controls.$select;
  const conditions = conditionsOf(dialect, select);
  const selectParts: string[] = [];

  // Dimension fields (plain strings from $select)
  for (const f of select?.asArray ?? []) {
    selectParts.push(dialect.quoteIdentifier(f));
  }

  // Calendar buckets: `<label expr> AS "alias"`
  selectParts.push(...bucketSelectParts(dialect, controls));

  // Computed entries. Plain aggregates render directly; with expressions or
  // `first` / `last` the alias map renders each once, for the select list,
  // other expressions and HAVING alike.
  let aliasSql: Map<string, string> | undefined;
  if (select?.exprAggregates || select?.firstLast || select?.exprs) {
    aliasSql = aliasSqlMap(dialect, controls, conditions);
    for (const alias of select.computedAliases) {
      selectParts.push(`${aliasSql.get(alias)} AS ${dialect.quoteIdentifier(alias)}`);
    }
  } else {
    for (const expr of select?.aggregates ?? []) {
      const alias = resolveAlias(expr);
      selectParts.push(
        `${aggFnSql(dialect, select, expr, conditions?.whenOf.get(alias))} AS ${dialect.quoteIdentifier(alias)}`,
      );
    }
  }

  const cols = selectParts.length > 0 ? selectParts.join(", ") : "*";

  const source = aggSource(dialect, table, where, controls, true, conditions);
  let sql = `SELECT ${source.hint}${cols} ${source.sql}${groupByClause(dialect, controls)}`;
  const params = [...source.params];

  // HAVING
  const having = havingClause(dialect, controls, conditions, aliasSql);
  if (having) {
    sql += having.sql;
    params.push(...having.params);
  }

  // ORDER BY — bare names: output aliases (aggregate or bucket) are legal here on every dialect.
  // NULL is the smallest value everywhere (`orderKeySql`: NULLS FIRST / LAST where the engine
  // differs) unless `$nulls` places it. Without NULLS FIRST / LAST syntax (MySQL) the extra
  // `(… IS NULL)` key tests a computed alias's own expression: inside an expression MySQL
  // resolves a name to a table column before an alias, and an aggregate alias may be named like
  // a column (a bucket or expression alias may not — uniqu rejects that).
  if (controls.$sort) {
    const nullTest = (col: string) => () => {
      aliasSql ??= aliasSqlMap(dialect, controls, conditions);
      return aliasSql.get(col) ?? dialect.quoteIdentifier(col);
    };
    const orderParts: string[] = [];
    for (const [col, dir] of Object.entries(controls.$sort)) {
      orderParts.push(
        orderKeySql(
          dialect,
          dialect.quoteIdentifier(col),
          dir === -1,
          nullsPlacementOf(controls.$nulls, col),
          nullTest(col),
        ),
      );
    }
    if (orderParts.length > 0) {
      sql += ` ORDER BY ${orderParts.join(", ")}`;
    }
  }

  // LIMIT / OFFSET
  if (controls.$limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(controls.$limit);
  }

  if (controls.$skip !== undefined) {
    if (controls.$limit === undefined) {
      sql += ` LIMIT ${dialect.unlimitedLimit}`;
    }
    sql += ` OFFSET ?`;
    params.push(controls.$skip);
  }

  return { sql, params };
}

/**
 * Builds a COUNT query for the number of distinct groups — the groups that
 * survive `$having` when one is given (the same predicate the row query
 * renders, so `$count` agrees with the row set). Returns `{ count: N }` when
 * executed. The rows come straight from the table, unless `$having` reads a
 * `first` / `last` value or a conditional aggregate (or an expression over
 * one): only then the derived row source is built. A two-level aggregate
 * counts its outer groups over the inner level's rows.
 */
export function buildAggregateCount(
  dialect: SqlDialect,
  table: TSqlFromSource,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  if (controls.$from) {
    return buildAggregateCount(dialect, ...outerLevel(dialect, table, where, controls));
  }
  const groupFields = controls.$groupBy as string[] | undefined;
  const conditions = conditionsOf(dialect, controls.$select);
  const having = havingClause(dialect, controls, conditions);
  const countCol = `COUNT(*) AS ${dialect.quoteIdentifier("count")}`;
  if (!groupFields?.length && !having) {
    // Ungrouped aggregates are ONE result row whatever the input (even none): that is
    // what the row query returns, so that is what is counted.
    if ((controls.$select?.computedAliases.length ?? 0) > 0) {
      return finalizeParams(dialect, {
        sql: `SELECT 1 AS ${dialect.quoteIdentifier("count")}`,
        params: [],
      });
    }
    // No aggregates at all — just count all matching rows
    const sql = `SELECT ${fromSourceHint(table)}${countCol} FROM ${fromSourceSql(dialect, table)} WHERE ${where.sql}`;
    return finalizeParams(dialect, {
      sql,
      params: [...fromSourceParams(table), ...where.params],
    });
  }
  const from = aggSource(
    dialect,
    table,
    where,
    controls,
    !!having && readsRowSource(controls.$select, conditions, having.refs),
    conditions,
  );
  const groupBy = groupByClause(dialect, controls);

  // HAVING without GROUP BY treats the whole table as one group (0 or 1).
  // The inner select must then be an aggregate — SQLite rejects
  // `SELECT 1 … HAVING` without GROUP BY — so it counts instead of `SELECT 1`;
  // the subquery keeps the outer COUNT(*) at exactly one row either way.
  // A grouped inner select lists the calendar buckets (`<expr> AS alias`,
  // legal on every dialect) so a HAVING that names one by alias
  // (`SqlDialect.bucketAliasInHaving`) resolves; the expressions are
  // parameter-free, so the bind order is unchanged.
  let inner = "COUNT(*)";
  if (groupBy) {
    inner = bucketSelectParts(dialect, controls).join(", ") || "1";
  }
  const sql = `SELECT ${countCol} FROM (SELECT ${from.hint}${inner} ${from.sql}${groupBy}${having?.sql ?? ""}) AS ${dialect.quoteIdentifier("_groups")}`;
  return finalizeParams(dialect, { sql, params: [...from.params, ...(having?.params ?? [])] });
}
