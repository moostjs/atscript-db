import { DbError } from "@atscript/db";
import type { DbControls, FilterExpr } from "@atscript/db";
import { type AggregateExpr, resolveAlias } from "@atscript/db/agg";
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
 *   the `$sort` comparator; any other `$fn` is `INVALID_QUERY`;
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
  const aggregates = $select?.aggregates ?? [];
  const aliases = aggregates.map((expr) => resolveAlias(expr));
  const keyReaders = groupBy.map((key) => groupKeyReader(key, controls));
  const accumulators = aggregates.map(accumulatorFactory);
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
    $select === undefined ? [] : [...($select.buckets ?? []).map((b) => b.alias), ...aliases];
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

/**
 * Resolves an aggregate expression to an accumulator factory (one accumulator
 * per group). Validated up front, so an unknown `$fn` is rejected even when
 * there are no rows.
 */
function accumulatorFactory(expr: AggregateExpr): () => TAccumulator {
  const field = expr.$field;
  const read = pathReader(field);
  switch (expr.$fn) {
    case "count": {
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
    case "sum":
    case "avg": {
      const avg = expr.$fn === "avg";
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
          result: () => (n === 0 ? null : avg ? sum / n : sum),
        };
      };
    }
    case "min":
    case "max": {
      const sign = expr.$fn === "min" ? -1 : 1;
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
    default:
      throw new DbError("INVALID_QUERY", [
        {
          path: "$select",
          message: `Unsupported aggregate function "${String(expr.$fn)}" — use count, sum, avg, min or max`,
        },
      ]);
  }
}
