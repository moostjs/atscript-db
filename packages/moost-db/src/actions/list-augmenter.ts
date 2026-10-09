import { isPlainObject } from "@atscript/db";
import type { TDbActionEnvelope } from "./discover";
import { exceedsFields, omitKeys, projectRow, requiredFieldsOf, splitPaths } from "./rows-by-id";
import type { TDbActionDisabledVerdict } from "./types";
import { judgeRows, verdictReason, type TDisabledFn } from "./verdict";

export type AugmentedRow<TRow extends Record<string, unknown>> = TRow & {
  $actions?: string[];
  /** Action name → reason, for actions disabled on this row WITH a reason. Absent when none. */
  $disabledReasons?: Record<string, string>;
};

export interface AugmentArgs<TRow extends Record<string, unknown> = Record<string, unknown>> {
  envelopes: readonly TDbActionEnvelope[];
  rows: TRow[];
  /** `null` = caller asked for all fields (no field stripping). */
  resolvedProjection: string[] | null;
  /**
   * Action name → per-row mask (parallel to `rows`), `true` where the row is
   * outside the action's row scope: the action is neither listed nor given
   * a `$disabledReasons` entry there.
   */
  outOfScope?: ReadonlyMap<string, readonly boolean[]>;
  /**
   * The columns an action's gate loads: a `disabled` predicate is judged on
   * rows narrowed to them, exactly as at execution time (rows already within
   * them are passed as-is). Omitted: judged on the rows as read.
   */
  gateFields?: (envelope: TDbActionEnvelope) => ReadonlySet<string>;
}

/** A row-level action envelope with its server-internal `disabled` / `requiredFields`. */
export interface TActionCandidate {
  envelope: TDbActionEnvelope;
  disabledFn?: TDisabledFn;
  requiredFields: readonly string[];
}

const candidateCache = new WeakMap<TDbActionEnvelope, TActionCandidate | null>();

/** WHY: envelopes are immutable post-discovery, so derived `Candidate` shape is cached for the envelope's lifetime; `null` sentinel pins table-level skip. */
export function getCandidate(e: TDbActionEnvelope): TActionCandidate | null {
  const cached = candidateCache.get(e);
  if (cached !== undefined) return cached;
  if (e.info.level !== "row" && e.info.level !== "rows") {
    candidateCache.set(e, null);
    return null;
  }
  const raw = e.raw as { disabled?: unknown };
  const disabledFn = typeof raw.disabled === "function" ? (raw.disabled as TDisabledFn) : undefined;
  const c: TActionCandidate = { envelope: e, disabledFn, requiredFields: requiredFieldsOf(e.raw) };
  candidateCache.set(e, c);
  return c;
}

function collectCandidates(envelopes: readonly TDbActionEnvelope[]): TActionCandidate[] {
  const out: TActionCandidate[] = [];
  for (const e of envelopes) {
    const c = getCandidate(e);
    if (c !== null) out.push(c);
  }
  return out;
}

function computeStripFields(
  candidates: readonly TActionCandidate[],
  resolvedProjection: readonly string[],
): Set<string> | null {
  let userSet: Set<string> | null = null;
  let strip: Set<string> | null = null;
  for (const c of candidates) {
    for (const f of c.requiredFields) {
      if (userSet === null) userSet = new Set(resolvedProjection);
      if (userSet.has(f)) continue;
      if (strip === null) strip = new Set();
      strip.add(f);
    }
  }
  return strip;
}

/**
 * Sets `$actions` on every row (plus `$disabledReasons` on rows where a
 * predicate returned a reason string) and strips the columns fetched only for an
 * action's `requiredFields` — IN PLACE in `rows` (a stripped row is replaced
 * by a rebuilt copy, see `omitKeys`); returns the same array, typed as
 * augmented.
 */
export function augmentRowsWithActions<
  TRow extends Record<string, unknown> = Record<string, unknown>,
>(args: AugmentArgs<TRow>): AugmentedRow<TRow>[] {
  const { envelopes, rows, resolvedProjection, outOfScope, gateFields } = args;

  const candidates = collectCandidates(envelopes);
  if (candidates.length === 0 || rows.length === 0) {
    return rows as AugmentedRow<TRow>[];
  }

  const verdicts: Array<TDbActionDisabledVerdict[] | undefined> = candidates.map((c) => {
    if (!c.disabledFn) return undefined;
    // Judged on the columns its gate loads; rows already within them go as-is.
    const fields = gateFields?.(c.envelope);
    let input: Record<string, unknown>[] = rows;
    if (fields && rows.some((row) => exceedsFields(row, fields))) {
      const paths = splitPaths(fields);
      input = rows.map((row) => projectRow(row, paths));
    }
    return judgeRows(c.envelope.info.name, c.disabledFn, input);
  });

  const masks = outOfScope && candidates.map((c) => outOfScope.get(c.envelope.info.name));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const names: string[] = [];
    let reasons: Record<string, string> | undefined;
    for (let j = 0; j < candidates.length; j++) {
      if (masks?.[j]?.[i]) continue;
      const name = candidates[j].envelope.info.name;
      const verdict = verdicts[j]?.[i];
      if (!verdict) {
        names.push(name);
        continue;
      }
      const reason = verdictReason(verdict);
      if (reason !== undefined) (reasons ??= {})[name] = reason;
    }
    (row as Record<string, unknown>).$actions = names;
    if (reasons) (row as Record<string, unknown>).$disabledReasons = reasons;
  }

  if (resolvedProjection !== null) {
    const stripFields = computeStripFields(candidates, resolvedProjection);
    if (stripFields !== null) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as Record<string, unknown>;
        // A plain row is copied without the keys (keeps it in fast mode); any
        // other object keeps its prototype and loses the keys in place.
        if (isPlainObject(row)) rows[i] = omitKeys(row, stripFields) as TRow;
        else for (const key of stripFields) delete row[key];
      }
    }
  }

  return rows as AugmentedRow<TRow>[];
}
