import type { TAnnotationsTree, Token, TMessages } from "@atscript/core";
import { AnnotationSpec } from "@atscript/core";

import { MYSQL_NAME_RE, MYSQL_ON_UPDATE_RE } from "../annotation-values";

/** Common storage engines, offered by completion; any engine the server has is accepted. */
const ENGINES = [
  "InnoDB",
  "MyISAM",
  "MEMORY",
  "CSV",
  "ARCHIVE",
  "BLACKHOLE",
  "MERGE",
  "FEDERATED",
  "NDB",
  "ROCKSDB",
  "Aria",
];

/** MySQL 8 character sets, offered by completion; any character set the server has is accepted. */
const CHARSETS = [
  "utf8mb4",
  "utf8mb3",
  "utf8",
  "latin1",
  "ascii",
  "binary",
  "utf16",
  "utf16le",
  "utf32",
  "ucs2",
  "latin2",
  "latin5",
  "latin7",
  "cp1250",
  "cp1251",
  "cp1256",
  "cp1257",
  "cp850",
  "cp852",
  "cp866",
  "cp932",
  "koi8r",
  "koi8u",
  "greek",
  "hebrew",
  "armscii8",
  "geostd8",
  "tis620",
  "big5",
  "gbk",
  "gb2312",
  "gb18030",
  "sjis",
  "ujis",
  "eucjpms",
  "euckr",
  "macroman",
  "macce",
  "dec8",
  "hp8",
  "keybcs2",
  "swe7",
];

const ON_UPDATE_CANDIDATES = [
  { value: "CURRENT_TIMESTAMP", documentation: "the column's own precision" },
  {
    value: "CURRENT_TIMESTAMP(3)",
    documentation: "milliseconds — a TIMESTAMP(3) / DATETIME(3) column",
  },
  {
    value: "CURRENT_TIMESTAMP(6)",
    documentation: "microseconds — a TIMESTAMP(6) / DATETIME(6) column",
  },
];

/**
 * An engine / character set name goes into the DDL as written: only a bare
 * name is accepted at compile time; a name the server does not have fails
 * the schema sync with MySQL's own error.
 */
function nameProblem(what: string): (token: Token, args: Token[]) => TMessages {
  return (_token, args) => {
    const arg = args[0];
    if (!arg || MYSQL_NAME_RE.test(arg.text)) return [];
    return [
      {
        message: `@db.mysql.${what} takes a ${what === "engine" ? "storage engine" : "character set"} name (letters, digits, _), got '${arg.text}'`,
        severity: 1,
        range: arg.range,
      },
    ];
  };
}

/**
 * MySQL-specific annotations.
 *
 * Merged into the global config under `{ db: { mysql: ... } }` so they
 * live alongside core's `@db.table`, `@db.index.*`, etc.
 *
 * These annotations opt-in to MySQL-specific behavior. Files using only
 * portable `@db.*` annotations remain adapter-agnostic.
 */
export const annotations: TAnnotationsTree = {
  engine: new AnnotationSpec({
    description:
      "Specifies the MySQL storage engine.\n\n" +
      '**Default:** `"InnoDB"`\n\n' +
      '```atscript\n@db.mysql.engine "MyISAM"\nexport interface Logs { ... }\n```\n\n' +
      "Any engine the server provides is accepted; an unknown one fails the schema sync.",
    nodeType: ["interface"],
    passedWhenReferred: false,
    multiple: false,
    argument: {
      name: "engine",
      type: "string",
      description: "MySQL storage engine name.",
      valueScope: () => ENGINES.map((value) => ({ value })),
    },
    validate: nameProblem("engine"),
  }),

  charset: new AnnotationSpec({
    description:
      "Specifies the character set for the table or column.\n\n" +
      '**Default:** `"utf8mb4"`\n\n' +
      '```atscript\n@db.mysql.charset "latin1"\nexport interface Legacy { ... }\n```\n\n' +
      "Any character set the server provides is accepted; an unknown one fails the schema sync.",
    nodeType: ["interface", "prop"],
    passedWhenReferred: false,
    multiple: false,
    argument: {
      name: "charset",
      type: "string",
      description: "MySQL character set name.",
      valueScope: () => CHARSETS.map((value) => ({ value })),
    },
    validate: nameProblem("charset"),
  }),

  collate: new AnnotationSpec({
    description:
      "Specifies a native MySQL collation (overrides portable `@db.column.collate`).\n\n" +
      '```atscript\n@db.mysql.collate "utf8mb4_turkish_ci"\nname: string\n```',
    nodeType: ["interface", "prop"],
    passedWhenReferred: false,
    multiple: false,
    argument: {
      name: "collation",
      type: "string",
      description: 'Native MySQL collation name (e.g., "utf8mb4_turkish_ci").',
    },
  }),

  unsigned: new AnnotationSpec({
    description:
      "Adds the UNSIGNED modifier to an integer column.\n\n" +
      "```atscript\n@db.mysql.unsigned\nage: number.int\n```",
    nodeType: ["prop"],
    passedWhenReferred: false,
    multiple: false,
  }),

  type: new AnnotationSpec({
    description:
      "Overrides the native MySQL column type.\n\n" +
      '```atscript\n@db.mysql.type "MEDIUMTEXT"\nbio: string\n```',
    nodeType: ["prop"],
    passedWhenReferred: false,
    multiple: false,
    argument: {
      name: "type",
      type: "string",
      description: 'Native MySQL column type (e.g., "MEDIUMTEXT", "TINYTEXT").',
    },
  }),

  onUpdate: new AnnotationSpec({
    description:
      "Sets the MySQL ON UPDATE clause for a column: `CURRENT_TIMESTAMP`, optionally with a " +
      "precision. Without one the column's own precision is used; a precision must match the " +
      'column\'s (`@db.mysql.type "TIMESTAMP(3)"` for `CURRENT_TIMESTAMP(3)`).\n\n' +
      '```atscript\n@db.mysql.type "TIMESTAMP(3)"\n@db.default.now\n@db.mysql.onUpdate "CURRENT_TIMESTAMP(3)"\nupdatedAt: number.timestamp\n```',
    nodeType: ["prop"],
    passedWhenReferred: false,
    multiple: false,
    argument: {
      name: "expression",
      type: "string",
      description:
        "`CURRENT_TIMESTAMP` or `CURRENT_TIMESTAMP(n)` (n = 0–6; `NOW()`, `LOCALTIMESTAMP` and `LOCALTIME` are synonyms).",
      valueScope: () => ON_UPDATE_CANDIDATES,
    },
    validate(_token, args) {
      const arg = args[0];
      if (!arg || MYSQL_ON_UPDATE_RE.test(arg.text.trim())) return [];
      return [
        {
          message: `@db.mysql.onUpdate takes CURRENT_TIMESTAMP, optionally with a precision 0–6 (CURRENT_TIMESTAMP(3)), got '${arg.text}'`,
          severity: 1,
          range: arg.range,
        },
      ];
    },
  }),
};
