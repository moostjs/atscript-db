const BAREWORD = /^[\p{L}\p{N}_]+$/u;
const KEYWORD = /^(?:AND|OR|NOT|NEAR)$/i;

/**
 * Turns a user's `$search` text into a safe FTS5 MATCH expression (since
 * 0.1.150). FTS5 reads the raw text as a query language — `-2946`, `a AND`,
 * `title:x`, `(`, a stray `"` — and throws a syntax error on most of it.
 * Every term is therefore quoted (plain words are already safe barewords)
 * so no user text can raise one:
 *
 * - a `"quoted phrase"` stays a phrase (words in order);
 * - a bare word stays a word, and a trailing `*` keeps its prefix meaning
 *   (`quok*` finds `quokka`);
 * - words are AND-ed, as before;
 * - everything else — `AND` / `OR` / `NOT`, `-`, `+`, `^`, `NEAR(…)`,
 *   `column:`, parentheses — is plain text (the tokenizer drops punctuation).
 *
 * Quoted strings never contain a `"`: an inner `"` is doubled (FTS5 escape).
 */
export function quoteFtsTerm(text: string): string {
  const parts: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|(\S+)/g)) {
    const phrase = match[1];
    if (phrase !== undefined) {
      if (phrase.trim()) parts.push(`"${phrase.replace(/"/g, '""')}"`);
      continue;
    }
    const word = match[2]!;
    const core = word.replace(/\*+$/, "");
    if (!core) continue;
    // A plain word is already a valid FTS5 bareword (unless it is an operator keyword).
    const quoted =
      BAREWORD.test(core) && !KEYWORD.test(core) ? core : `"${core.replace(/"/g, '""')}"`;
    parts.push(core.length < word.length ? `${quoted}*` : quoted);
  }
  // Nothing searchable (`*`, `""`): an empty phrase matches no row — never a syntax error.
  return parts.length > 0 ? parts.join(" ") : '""';
}
