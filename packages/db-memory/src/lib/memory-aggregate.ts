import {
  evaluateExpr,
  type DbControls,
  type FilterExpr,
  type TExprAggregate,
  type TFirstLast,
  type TRowOrderKey,
} from "@atscript/db";
import { type AggregateExpr, assertAggregateFn, resolveAlias } from "@atscript/db/agg";
import { bucketer } from "@uniqu/core";

import { buildMemoryPredicate, pathReader } from "./memory-filter";
import { compareLeaves, paginate, setPath, sortRows } from "./memory-engine";

type TRow = Record<string, unknown>;

/**
 * The in-memory grouping engine behind {@link MemoryAdapter.aggregate}: a pure
 * function over already-filtered rows (nested PHYSICAL documents), so stored
 * and provider (read-through) mode share it unchanged. Pipeline: group →
 * accumulate → `$having` → `$sort` → `$skip`/`$limit`, or → `$count` (the
 * groups that survive `$having`).
 *
 * Decisions (the SQL adapters' semantics):
 * - null and missing form ONE group; a calendar-bucket key is the
 *   `@uniqu/core` kernel label (the SQLite UDF runs the same kernel);
 * - `sum` / `avg` over no numeric value are `null`; `min` / `max` order with
 *   the `$sort` comparator; `countDistinct` counts distinct non-null values
 *   by group identity (below); any other `$fn` is `INVALID_QUERY`;
 * - group identity is type-tagged: `1` and `"1"` never share a group (a
 *   number and a bigint of one value do), `Date`s group by instant, JSON
 *   values by a key-order-independent serialization;
 * - the returned rows carry exactly what `$select` asks for (every group key
 *   without one), nested like Mongo's `$project` yields them, with
 *   object-valued leaves copied so no store-owned value escapes.
 */
export function aggregateRows(rows: readonly TRow[], controls: DbControls): TRow[] {
  const $select = controls.$select;
  const groupBy = (controls.$groupBy as string[] | undefined) ?? [];
  // Every accumulated per-group value, in `UniquSelect.computedAliases` order
  // (aggregates, row-level expression aggregates, `first` / `last`); group-level
  // expressions are evaluated afterwards.
  const entries: Array<{ alias: string; create: () => TAccumulator }> = [
    ...($select?.aggregates ?? []).map((expr) => ({
      alias: resolveAlias(expr),
      create: accumulatorFactory(expr),
    })),
    ...($select?.exprAggregates ?? []).map((e) => ({
      alias: e.alias,
      create: exprAccumulatorFactory(e),
    })),
    ...($select?.firstLast ?? []).map((fl) => ({
      alias: fl.alias,
      create: firstLastFactory(fl, $select?.rowOrder ?? []),
    })),
  ];
  const aliases = entries.map((e) => e.alias);
  const groupExprs = ($select?.exprs ?? []).map((e) => ({
    alias: e.alias,
    expr: e.expr,
    // leaves are aliases of the group row or grouped columns (read off the row, once per name)
    readers: new Map(e.names.map((name) => [name, pathReader(name)] as const)),
  }));
  const keyReaders = groupBy.map((key) => groupKeyReader(key, controls));
  const accumulators = entries.map((e) => e.create);
  const newGroup = (values: unknown[]): TGroup => ({
    values,
    accs: accumulators.map((create) => create()),
  });

  // ── group + accumulate (one pass) ───────────────────────────────────────
  let groups: Iterable<TGroup>;
  if (keyReaders.length === 0) {
    // No `$groupBy`: the whole (possibly empty) input is one group — SQL's
    // aggregate without GROUP BY always yields one row.
    const group = newGroup([]);
    for (const row of rows) {
      for (const acc of group.accs) acc.add(row);
    }
    groups = [group];
  } else {
    const byIdentity = new Map<string, TGroup>();
    for (const row of rows) {
      const values = keyReaders.map((read) => read(row));
      const identity = groupIdentity(values);
      let group = byIdentity.get(identity);
      if (!group) {
        group = newGroup(values);
        byIdentity.set(identity, group);
      }
      for (const acc of group.accs) acc.add(row);
    }
    groups = byIdentity.values();
  }

  // ── one internal row per group: every group key + every alias ─────────────
  let out: TRow[] = [];
  for (const { values, accs } of groups) {
    const row: TRow = {};
    for (let i = 0; i < groupBy.length; i++) {
      setPath(row, groupBy[i]!, values[i]);
    }
    for (let i = 0; i < aliases.length; i++) {
      row[aliases[i]!] = accs[i]!.result();
    }
    // Group-level expressions, in dependency order: leaves are aliases or group keys.
    for (const e of groupExprs) {
      row[e.alias] = evaluateExpr(e.expr, (name) =>
        Object.hasOwn(row, name) ? row[name] : e.readers.get(name)!(row),
      );
    }
    out.push(row);
  }

  // ── $having: the memory filter over the group rows ───────────────────────
  const having = controls.$having as FilterExpr | undefined;
  if (having) {
    out = out.filter(buildMemoryPredicate(having));
  }

  if (controls.$count) {
    return [{ count: out.length }];
  }

  // ── $sort (stable: ties keep first-seen group order) → $skip / $limit ────
  const paged = paginate(
    sortRows(out, controls.$sort as Partial<Record<string, 1 | -1>> | undefined),
    controls.$skip as number | undefined,
    controls.$limit as number | undefined,
  );

  // ── output columns (what `$select` asks for), copied in the same pass ────
  const fields = ($select === undefined ? groupBy : ($select.asArray ?? [])).map(
    (field) => [field, pathReader(field)] as const,
  );
  const outputAliases =
    $select === undefined
      ? []
      : [...($select.buckets ?? []).map((b) => b.alias), ...$select.computedAliases];
  return paged.map((row) => {
    const picked: TRow = {};
    for (const [field, read] of fields) {
      setPath(picked, field, copyValue(read(row) ?? null));
    }
    for (const alias of outputAliases) {
      picked[alias] = copyValue(row[alias]);
    }
    return picked;
  });
}

/** Group values and min / max results may be store-owned objects (JSON values): hand back copies. */
function copyValue(value: unknown): unknown {
  return value !== null && typeof value === "object" ? structuredClone(value) : value;
}

// ── Group keys ────────────────────────────────────────────────────────────────

interface TGroup {
  /** The group's key values, in `$groupBy` order (`null` for missing). */
  values: unknown[];
  /** One accumulator per `$select` aggregate, in order. */
  accs: TAccumulator[];
}

/** Reads one `$groupBy` key off a row: a bucket alias → its label, a path → its value. */
function groupKeyReader(key: string, controls: DbControls): (row: TRow) => unknown {
  const bucket = controls.$select?.bucketByAlias(key);
  if (bucket) {
    // Prepared once per query; the per-row call is the kernel's cheap path.
    const label = bucketer(bucket.unit, bucket.tz, bucket.weekStart);
    const read = pathReader(bucket.field);
    return (row) => label(read(row) as number | bigint | null | undefined);
  }
  const read = pathReader(key);
  return (row) => read(row) ?? null;
}

/**
 * The identity of a group's key values: one {@link identityToken} per key,
 * length-prefixed when there are several, so no value can forge a separator.
 */
function groupIdentity(values: readonly unknown[]): string {
  if (values.length === 1) return identityToken(values[0]);
  let identity = "";
  for (const value of values) {
    const token = identityToken(value);
    identity += `${token.length}:${token}`;
  }
  return identity;
}

/** A type-tagged identity token for one key value (see {@link aggregateRows}). */
function identityToken(value: unknown): string {
  if (value === null || value === undefined) return "z";
  if (value instanceof Date) return `D${value.getTime()}`;
  switch (typeof value) {
    case "string":
      return `s${value}`;
    case "number":
    case "bigint":
      // String(-0) === "0" (one group, as in SQL); NaN / ±Infinity keep their own groups.
      return `n${String(value)}`;
    case "boolean":
      return value ? "b1" : "b0";
    default:
      return `j${stableJson(value)}`;
  }
}

/** `JSON.stringify` with object keys sorted at every level. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).toSorted()) {
      sorted[k] = (v as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

// ── Accumulators ──────────────────────────────────────────────────────────────

interface TAccumulator {
  add(row: TRow): void;
  result(): unknown;
}

/** Numeric value of a measure, or `undefined` for null / missing / non-numeric. */
function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isNaN(value) ? undefined : value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/** `sum` / `avg` / `min` / `max` over a per-row arithmetic expression; NULL results are skipped like NULL fields. */
function exprAccumulatorFactory(e: TExprAggregate): () => TAccumulator {
  const readers = new Map(e.names.map((name) => [name, pathReader(name)] as const));
  return fnAccumulator(e.fn, (row) => evaluateExpr(e.expr, (field) => readers.get(field)!(row)));
}

/**
 * `first` / `last`: the value of `fl.column` on the group's representative
 * row — the least (`first`) or greatest (`last`) row by `rowOrder` (NULL
 * smallest; the primary key is the final key, so the pick is deterministic).
 */
function firstLastFactory(fl: TFirstLast, rowOrder: readonly TRowOrderKey[]): () => TAccumulator {
  const keys = rowOrder.map((k) => ({ read: pathReader(k.column), sign: k.desc ? -1 : 1 }));
  const read = pathReader(fl.column);
  const sign = fl.fn === "first" ? -1 : 1;
  const compare = (a: TRow, b: TRow) => {
    for (const k of keys) {
      const c = compareLeaves(k.read(a), k.read(b)) * k.sign;
      if (c !== 0) return c;
    }
    return 0;
  };
  return () => {
    let best: TRow | undefined;
    return {
      add: (row) => {
        if (best === undefined || compare(row, best) * sign > 0) best = row;
      },
      result: () => (best === undefined ? null : copyValue(read(best) ?? null)),
    };
  };
}

/**
 * `sum` / `avg` / `min` / `max` over the values `read` yields per row — a
 * field's, or a per-row expression's. `sum` / `avg` skip non-numeric values
 * and are `null` over none; `min` / `max` skip null / missing and order with
 * the `$sort` comparator.
 */
function fnAccumulator(
  fn: "sum" | "avg" | "min" | "max",
  read: (row: TRow) => unknown,
): () => TAccumulator {
  if (fn === "sum" || fn === "avg") {
    return () => {
      let sum = 0;
      let n = 0;
      return {
        add: (row) => {
          const v = numericValue(read(row));
          if (v !== undefined) {
            sum += v;
            n++;
          }
        },
        result: () => (n === 0 ? null : fn === "avg" ? sum / n : sum),
      };
    };
  }
  const sign = fn === "min" ? -1 : 1;
  return () => {
    let best: unknown = null;
    return {
      add: (row) => {
        const v = read(row);
        if (v == null) return;
        if (best === null || compareLeaves(v, best) * sign > 0) best = v;
      },
      result: () => best,
    };
  };
}

/**
 * Resolves a plain aggregate (`first` / `last` are {@link firstLastFactory}'s)
 * to an accumulator factory (one accumulator per group). Validated up front,
 * so an unknown `$fn` is rejected even when there are no rows.
 */
function accumulatorFactory(expr: AggregateExpr): () => TAccumulator {
  assertAggregateFn(expr.$fn);
  const field = expr.$field;
  const read = pathReader(field);
  if (expr.$fn === "count") {
    // `count(*)` counts rows, `count(f)` non-null values.
    const all = field === "*";
    return () => {
      let n = 0;
      return {
        add: (row) => {
          if (all || read(row) != null) n++;
        },
        result: () => n,
      };
    };
  }
  if (expr.$fn === "countDistinct") {
    // Distinct non-null values, by group identity: a string or boolean is
    // its own identity; numbers / bigints / `Date`s / JSON values are
    // tokenized (a number and a bigint of one value, one instant, one JSON
    // value count once) in a set of their own, so no token meets a string.
    return () => {
      const plain = new Set<unknown>();
      const tokens = new Set<string>();
      return {
        add: (row) => {
          const v = read(row);
          if (v == null) return;
          if (typeof v === "string" || typeof v === "boolean") plain.add(v);
          else tokens.add(identityToken(v));
        },
        result: () => plain.size + tokens.size,
      };
    };
  }
  return fnAccumulator(expr.$fn as "sum" | "avg" | "min" | "max", read);
}
