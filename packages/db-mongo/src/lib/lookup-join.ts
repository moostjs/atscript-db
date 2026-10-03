import type { Document } from "mongodb";

/**
 * The correlation of a pipeline `$lookup`: `let` binds each outer field to a
 * variable (`<prefix>k<i>`), and the first sub-pipeline stages match the
 * inner field against it with SQL `=` semantics — a NULL or missing key on
 * either side never relates (aggregation `$eq(null, null)` is true, and a
 * missing `let` field would equal a missing inner field):
 *
 * 1. `$match: { $expr: { $eq: [inner, $$var] } }` (an `$and` of `$eq`s for a
 *    composite key) — kept bare so the lookup can use an index on the inner
 *    field(s); anything else inside that `$expr` turns every lookup into a
 *    collection scan;
 * 2. `$match: { <inner>: { $ne: null } }` per key part — the NULL guard, as a
 *    query-level stage. A NULL / missing outer key (`$ifNull` folds "missing"
 *    into `null`) only `$eq`s inner NULL / missing values, which this stage
 *    drops.
 */
export function correlate(
  prefix: string,
  pairs: ReadonlyArray<{ outer: string; inner: string }>,
): { let: Document; stages: Document[] } {
  if (pairs.length === 0) {
    // An empty correlation would relate every document — never render one.
    throw new Error("A $lookup correlation needs at least one key pair");
  }
  const vars: Document = {};
  const eqs: Document[] = [];
  const guard: Document = {};
  for (const [i, pair] of pairs.entries()) {
    const name = `${prefix}k${i}`;
    vars[name] = { $ifNull: [`$${pair.outer}`, null] };
    eqs.push({ $eq: [`$${pair.inner}`, `$$${name}`] });
    guard[pair.inner] = { $ne: null };
  }
  return {
    let: vars,
    stages: [{ $match: { $expr: eqs.length === 1 ? eqs[0] : { $and: eqs } } }, { $match: guard }],
  };
}
