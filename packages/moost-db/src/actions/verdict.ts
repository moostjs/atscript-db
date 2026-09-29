import { HttpError } from "@moostjs/event-http";

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
