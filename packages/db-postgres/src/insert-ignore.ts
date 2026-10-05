import { uniqueKeyTuple } from "@atscript/db";

/**
 * Maps the rows a batched `INSERT … ON CONFLICT DO NOTHING RETURNING <keys>`
 * returned back to the batch's input rows.
 *
 * PostgreSQL returns the inserted rows in VALUES order and omits skipped ones,
 * so `returned` is an in-order subsequence of `batch`. A row that can collide
 * (it carries every column of some key set) is inserted exactly when the next
 * returned row carries its key; a row with no complete key set cannot collide
 * and was therefore inserted. Result: per input row, the index of its returned
 * row, or `-1` when it was skipped. `undefined` when the returned rows cannot
 * be accounted for — the caller must redo the chunk row by row instead of
 * mis-reporting a conflict.
 *
 * @param keySets Physical column names of the primary key and every unique index.
 */
export function mapIgnoredBatch(
  batch: ReadonlyArray<Record<string, unknown>>,
  returned: ReadonlyArray<Record<string, unknown>>,
  keySets: readonly (readonly string[])[],
): number[] | undefined {
  if (returned.length === 0) return batch.map(() => -1);
  if (returned.length === batch.length) return batch.map((_, i) => i);

  const out: number[] = [];
  let next = 0;
  for (const row of batch) {
    const candidate = returned[next];
    if (!candidate) {
      out.push(-1);
      continue;
    }
    const tuples = keySets.map((cols) => uniqueKeyTuple(row, cols));
    const inserted =
      tuples.every((t) => t === undefined) ||
      keySets.some(
        (cols, k) => tuples[k] !== undefined && tuples[k] === uniqueKeyTuple(candidate, cols),
      );
    out.push(inserted ? next++ : -1);
  }
  return next === returned.length ? out : undefined;
}
