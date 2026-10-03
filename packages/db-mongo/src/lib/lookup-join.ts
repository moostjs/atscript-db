import type { Document } from "mongodb";

/**
 * The correlation of a pipeline `$lookup`: `let` binds each outer field to a
 * variable (`<prefix>k<i>`), and the first sub-pipeline stage matches the
 * inner field against it — per key part, guarded so that a NULL or missing
 * outer key never relates (SQL `=` semantics; aggregation `$eq(null, null)`
 * is true, and a missing `let` field would equal a missing inner field). The
 * `$ifNull` folds "missing" into `null` for that guard.
 */
export function correlate(
  prefix: string,
  pairs: ReadonlyArray<{ outer: string; inner: string }>,
): { let: Document; match: Document } {
  const vars: Document = {};
  const and: Document[] = [];
  for (const [i, pair] of pairs.entries()) {
    const name = `${prefix}k${i}`;
    vars[name] = { $ifNull: [`$${pair.outer}`, null] };
    and.push({ $ne: [`$$${name}`, null] }, { $eq: [`$${pair.inner}`, `$$${name}`] });
  }
  return { let: vars, match: { $match: { $expr: and.length === 1 ? and[0] : { $and: and } } } };
}
