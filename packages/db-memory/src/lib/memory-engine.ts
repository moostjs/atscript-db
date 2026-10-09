import { deletePath } from "@atscript/db";

import { cloneValue } from "./memory-clone";
import { pathReader } from "./memory-filter";

/**
 * Pure, store-agnostic core of the in-memory query engine: the `$sort`
 * comparator and `$select` projection, factored out of {@link MemoryAdapter} so
 * there is exactly ONE implementation. Everything here is a pure function over
 * plain `Record<string, unknown>` rows — no adapter/table state — so other
 * consumers (e.g. moost-db's value-help controller) can reuse the SAME engine
 * instead of hand-rolling a second copy. The adapter wires its own PK-derived
 * tie-break / physical-PK fields in as parameters.
 *
 * The dot-path READ / DELETE helpers (`getPath` / `deletePath`) are the
 * core's (`@atscript/db`); the dot-path WRITE helper ({@link setPath}) lives
 * here because projection (and the adapter's update path) are its only users.
 */

/**
 * Total ordering for `$sort`. `null`/`undefined` sort LOW (before any concrete
 * value); `Date`s compare by their instant; numbers numerically; everything
 * else via JS-native `<`/`>` (strings lexicographically) — NO collation or
 * locale awareness (documented divergence from the SQL adapters).
 */
export function compareLeaves(a: unknown, b: unknown): number {
  const aNil = a === null || a === undefined;
  const bNil = b === null || b === undefined;
  if (aNil && bNil) {
    return 0;
  }
  if (aNil) {
    return -1;
  }
  if (bNil) {
    return 1;
  }
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === "number" && typeof bv === "number") {
    return av < bv ? -1 : av > bv ? 1 : 0;
  }
  // JS-native ordering for strings and other leaves; the cast is load-bearing
  // only to keep `<`/`>` type-checking — runtime ordering is unchanged.
  const as = av as string | number;
  const bs = bv as string | number;
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * Dot-path setter used by inclusion projection. Creates intermediate plain
 * objects as needed; overwrites a non-object intermediate. Top-level keys and
 * nested dot-paths both work.
 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  setSegments(target, path.split("."), value);
}

/** {@link setPath} over an already-split path. */
function setSegments(target: Record<string, unknown>, segments: string[], value: unknown): void {
  let current = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = current[seg];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      current[seg] = {};
    }
    current = current[seg] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = value;
}

/** Dot-path deleter used by exclusion projection — the core's `deletePath`. */
export { deletePath };

/**
 * Stable multi-key sort from `$sort`, applied over plain rows.
 *
 * - No `$sort` (or an empty one) → returns the input array UNCHANGED (same
 *   reference, insertion order preserved) — the fast path for an unsorted read.
 * - `tieBreak`, when supplied, is the FINAL deterministic tie-break key for a
 *   TOTAL order — the adapter injects its {@link MemoryAdapter.pkKey} here so
 *   rows with equal sort keys still order deterministically. When ABSENT the
 *   sort falls back to preserving input order among equal keys (via each row's
 *   original index), so a consumer with no primary key keeps insertion order.
 * - `topK` (since 0.1.151), when supplied, asks for only the first `topK` rows
 *   of that order (e.g. `$skip + $limit`): a small one is selected in one pass
 *   instead of sorting everything. The rows returned are exactly the head of
 *   the full sort — same comparator, same stable tie handling.
 *
 * NEVER mutates the input array. Each row's sort keys are read ONCE (O(n)) and
 * its `tieBreak` only when two rows tie on every key — not inside the
 * O(n log n) comparator.
 */
export function sortRows(
  rows: Record<string, unknown>[],
  $sort?: Partial<Record<string, 1 | -1>>,
  tieBreak?: (row: Record<string, unknown>) => string | number,
  topK?: number,
): Record<string, unknown>[] {
  const keys = $sort ? Object.entries($sort) : [];
  if (keys.length === 0) {
    return rows;
  }
  const readers = keys.map(([field]) => pathReader(field));
  const desc = keys.map(([, dir]) => dir === -1);
  const decorated: SortEntry[] = rows.map((row, index) => ({
    row,
    index,
    // `Date`s become their instant once here, as `compareLeaves` would per compare.
    keys: readers.map((read) => {
      const value = read(row);
      return value instanceof Date ? value.getTime() : value;
    }),
    tie: undefined,
  }));
  const compare = (a: SortEntry, b: SortEntry): number => {
    for (let i = 0; i < desc.length; i++) {
      const cmp = compareLeaves(a.keys[i], b.keys[i]);
      if (cmp !== 0) {
        return desc[i] ? -cmp : cmp;
      }
    }
    // Deterministic tie-break: the injected key (e.g. the adapter's pkKey) for
    // a TOTAL order; otherwise the original index, preserving insertion order.
    if (tieBreak) {
      const at = (a.tie ??= tieBreak(a.row));
      const bt = (b.tie ??= tieBreak(b.row));
      return at < bt ? -1 : at > bt ? 1 : 0;
    }
    return a.index - b.index;
  };
  const head =
    topK !== undefined &&
    topK <= TOP_K_MAX &&
    topK * 4 < decorated.length &&
    totallyOrdered(decorated, desc.length)
      ? selectTop(decorated, topK, compare)
      : decorated.toSorted(compare);
  return head.map((entry) => entry.row);
}

interface SortEntry {
  row: Record<string, unknown>;
  index: number;
  keys: unknown[];
  tie: string | number | undefined;
}

/**
 * Whether every sort key holds values of ONE ordered kind — numbers (`Date`s
 * included) without `NaN`, strings, or booleans — besides `null`/missing.
 * Only then is the comparator a total order, so selecting the head gives
 * exactly the rows the full (stable) sort puts first; mixed kinds compare
 * inconsistently (`"a" < 1` and `"a" > 1` are both false), and their full
 * sort order depends on the algorithm, so it keeps the full sort.
 */
function totallyOrdered(entries: SortEntry[], keyCount: number): boolean {
  for (let i = 0; i < keyCount; i++) {
    let kind: string | undefined;
    for (const entry of entries) {
      const value = entry.keys[i];
      if (value === null || value === undefined) continue;
      const type = typeof value;
      if (type === "number" ? Number.isNaN(value) : type !== "string" && type !== "boolean") {
        return false;
      }
      if (kind === undefined) {
        kind = type;
      } else if (kind !== type) {
        return false;
      }
    }
  }
  return true;
}

/** Largest `topK` {@link sortRows} selects in one pass instead of sorting. */
const TOP_K_MAX = 128;

/**
 * The first `k` entries of the stable sort by `compare`, in order: a bounded
 * sorted buffer, each entry inserted AFTER its equals (entries arrive in input
 * order, so ties keep it — exactly as the stable full sort does).
 */
function selectTop(
  entries: SortEntry[],
  k: number,
  compare: (a: SortEntry, b: SortEntry) => number,
): SortEntry[] {
  const top: SortEntry[] = [];
  if (k <= 0) {
    return top;
  }
  for (const entry of entries) {
    if (top.length === k && compare(entry, top[k - 1]!) >= 0) {
      continue;
    }
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(entry, top[mid]!) < 0) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    top.splice(lo, 0, entry);
    if (top.length > k) {
      top.pop();
    }
  }
  return top;
}

/**
 * Applies `$skip` then `$limit` (both optional) via a single slice. No-op
 * pagination (the common unpaginated read) returns the input as-is: callers
 * pass a fresh, non-store-aliased array and copy what they return, so the
 * whole-array `.slice` copy that `slice(0, undefined)` would make is skipped.
 */
export function paginate<T>(rows: T[], skip?: number, limit?: number): T[] {
  const start = skip ?? 0;
  const end = limit === undefined ? undefined : start + limit;
  if (start === 0 && end === undefined) {
    return rows;
  }
  return rows.slice(start, end);
}

/** Options for {@link projectRow}. */
export interface ProjectRowOptions {
  /**
   * Physical field names ALWAYS kept by an inclusion projection (mirrors Mongo
   * including `_id`). The adapter passes its primary-key field(s); a consumer
   * with no PK (e.g. value-help) passes none. Ignored for exclusion / no
   * projection.
   */
  pkFields?: string[];
  /**
   * When `true`, the returned object is `structuredClone`d so it shares NO
   * structure with `row` (mutating the output leaves the input intact) — what
   * the adapter needs to keep its store authoritative. When `false`/absent the
   * output may alias nested subtrees of `row` (cheaper; for callers that own
   * their rows).
   */
  clone?: boolean;
}

/**
 * Projects a plain row per a `{ path: 0 | 1 }` projection map. Decoupled from
 * `UniquSelect`: the caller passes the resolved projection map (e.g. from
 * `$select.asProjection`) so the engine has no query-layer dependency.
 *
 * - No projection (undefined / empty) → the whole row (cloned per `clone`).
 * - INCLUSION form (first entry is `1`) → a new object with only the selected
 *   paths PLUS `opts.pkFields`. Absent fields are omitted; a present-`null`
 *   (value === null) is kept.
 * - EXCLUSION form (first entry is `0`) → a clone with those paths removed. This
 *   branch ALWAYS clones (it must own a copy to drop paths without mutating the
 *   input), so `clone: false` is a no-op here.
 *
 * Top-level and nested dot-paths are supported; exotic Mongo projection quirks
 * (array positional, `$slice`, etc.) are intentionally NOT replicated.
 *
 * Clones are `structuredClone`-equivalent. To project many rows the same way,
 * compile once with {@link compileProjection}.
 */
export function projectRow(
  row: Record<string, unknown>,
  projection?: Record<string, 0 | 1>,
  opts?: ProjectRowOptions,
): Record<string, unknown> {
  return compileProjection(projection, opts)(row);
}

/**
 * {@link projectRow} compiled for one projection: the projection map is read
 * and every dot-path split once, then applied to each row.
 */
export function compileProjection(
  projection?: Record<string, 0 | 1>,
  opts?: ProjectRowOptions,
): (row: Record<string, unknown>) => Record<string, unknown> {
  const clone = opts?.clone ?? false;
  // No projection (undefined) or an empty map → the whole row (cloned per opts),
  // collapsed into one guard the same way `sortRows` normalizes an absent `$sort`.
  const entries = projection ? Object.entries(projection) : [];
  if (entries.length === 0) {
    return clone ? cloneValue : (row) => row;
  }

  // Inclusion vs exclusion is decided by the first entry (matches UniquSelect).
  if (entries[0]![1] === 1) {
    const paths = new Set(entries.filter(([, v]) => v === 1).map(([k]) => k));
    for (const pk of opts?.pkFields ?? []) {
      paths.add(pk);
    }
    const plan = [...paths].map((path) => ({ read: pathReader(path), segments: path.split(".") }));
    return (row) => {
      const out: Record<string, unknown> = {};
      for (const { read, segments } of plan) {
        const value = read(row);
        // Absent fields are omitted; present-`null` (value === null) is kept.
        if (value !== undefined) {
          setSegments(out, segments, value);
        }
      }
      // `out` still references nested subtrees of the source row → deep-clone when
      // the caller wants an independent copy.
      return clone ? cloneValue(out) : out;
    };
  }

  // Exclusion: clone the row (that IS the output copy), then drop paths. Always
  // clones — dropping paths in place would mutate the caller's input.
  const dropped = entries.filter(([, v]) => v === 0).map(([path]) => path.split("."));
  return (row) => {
    const out = cloneValue(row);
    for (const segments of dropped) {
      deletePath(out, segments);
    }
    return out;
  };
}
