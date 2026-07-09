import { getPath } from "./memory-filter";

/**
 * Pure, store-agnostic core of the in-memory query engine: the `$sort`
 * comparator and `$select` projection, factored out of {@link MemoryAdapter} so
 * there is exactly ONE implementation. Everything here is a pure function over
 * plain `Record<string, unknown>` rows — no adapter/table state — so other
 * consumers (e.g. moost-db's value-help controller) can reuse the SAME engine
 * instead of hand-rolling a second copy. The adapter wires its own PK-derived
 * tie-break / physical-PK fields in as parameters.
 *
 * Dot-path READ (`getPath`) lives in {@link ./memory-filter} and is shared;
 * the dot-path WRITE/DELETE helpers ({@link setPath}/{@link deletePath}) live
 * here because projection (and the adapter's update path) are their only users.
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
  const segments = path.split(".");
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

/**
 * Dot-path deleter used by exclusion projection. No-op when any intermediate
 * segment is missing or not a plain object. Top-level keys and nested dot-paths
 * both work.
 */
export function deletePath(target: Record<string, unknown>, path: string): void {
  const segments = path.split(".");
  let current: unknown = target;
  for (let i = 0; i < segments.length - 1; i++) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return;
    }
    current = (current as Record<string, unknown>)[segments[i]!];
  }
  if (current !== null && typeof current === "object" && !Array.isArray(current)) {
    delete (current as Record<string, unknown>)[segments[segments.length - 1]!];
  }
}

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
 *
 * NEVER mutates the input array: `.map` decorates into a fresh array and
 * `.toSorted` returns another new sorted array (unlike `.sort`, which reorders
 * in place). The `tieBreak`/index is computed ONCE per row (O(n)), not inside
 * the O(n log n) comparator.
 */
export function sortRows(
  rows: Record<string, unknown>[],
  $sort?: Partial<Record<string, 1 | -1>>,
  tieBreak?: (row: Record<string, unknown>) => string | number,
): Record<string, unknown>[] {
  const keys = $sort ? Object.entries($sort) : [];
  if (keys.length === 0) {
    return rows;
  }
  return rows
    .map((row, index) => ({ row, index, tie: tieBreak?.(row) }))
    .toSorted((a, b) => {
      for (const [field, dir] of keys) {
        const cmp = compareLeaves(getPath(a.row, field), getPath(b.row, field));
        if (cmp !== 0) {
          return dir === -1 ? -cmp : cmp;
        }
      }
      // Deterministic tie-break: the injected key (e.g. the adapter's pkKey) for
      // a TOTAL order; otherwise the original index, preserving insertion order.
      if (tieBreak) {
        const at = a.tie!;
        const bt = b.tie!;
        return at < bt ? -1 : at > bt ? 1 : 0;
      }
      return a.index - b.index;
    })
    .map((decorated) => decorated.row);
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
 */
export function projectRow(
  row: Record<string, unknown>,
  projection?: Record<string, 0 | 1>,
  opts?: ProjectRowOptions,
): Record<string, unknown> {
  const clone = opts?.clone ?? false;
  // No projection (undefined) or an empty map → the whole row (cloned per opts),
  // collapsed into one guard the same way `sortRows` normalizes an absent `$sort`.
  const entries = projection ? Object.entries(projection) : [];
  if (entries.length === 0) {
    return clone ? structuredClone(row) : row;
  }

  // Inclusion vs exclusion is decided by the first entry (matches UniquSelect).
  if (entries[0]![1] === 1) {
    const paths = new Set(entries.filter(([, v]) => v === 1).map(([k]) => k));
    for (const pk of opts?.pkFields ?? []) {
      paths.add(pk);
    }
    const out: Record<string, unknown> = {};
    for (const path of paths) {
      const value = getPath(row, path);
      // Absent fields are omitted; present-`null` (value === null) is kept.
      if (value !== undefined) {
        setPath(out, path, value);
      }
    }
    // `out` still references nested subtrees of the source row → deep-clone when
    // the caller wants an independent copy.
    return clone ? structuredClone(out) : out;
  }

  // Exclusion: clone the row (that IS the output copy), then drop paths. Always
  // clones — dropping paths in place would mutate the caller's input.
  const out = structuredClone(row);
  for (const [path, v] of entries) {
    if (v === 0) {
      deletePath(out, path);
    }
  }
  return out;
}
