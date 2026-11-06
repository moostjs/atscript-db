import { HttpError } from "@moostjs/event-http";
import { cached, tryGetCurrent } from "@wooksjs/event-core";
import { getTranslator, useTranslation } from "moost";

import type { TDbActionDisabledVerdict } from "./types";

/** A `disabled` predicate: one verdict per row. */
export type TDisabledFn = (rows: unknown[]) => TDbActionDisabledVerdict[];

/** Assert that a `disabled` predicate returned an array of the expected length; throws HTTP 500 otherwise. */
export function assertVerdictLength(
  action: string,
  verdicts: unknown,
  expected: number,
): asserts verdicts is TDbActionDisabledVerdict[] {
  if (!Array.isArray(verdicts) || verdicts.length !== expected) {
    throw new HttpError(
      500,
      `Action "${action}" disabled predicate returned an invalid verdict array`,
    );
  }
}

/** Runs `disabled` over `rows` — one verdict per row (a wrong-length answer → HTTP 500). */
export function judgeRows(
  action: string,
  disabled: TDisabledFn,
  rows: unknown[],
): TDbActionDisabledVerdict[] {
  const verdicts: unknown = disabled(rows);
  assertVerdictLength(action, verdicts, rows.length);
  return verdicts;
}

/**
 * {@link judgeRows} over the rows `keep` admits — an action's in-scope rows
 * (like the gate, it never judges a row outside its action's scope), after
 * `prepare` (e.g. a projection). Verdicts are indexed like `rows`
 * (`undefined` where not judged); `undefined` when no row is kept.
 */
export function judgeRowsWhere<T>(
  action: string,
  disabled: TDisabledFn,
  rows: readonly T[],
  keep: (row: T, index: number) => boolean,
  prepare: (kept: T[]) => unknown[],
): Array<TDbActionDisabledVerdict | undefined> | undefined {
  const at: number[] = [];
  for (let i = 0; i < rows.length; i++) if (keep(rows[i], i)) at.push(i);
  if (at.length === 0) return undefined;
  if (at.length === rows.length) return judgeRows(action, disabled, prepare(rows as T[]));
  const judged = judgeRows(action, disabled, prepare(at.map((i) => rows[i])));
  const byRow = Array.from<TDbActionDisabledVerdict | undefined>({ length: rows.length });
  for (let k = 0; k < at.length; k++) byRow[at[k]] = judged[k];
  return byRow;
}

/** {@link judgeRows} for one row. */
export function judgeRow(
  action: string,
  disabled: TDisabledFn,
  row: unknown,
): TDbActionDisabledVerdict {
  return judgeRows(action, disabled, [row])[0];
}

/** The reason a verdict carries — a non-empty string; `undefined` for `true` / falsy verdicts. */
export function verdictReason(verdict: unknown): string | undefined {
  return typeof verdict === "string" && verdict !== "" ? verdict : undefined;
}

/** The request's {@link verdictReason}, translated — memoized per distinct reason. */
const verdictReasonSlot = cached((ctx): ((verdict: unknown) => string | undefined) => {
  const translation = useTranslation(ctx);
  if (!translation) return verdictReason;
  const done = new Map<string, string>();
  return (verdict) => {
    const reason = verdictReason(verdict);
    if (reason === undefined) return undefined;
    let out = done.get(reason);
    if (out === undefined) done.set(reason, (out = translation.t(reason, undefined, reason)));
    return out;
  };
});

/**
 * {@link verdictReason} in the current request's language (since 0.1.170):
 * a reason is its own message id (moost's `setTranslator`), so the row
 * menu's `$disabledReasons`, `/meta/actions` and the 409 of a refused run
 * read alike. Without a translator, a locale or an event, reasons are kept.
 */
export function useVerdictReason(): (verdict: unknown) => string | undefined {
  if (!getTranslator()) return verdictReason;
  return tryGetCurrent()?.get(verdictReasonSlot) ?? verdictReason;
}
