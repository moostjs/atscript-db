import type { BaseDbAdapter, FilterExpr, FilterVisitor, RelationOp } from "@atscript/db";
import {
  walkFilter,
  DbError,
  getPath,
  containsRelationFilter,
  forEachResolvedRelation,
  isResolvedRelationFilter,
  type ResolvedRelationFilter,
} from "@atscript/db";

/**
 * In-memory row predicate: given a document, decide whether it matches a
 * filter. This is the single unit of currency the whole engine composes —
 * leaves, logical nodes and the top-level filter all reduce to one of these.
 */
type Predicate = (row: Record<string, unknown>) => boolean;

/**
 * Dot-path getter — the core's `getPath`: walks plain objects, returning the
 * value at the end of the path or `undefined` if any intermediate segment is
 * missing or is not a plain object.
 *
 * LIMITATION (v1, accepted): this does NOT descend into arrays. If a segment
 * resolves to an array, traversal stops and `undefined` is returned — there is
 * no positional/`$elemMatch`-style indexing. Array-of-object matching is a
 * later concern; the SQL/Mongo adapters flatten differently and we do not want
 * to fake a semantic the store can't back yet.
 */
export { getPath };

/**
 * {@link getPath} compiled for one path: split once, and a single segment is
 * a direct property read — for callers that read the same path off many rows.
 */
export function pathReader(path: string): (row: Record<string, unknown>) => unknown {
  if (!path.includes(".")) {
    return (row) => row[path];
  }
  const segments = path.split(".");
  return (row) => {
    let current: unknown = row;
    for (const seg of segments) {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[seg];
    }
    return current;
  };
}

/**
 * Deep-equality for leaf values, used by `$eq`/`$ne`/`$in`/`$nin`.
 *
 * - `Date`s compare by their instant (`getTime()`), not identity.
 * - Everything else uses strict `===`. In particular `null === null` is `true`,
 *   while `undefined` (how {@link getPath} reports a missing field) is never
 *   equal to `null` here.
 *
 * NOTE: this stays STRICT on purpose — it backs `$in`/`$nin` and unique-index
 * tuple equality. The Mongo-like `$eq: null` ⇒ "null OR missing" match is a
 * separate, loose-`==` null branch handled in {@link evalEq} BEFORE it reaches
 * `valuesEqual`, so this function never has to conflate `undefined` with `null`.
 *
 * No structural/object comparison: filter leaves are primitives, so reference
 * equality is the correct floor for anything non-primitive.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

/**
 * Mirror of `mongo-filter.ts`'s `parseRegexString`: normalize a `$regex` value
 * (or a bare `RegExp`) into a `{ pattern, flags }` pair. Accepts a `RegExp`
 * instance, a `/pattern/flags` string literal, or a plain string (treated as
 * the literal pattern with no flags).
 */
function parseRegexString(value: unknown): { pattern: string; flags: string } {
  if (value instanceof RegExp) {
    return { pattern: value.source, flags: value.flags };
  }
  const str = String(value);
  const match = str.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    return { pattern: match[1]!, flags: match[2]! };
  }
  return { pattern: str, flags: "" };
}

/**
 * Coerce an arbitrary leaf to a string for regex testing. The `unknown`
 * parameter is load-bearing: it keeps the `String()` coercion behind a typed
 * boundary so `no-base-to-string` does not fire at the call sites (where the
 * value narrows to a non-primitive `{}` and would otherwise trip the rule). Do
 * NOT inline `String(...)` at the call sites — that reintroduces the lint error.
 */
function stringifyLeaf(v: unknown): string {
  return String(v);
}

/** `$eq` semantics, factored out so `$ne` can be its exact negation. */
function evalEq(row: Record<string, unknown>, field: string, value: unknown): boolean {
  const fieldValue = getPath(row, field);
  // Mongo-like null model: `{field: null}` / `{field: {$eq: null}}` matches a
  // row whose field is `null` OR absent/undefined (missing). Loose `==` catches
  // both null and undefined in one test. This is handled BEFORE the strict
  // `valuesEqual`/Date/RegExp paths below so a missing field still matches
  // `$eq: null`. Consequently `$ne: null` (the strict negation of this) matches
  // ONLY rows whose field holds a concrete, present, non-null value.
  if (value === null) {
    return fieldValue == null;
  }
  // A bare `RegExp` value is treated as a match test (matches Mongo, where a
  // bare RegExp field value becomes a regex match rather than a literal eq).
  // A missing/`null` field never matches — the same null-guard the `$regex`
  // branch uses, so the two RegExp paths agree.
  if (value instanceof RegExp) {
    return fieldValue != null && value.test(stringifyLeaf(fieldValue));
  }
  return matchesScalar(fieldValue, value);
}

/**
 * Mongo containment: a scalar compared with an array field matches when ANY element
 * equals it (`{ labels: "bug" }` matches `["bug", "ui"]`). Non-array fields compare as before.
 */
function matchesScalar(fieldValue: unknown, value: unknown): boolean {
  if (Array.isArray(fieldValue) && !Array.isArray(value)) {
    return fieldValue.some((el) => valuesEqual(el, value));
  }
  return valuesEqual(fieldValue, value);
}

/** `$in` membership, factored out so `$nin` can be its exact negation. */
function evalIn(row: Record<string, unknown>, field: string, value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const fieldValue = getPath(row, field);
  return value.some((element) => matchesScalar(fieldValue, element));
}

/**
 * Coerce a leaf to something the JS relational operators can order. `Date`s
 * become their epoch millis; everything else is passed through. Typed as
 * `number` purely so `<`/`>` type-check — at runtime JS still orders strings
 * lexicographically and numbers numerically (see {@link evalRelational}).
 */
function toOrdinal(v: unknown): number {
  return (v instanceof Date ? v.getTime() : v) as number;
}

/**
 * `$gt`/`$gte`/`$lt`/`$lte`. A missing or `null` field never matches an
 * ordering comparison. `Date` operands are normalized to epoch millis; all
 * other comparisons use plain JS ordering (numbers numerically, strings
 * lexicographically) — NO collation or locale awareness. This intentionally
 * differs from SQL engines' collated ordering.
 */
function evalRelational(
  row: Record<string, unknown>,
  field: string,
  op: string,
  value: unknown,
): boolean {
  const fieldValue = getPath(row, field);
  if (fieldValue === undefined || fieldValue === null) {
    return false;
  }
  const a = toOrdinal(fieldValue);
  const b = toOrdinal(value);
  switch (op) {
    case "$gt":
      return a > b;
    case "$gte":
      return a >= b;
    case "$lt":
      return a < b;
    case "$lte":
      return a <= b;
    default:
      return false;
  }
}

/**
 * Visitor that assembles an in-memory {@link Predicate} from a `FilterExpr`.
 *
 * The STRUCTURE (which logical/comparison nodes exist and how they nest) is
 * dictated by the shared {@link walkFilter} walker — the same one the SQL and
 * Mongo adapters use — so structural parity is guaranteed by construction. Only
 * the leaf/composition SEMANTICS below are this adapter's own, JS-native
 * contract.
 */
const memoryVisitor: FilterVisitor<Predicate> = {
  // A row matches iff EVERY child matches. Empty `$and` → always true
  // (vacuous truth; also how `walkFilter` normalizes an empty node).
  and(children: Predicate[]): Predicate {
    return (row) => children.every((child) => child(row));
  },

  // A row matches iff SOME child matches. Empty `$or` → matches NOTHING
  // (mirrors mongo-filter's `_impossible`: an empty disjunction is false).
  or(children: Predicate[]): Predicate {
    return (row) => children.some((child) => child(row));
  },

  // Logical negation of the (single) child predicate. Equivalent to Mongo's
  // `$nor: [child]` for the single-child case `walkFilter` produces.
  not(child: Predicate): Predicate {
    return (row) => !child(row);
  },

  comparison(field, op, value): Predicate {
    switch (op) {
      // Equality. Mongo-like null model: `$eq: null` matches a field that is
      // `null` OR absent/undefined (missing). For a concrete (non-null) value a
      // missing field reads as `undefined` and never matches.
      case "$eq":
        return (row) => evalEq(row, field, value);

      // Strict negation of `$eq`. For a concrete value, a MISSING field is "not
      // equal" so `$ne` matches it (→ true). For `$ne: null` the null model
      // flips this: since `$eq: null` matches null AND missing, `$ne: null`
      // matches ONLY a field with a concrete, present, non-null value.
      case "$ne":
        return (row) => !evalEq(row, field, value);

      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte":
        return (row) => evalRelational(row, field, op, value);

      // Membership: true iff the field equals some array element.
      case "$in":
        return (row) => evalIn(row, field, value);

      // Negated membership: true when the field is absent or matches nothing.
      case "$nin":
        return (row) => !evalIn(row, field, value);

      // Regex match. Built once; a missing/`null` field never matches, exactly
      // like the `$eq`-with-RegExp shorthand above.
      case "$regex": {
        const { pattern, flags } = parseRegexString(value);
        const regex = new RegExp(pattern, flags);
        return (row) => {
          const fieldValue = getPath(row, field);
          return fieldValue != null && regex.test(stringifyLeaf(fieldValue));
        };
      }

      // `$exists` = "holds a value" (a stored null counts as absent, as in SQL):
      // `true` ⇔ `$ne: null`, `false` ⇔ `$eq: null`. See docs/api/queries.md.
      case "$exists":
        return (row) => value === !evalEq(row, field, null);

      // Any operator outside the ComparisonOp union (e.g. `$geoWithin`) is not
      // representable by an in-memory scan — surface it as an invalid query
      // rather than silently mismatching. `op` is statically `never` here (the
      // union is exhausted above) but carries the real string at runtime.
      default: {
        const unsupportedOp: string = op;
        throw new DbError("INVALID_QUERY", [
          { path: field, message: `Unsupported filter operator: ${unsupportedOp}` },
        ]);
      }
    }
  },

  // A relational predicate reaching the unprepared (static) visitor — the
  // caller skipped `prepareRelationSets`; fail loud instead of mismatching.
  relation(field, op, operand): Predicate {
    return relationPredicate(undefined, field, op, operand);
  },
};

// ── Relational predicates ($some / $none, since 0.1.147) ───────────────────

/**
 * Per-predicate correlation sets: for every {@link ResolvedRelationFilter} of
 * a filter, the SOURCE correlation tuples (see {@link correlationKey}) that
 * have at least one related row matching the predicate's inner filter.
 * Built asynchronously by {@link prepareRelationSets}; consumed synchronously
 * by {@link buildMemoryPredicate}.
 */
export type RelationSets = ReadonlyMap<ResolvedRelationFilter, ReadonlySet<string>>;

/** Loads the rows of the table an adapter serves (one snapshot per call site's choosing). */
export type MemoryRowLoader = (adapter: BaseDbAdapter) => Promise<Record<string, unknown>[]>;

/**
 * Identity of the key tuple `fields` of `row` (dot-paths read nested), or
 * `undefined` when a component is `null` / missing — a NULL key component
 * never correlates (SQL `=` semantics: `$some` false, `$none` true).
 * Every component is type-tagged (see {@link keyPart}), matching the strict
 * equality the memory filter uses everywhere (`valuesEqual`): `1` ≠ `"1"`,
 * `5n` ≠ `"5n"`, a `Date` ≠ its ISO string; `Date`s compare by instant.
 */
function correlationKey(
  row: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  const parts: string[] = [];
  for (const field of fields) {
    const part = keyPart(getPath(row, field));
    if (part === undefined) {
      return undefined;
    }
    parts.push(part);
  }
  return JSON.stringify(parts);
}

/**
 * Type-tagged identity of one key component, or `undefined` when it never
 * equals anything (`null` / missing, `NaN`).
 */
function keyPart(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return `s:${value}`;
    case "number":
      return Number.isNaN(value) ? undefined : `n:${value === 0 ? 0 : value}`;
    case "bigint":
      return `b:${value}`;
    case "boolean":
      return `t:${value}`;
    case "undefined":
      return undefined;
    default:
      if (value === null) return undefined;
      if (value instanceof Date) {
        const time = value.getTime();
        return Number.isNaN(time) ? undefined : `d:${time}`;
      }
      return `o:${JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v))}`;
  }
}

/** Source-side correlation columns of a resolved predicate (physical names). */
function sourceColumns(node: ResolvedRelationFilter): string[] {
  return node.junction
    ? node.junction.toSource.map((p) => p.source)
    : node.pairs.map((p) => p.source);
}

/**
 * The visitor's `relation` callback: a row satisfies `$some` when its source
 * correlation tuple is in the predicate's prepared set, `$none` otherwise.
 */
function relationPredicate(
  sets: RelationSets | undefined,
  field: string,
  op: RelationOp,
  operand: FilterExpr,
): Predicate {
  const node = operand as unknown;
  const set = isResolvedRelationFilter(node) ? sets?.get(node) : undefined;
  if (!set) {
    throw new DbError("REL_FILTER_NOT_SUPPORTED", [
      {
        path: field,
        message: `Relational predicate "${op}" on "${field}" was not prepared — call prepareRelationSets() before buildMemoryPredicate()`,
      },
    ]);
  }
  const columns = sourceColumns(node as ResolvedRelationFilter);
  const some = op === "$some";
  return (row) => {
    const key = correlationKey(row, columns);
    return (key !== undefined && set.has(key)) === some;
  };
}

/**
 * Resolves every relational predicate of a TRANSLATED filter (nested ones
 * included) into a correlation set, loading each related table through
 * `load`:
 *
 * - `to` / `from`: the related rows matching the inner filter contribute their
 *   `pairs[].target` tuples — equal to the source tuple (`pairs[].source`) of
 *   every row that has such a related row.
 * - `via`: the matching related rows' `junction.toTarget[].target` tuples
 *   select junction rows (also filtered by the junction part of
 *   `@db.rel.filter`), which contribute their `junction.toSource[].junction`
 *   tuples.
 *
 * Nested predicates are prepared against the related table's rows first
 * (their source is this predicate's target). Returns `undefined` when the
 * filter holds no predicate — callers then stay on the plain synchronous path.
 *
 * @since 0.1.147
 */
export async function prepareRelationSets(
  filter: FilterExpr | undefined,
  load: MemoryRowLoader,
): Promise<RelationSets | undefined> {
  if (!containsRelationFilter(filter)) {
    return undefined;
  }
  const sets = new Map<ResolvedRelationFilter, Set<string>>();
  await prepareLevel(filter, load, sets);
  return sets;
}

/** Prepares the predicates at one level of `filter` (and, recursively, their operands). */
async function prepareLevel(
  filter: unknown,
  load: MemoryRowLoader,
  sets: Map<ResolvedRelationFilter, Set<string>>,
): Promise<void> {
  const nodes: ResolvedRelationFilter[] = [];
  forEachResolvedRelation(filter, (node) => nodes.push(node), false);
  for (const node of nodes) {
    if (!sets.has(node)) {
      sets.set(node, await correlationSet(node, load, sets));
    }
  }
}

/** Matching rows of `adapter`'s table for `filter` (its own predicates prepared first). */
async function matchingRows(
  adapter: BaseDbAdapter,
  filter: FilterExpr | undefined,
  load: MemoryRowLoader,
  sets: Map<ResolvedRelationFilter, Set<string>>,
): Promise<Record<string, unknown>[]> {
  const rows = await load(adapter);
  if (!filter || Object.keys(filter).length === 0) {
    return rows;
  }
  await prepareLevel(filter, load, sets);
  return rows.filter(buildMemoryPredicate(filter, sets));
}

/** The source correlation tuples that have a related row matching `node`. */
async function correlationSet(
  node: ResolvedRelationFilter,
  load: MemoryRowLoader,
  sets: Map<ResolvedRelationFilter, Set<string>>,
): Promise<Set<string>> {
  const targets = await matchingRows(node.target.adapter, node.filter, load, sets);
  const result = new Set<string>();
  if (!node.junction) {
    const columns = node.pairs.map((p) => p.target);
    for (const row of targets) {
      const key = correlationKey(row, columns);
      if (key !== undefined) result.add(key);
    }
    return result;
  }
  const { junction } = node;
  const targetKeys = new Set<string>();
  const targetColumns = junction.toTarget.map((p) => p.target);
  for (const row of targets) {
    const key = correlationKey(row, targetColumns);
    if (key !== undefined) targetKeys.add(key);
  }
  if (targetKeys.size === 0) {
    return result;
  }
  const toTarget = junction.toTarget.map((p) => p.junction);
  const toSource = junction.toSource.map((p) => p.junction);
  for (const row of await matchingRows(junction.adapter, junction.filter, load, sets)) {
    const targetKey = correlationKey(row, toTarget);
    if (targetKey === undefined || !targetKeys.has(targetKey)) continue;
    const sourceKey = correlationKey(row, toSource);
    if (sourceKey !== undefined) result.add(sourceKey);
  }
  return result;
}

/**
 * Compiles a {@link FilterExpr} into an in-memory row predicate
 * `(row) => boolean`, reusing the shared {@link walkFilter} walker so filter
 * structure matches the SQL/Mongo adapters by construction.
 *
 * An empty/absent filter (for which `walkFilter` returns `undefined`) compiles
 * to a match-everything predicate.
 *
 * A filter holding relational predicates (`ResolvedRelationFilter` operands,
 * since 0.1.147) needs `relationSets` — prepared internally by
 * `MemoryAdapter` from the related tables; a standalone call on such a
 * filter throws `REL_FILTER_NOT_SUPPORTED`.
 */
export function buildMemoryPredicate(filter: FilterExpr, relationSets?: RelationSets): Predicate {
  const visitor: FilterVisitor<Predicate> = relationSets
    ? {
        ...memoryVisitor,
        relation: (field, op, operand) => relationPredicate(relationSets, field, op, operand),
      }
    : memoryVisitor;
  const predicate = walkFilter(filter, visitor);
  return predicate ?? (() => true);
}
