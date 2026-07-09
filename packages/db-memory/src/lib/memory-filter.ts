import type { FilterExpr, FilterVisitor } from "@atscript/db";
import { walkFilter, DbError } from "@atscript/db";

/**
 * In-memory row predicate: given a document, decide whether it matches a
 * filter. This is the single unit of currency the whole engine composes —
 * leaves, logical nodes and the top-level filter all reduce to one of these.
 */
type Predicate = (row: Record<string, unknown>) => boolean;

/**
 * Dot-path getter. Splits `path` on `.` and walks plain objects, returning the
 * value at the end of the path or `undefined` if any intermediate segment is
 * missing or is not a plain object.
 *
 * LIMITATION (v1, accepted): this does NOT descend into arrays. If a segment
 * resolves to an array, traversal stops and `undefined` is returned — there is
 * no positional/`$elemMatch`-style indexing. Array-of-object matching is a
 * later concern; the SQL/Mongo adapters flatten differently and we do not want
 * to fake a semantic the store can't back yet.
 */
export function getPath(row: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = row;
  for (const seg of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Like {@link getPath}, but reports whether the FINAL key EXISTS rather than
 * its value. A key holding `null` counts as present. This is what lets
 * `$exists` distinguish a `null`-valued field (present) from an absent one —
 * a distinction {@link getPath} alone cannot make (both would read back as a
 * nullish value). Same array limitation as {@link getPath}.
 */
export function hasPath(row: Record<string, unknown>, path: string): boolean {
  const segments = path.split(".");
  const last = segments.pop()!; // split() always yields at least one segment
  let current: unknown = row;
  for (const seg of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(current, last);
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
  return valuesEqual(fieldValue, value);
}

/** `$in` membership, factored out so `$nin` can be its exact negation. */
function evalIn(row: Record<string, unknown>, field: string, value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const fieldValue = getPath(row, field);
  return value.some((element) => valuesEqual(fieldValue, element));
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

      // Presence test keyed off key existence (present-null counts as present).
      // `$exists: true` → path present; `$exists: false` → path absent.
      case "$exists":
        return (row) => value === hasPath(row, field);

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
};

/**
 * Compiles a {@link FilterExpr} into an in-memory row predicate
 * `(row) => boolean`, reusing the shared {@link walkFilter} walker so filter
 * structure matches the SQL/Mongo adapters by construction.
 *
 * An empty/absent filter (for which `walkFilter` returns `undefined`) compiles
 * to a match-everything predicate.
 */
export function buildMemoryPredicate(filter: FilterExpr): Predicate {
  const predicate = walkFilter(filter, memoryVisitor);
  return predicate ?? (() => true);
}
