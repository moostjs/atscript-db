/**
 * The languages `@db.index.fulltext.language` accepts (since 0.1.168): the
 * ones PostgreSQL ships a text search configuration for and MongoDB a text
 * index language for. `"none"` — no stemming and no stop words.
 */
export const DB_FULLTEXT_LANGUAGES = [
  "none",
  "danish",
  "dutch",
  "english",
  "finnish",
  "french",
  "german",
  "hungarian",
  "italian",
  "norwegian",
  "portuguese",
  "romanian",
  "russian",
  "spanish",
  "swedish",
  "turkish",
] as const;

/** The values `@db.index.fulltext.match` accepts (since 0.1.168). */
export const DB_FULLTEXT_MATCH_MODES = ["all", "any"] as const;
