import { DB_FULLTEXT_LANGUAGES } from "@atscript/db";

import type { SqliteAdapterOptions } from "./tx-gate";

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
 * - words are AND-ed, as before — OR-ed when `match` is `"any"`
 *   (`@db.index.fulltext.match`, since 0.1.168);
 * - everything else — `AND` / `OR` / `NOT`, `-`, `+`, `^`, `NEAR(…)`,
 *   `column:`, parentheses — is plain text (the tokenizer drops punctuation).
 *
 * Quoted strings never contain a `"`: an inner `"` is doubled (FTS5 escape).
 */
export function quoteFtsTerm(text: string, match?: "all" | "any"): string {
  const parts: string[] = [];
  for (const found of text.matchAll(/"([^"]*)"|(\S+)/g)) {
    const phrase = found[1];
    if (phrase !== undefined) {
      if (phrase.trim()) parts.push(`"${phrase.replace(/"/g, '""')}"`);
      continue;
    }
    const word = found[2]!;
    const core = word.replace(/\*+$/, "");
    if (!core) continue;
    // A plain word is already a valid FTS5 bareword (unless it is an operator keyword).
    const quoted =
      BAREWORD.test(core) && !KEYWORD.test(core) ? core : `"${core.replace(/"/g, '""')}"`;
    parts.push(core.length < word.length ? `${quoted}*` : quoted);
  }
  // Nothing searchable (`*`, `""`): an empty phrase matches no row — never a syntax error.
  return parts.length > 0 ? parts.join(match === "any" ? " OR " : " ") : '""';
}

/** A tokenizer spec — words of letters, digits and `_`, separated by spaces (no quotes: it is inlined into DDL). */
const TOKENIZER_SPEC = /^[A-Za-z0-9_]+(?: +[A-Za-z0-9_]+)*$/;

/**
 * Checks `ftsTokenizers` (since 0.1.175): every key a `@db.index.fulltext.language`
 * value, every tokenizer a plain spec (it is inlined into `CREATE VIRTUAL TABLE`).
 * Throws on the first bad entry.
 */
export function validateFtsTokenizers(tokenizers: SqliteAdapterOptions["ftsTokenizers"]): void {
  for (const [language, tokenizer] of Object.entries(tokenizers ?? {})) {
    if (tokenizer === undefined) continue;
    if (!(DB_FULLTEXT_LANGUAGES as readonly string[]).includes(language)) {
      throw new Error(
        `[sqlite] ftsTokenizers: "${language}" is not a @db.index.fulltext.language value`,
      );
    }
    if (typeof tokenizer !== "string" || !TOKENIZER_SPEC.test(tokenizer)) {
      throw new Error(
        `[sqlite] ftsTokenizers.${language}: ${JSON.stringify(tokenizer)} is not a tokenizer spec — use words of letters, digits and "_" separated by spaces (e.g. "snowball russian unicode61")`,
      );
    }
  }
}

/**
 * The FTS5 `tokenize` option of a fulltext index: `configured` — the
 * `ftsTokenizers` entry of its `@db.index.fulltext.language` (since 0.1.175)
 * — else `english` adds the Porter stemmer (since 0.1.168); every other
 * language — FTS5 ships no other stemmer — and no language keep FTS5's
 * default `unicode61` (`undefined`: no `tokenize` clause).
 */
export function ftsTokenizer(
  index: { language?: string },
  configured?: string,
): string | undefined {
  return configured ?? (index.language === "english" ? "porter unicode61" : undefined);
}

/** Whether an FTS5 table's `CREATE` statement has the tokenizer the index's language asks for. */
export function ftsTokenizerMatch(
  createSql: string,
  index: { language?: string },
  configured?: string,
): boolean {
  return /tokenize\s*=\s*'([^']*)'/i.exec(createSql)?.[1] === ftsTokenizer(index, configured);
}

/**
 * The sync warning for a language FTS5 cannot stem, `undefined` when it can,
 * none is set, or an `ftsTokenizers` entry (`configured`) covers it.
 */
export function ftsLanguageWarning(
  index: { name: string; language?: string },
  configured?: string,
): string | undefined {
  const { language } = index;
  if (language === undefined || language === "english" || language === "none") return undefined;
  if (configured !== undefined) return undefined;
  return `[sqlite] fulltext index "${index.name}": FTS5 has no ${language} stemmer — words are indexed unstemmed (unicode61); set the adapter's ftsTokenizers to use a stemming tokenizer`;
}
