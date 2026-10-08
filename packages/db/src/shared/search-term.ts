import type { TDbIndex, TDbIndexField } from "../types";

/**
 * Internal filter operator (since 0.1.150): a regular expression over the
 * DECIMAL TEXT of an integer column. The core rewrites a caller's `$regex`
 * (or bare `RegExp`) on an integer field into it at translation time;
 * callers can never send it (the filter value guard refuses it).
 */
export const INTEGER_REGEX_OP = "$integerRegex";

const INTEGER_TERM_RE = /^-?(?:0|[1-9][0-9]*)$/;

/**
 * The whole number a `$search` term denotes, or `undefined` (since 0.1.150).
 * The trimmed term must be a plain integer literal — ASCII digits with an
 * optional leading `-`, no `+`, no leading zeros (except `0` itself), no
 * `-0`, no separators / decimals / exponent — within the safe-integer range.
 * Only the whole term counts (`"invoice 2946"` has no number).
 */
export function searchTermInteger(term: string): number | undefined {
  const t = term.trim();
  if (!INTEGER_TERM_RE.test(t) || t === "-0") return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Splits a fulltext index into the members that belong to the physical text
 * index and the integer members matched by exact number (since 0.1.150).
 */
export function splitFulltextFields(index: Pick<TDbIndex, "fields">): {
  text: TDbIndexField[];
  integer: TDbIndexField[];
} {
  const text: TDbIndexField[] = [];
  const integer: TDbIndexField[] = [];
  for (const f of index.fields) (f.integer ? integer : text).push(f);
  return { text, integer };
}

/**
 * `/meta` description of a fulltext index: the adapter's text-index label over
 * the text members, then the exact-number members (since 0.1.150).
 */
export function describeFulltext(
  index: Pick<TDbIndex, "fields">,
  textLabel: (names: string) => string,
): string {
  const { text, integer } = splitFulltextFields(index);
  const base = text.length > 0 ? textLabel(text.map((f) => f.name).join(", ")) : "";
  const exact = integer.map((f) => `exact number on ${f.name}`).join(" + ");
  return [base, exact].filter(Boolean).join(" + ");
}

/**
 * The fulltext index that answers a search naming none (since 0.1.150): the
 * first one with at least one TEXT member, else the first one (an index of
 * integer members only answers exact-number terms).
 */
export function defaultFulltextIndex<T extends Pick<TDbIndex, "fields">>(
  indexes: readonly T[],
): T | undefined {
  return indexes.find((i) => splitFulltextFields(i).text.length > 0) ?? indexes[0];
}
