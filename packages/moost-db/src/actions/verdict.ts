import { HttpError } from "@moostjs/event-http";

/** Assert that a `disabled` predicate returned a `boolean[]` of the expected length; throws HTTP 500 otherwise. */
export function assertVerdictLength(
  action: string,
  verdicts: unknown,
  expected: number,
): asserts verdicts is boolean[] {
  if (!Array.isArray(verdicts) || verdicts.length !== expected) {
    throw new HttpError(
      500,
      `Action "${action}" disabled predicate returned an invalid verdict array`,
    );
  }
}
