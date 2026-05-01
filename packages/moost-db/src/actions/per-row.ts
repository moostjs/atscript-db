/**
 * Lift a per-row predicate into the batch shape required by
 * `@DbAction` opts.`disabled` and class-level dict `disabled`. Polarity is
 * preserved — `true` from `fn` means the action is disabled for that row.
 *
 * ```ts
 * @DbAction<Order>('archive', {
 *   requiredFields: ['status'],
 *   disabled: perRow(r => r.status === 'archived'),
 * })
 * ```
 */
export const perRow =
  <TRow>(fn: (row: TRow) => boolean) =>
  (rows: TRow[]): boolean[] =>
    rows.map(fn);
