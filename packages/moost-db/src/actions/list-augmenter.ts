import type { TDbActionEnvelope } from "./discover";
import { assertVerdictLength } from "./verdict";

type DisabledFn = (rows: unknown[]) => boolean[];

export type AugmentedRow<TRow extends Record<string, unknown>> = TRow & { $actions?: string[] };

export interface AugmentArgs<TRow extends Record<string, unknown> = Record<string, unknown>> {
  envelopes: readonly TDbActionEnvelope[];
  rows: TRow[];
  /** `null` = caller asked for all fields (no field stripping). */
  resolvedProjection: string[] | null;
}

interface Candidate {
  envelope: TDbActionEnvelope;
  disabledFn?: DisabledFn;
  requiredFields: readonly string[];
}

const candidateCache = new WeakMap<TDbActionEnvelope, Candidate | null>();

/** WHY: envelopes are immutable post-discovery, so derived `Candidate` shape is cached for the envelope's lifetime; `null` sentinel pins table-level skip. */
function getCandidate(e: TDbActionEnvelope): Candidate | null {
  const cached = candidateCache.get(e);
  if (cached !== undefined) return cached;
  if (e.info.level !== "row" && e.info.level !== "rows") {
    candidateCache.set(e, null);
    return null;
  }
  const raw = e.raw as { disabled?: unknown; requiredFields?: unknown };
  const disabledFn = typeof raw.disabled === "function" ? (raw.disabled as DisabledFn) : undefined;
  const requiredFields = Array.isArray(raw.requiredFields) ? (raw.requiredFields as string[]) : [];
  const c: Candidate = { envelope: e, disabledFn, requiredFields };
  candidateCache.set(e, c);
  return c;
}

function collectCandidates(envelopes: readonly TDbActionEnvelope[]): Candidate[] {
  const out: Candidate[] = [];
  for (const e of envelopes) {
    const c = getCandidate(e);
    if (c !== null) out.push(c);
  }
  return out;
}

function computeStripFields(
  candidates: readonly Candidate[],
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

export function augmentRowsWithActions<
  TRow extends Record<string, unknown> = Record<string, unknown>,
>(args: AugmentArgs<TRow>): AugmentedRow<TRow>[] {
  const { envelopes, rows, resolvedProjection } = args;

  const candidates = collectCandidates(envelopes);
  if (candidates.length === 0 || rows.length === 0) {
    return rows as AugmentedRow<TRow>[];
  }

  const verdicts: Array<boolean[] | undefined> = candidates.map((c) => {
    if (!c.disabledFn) return undefined;
    const out = c.disabledFn(rows as unknown[]);
    assertVerdictLength(c.envelope.info.name, out, rows.length);
    return out;
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const names: string[] = [];
    for (let j = 0; j < candidates.length; j++) {
      const v = verdicts[j];
      if (v === undefined) {
        names.push(candidates[j].envelope.info.name);
        continue;
      }
      if (!v[i]) names.push(candidates[j].envelope.info.name);
    }
    (row as Record<string, unknown>).$actions = names;
  }

  if (resolvedProjection !== null) {
    const stripFields = computeStripFields(candidates, resolvedProjection);
    if (stripFields !== null) {
      for (const row of rows) {
        for (const f of stripFields) {
          delete (row as Record<string, unknown>)[f];
        }
      }
    }
  }

  return rows as AugmentedRow<TRow>[];
}
