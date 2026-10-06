import { uniqueKeyTuple } from "@atscript/db";

/**
 * Whether two key values are the same value written differently: a number
 * and its decimal text (`5` / `"5.00"` of a NUMERIC column), a string and its
 * blank-padded form (`"ab"` / `"ab   "` of a CHAR(n) column), or in another
 * letter case (`uuid`, `citext`).
 */
function looselySame(a: unknown, b: unknown): boolean {
  const textA = typeof a === "number" || typeof a === "string" ? `${a}` : undefined;
  const textB = typeof b === "number" || typeof b === "string" ? `${b}` : undefined;
  if (textA === undefined || textB === undefined) return false;
  const na = Number(textA);
  const nb = Number(textB);
  if (textA.trim() !== "" && textB.trim() !== "" && Number.isFinite(na) && na === nb) return true;
  // also the same value in another letter case: PostgreSQL lower-cases a `uuid` it returns, and
  // a `citext` key is case-insensitive — neither proves "skipped" nor "inserted" by comparison
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.trimEnd().toLowerCase() === b.trimEnd().toLowerCase()
  );
}

/** A key value the server may store in another form than it was sent (NUMERIC / decimal rounding). */
function mayNormalize(value: unknown): boolean {
  return (
    (typeof value === "number" && !Number.isInteger(value)) ||
    (typeof value === "string" && /^-?\d+\.\d+$/.test(value))
  );
}

/**
 * Maps the rows a batched `INSERT … ON CONFLICT DO NOTHING RETURNING <keys>`
 * returned back to the batch's input rows.
 *
 * PostgreSQL returns the inserted rows in VALUES order and omits skipped ones,
 * so `returned` is an in-order subsequence of `batch`. A row is inserted
 * exactly when the next returned row carries EVERY key set the row fully
 * defines (key sets with an absent / null input component are never compared:
 * a generated key's value is unknown to the input). Result: per input row, the
 * index of its returned row, or `-1` when it was skipped.
 *
 * `undefined` when the mapping is not provably exact — a row that defines no
 * complete key set (it may match a returned row only by a generated value), a
 * skipped-looking row whose key a server could have normalized (non-integer
 * numbers / decimals), a key equal to the returned one only when written
 * differently (`5` / `"5.00"`, blank-padded CHAR, a `uuid` / `citext` in another
 * letter case — the server lower-cases a returned uuid, so `"AAA"` / `"aaa"` could
 * swap the mapping), or returned rows left
 * unaccounted for. The batched mapping also relies on `RETURNING` coming back in
 * `VALUES` order and in-order-subsequence of the input; when the counts or keys do
 * not line up it yields `undefined` instead of guessing. The caller must
 * then redo the chunk row by row. An empty `returned` (everything skipped) and
 * a fully-returned batch (everything inserted) are exact without any matching.
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
    const tuples = keySets.map((cols) => uniqueKeyTuple(row, cols));
    if (tuples.every((t) => t === undefined)) return undefined;
    const candidate = returned[next];
    if (candidate !== undefined) {
      const strict = keySets.map(
        (cols, k) => tuples[k] === undefined || tuples[k] === uniqueKeyTuple(candidate, cols),
      );
      if (strict.every(Boolean)) {
        out.push(next++);
        continue;
      }
      // The same key written differently (NUMERIC `5` / `"5.00"`, CHAR padding) is neither a
      // proven match nor a proven skip: redo the chunk row by row.
      const looseOnly = keySets.every(
        (cols, k) =>
          tuples[k] === undefined ||
          strict[k] ||
          cols.every((c) => looselySame(row[c], candidate[c])),
      );
      if (looseOnly) return undefined;
    }
    // Skipped — only provable when no key value could have been normalized.
    if (
      keySets.some((cols, k) => tuples[k] !== undefined && cols.some((c) => mayNormalize(row[c])))
    ) {
      return undefined;
    }
    out.push(-1);
  }
  return next === returned.length ? out : undefined;
}
