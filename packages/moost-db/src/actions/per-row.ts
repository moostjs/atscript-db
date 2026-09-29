import type { TDbActionDisabledVerdict } from "./types";

/**
 * Lift a per-row predicate into the batch shape required by
 * `@DbAction` opts.`disabled` and class-level dict `disabled`. Polarity is
 * preserved — `true` from `fn` means the action is disabled for that row; a
 * non-empty string disables it with that reason.
 *
 * ```ts
 * @DbAction<Order>('archive', {
 *   requiredFields: ['status'],
 *   disabled: perRow(r => r.status === 'archived'),
 * })
 * ```
 */
export const perRow =
  <TRow>(fn: (row: TRow) => TDbActionDisabledVerdict) =>
  (rows: TRow[]): TDbActionDisabledVerdict[] =>
    rows.map(fn);
