import { HttpError } from "@moostjs/event-http";

import type { TDbActionDisabledVerdict } from "./types";

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

/** The reason a verdict carries — a non-empty string; `undefined` for `true` / falsy verdicts. */
export function verdictReason(verdict: unknown): string | undefined {
  return typeof verdict === "string" && verdict !== "" ? verdict : undefined;
}
