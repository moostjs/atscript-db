import type { TAnnotationsTree } from "@atscript/core";
import { AnnotationSpec } from "@atscript/core";

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
      '```atscript\n@db.mysql.engine "MyISAM"\nexport interface Logs { ... }\n```',
    nodeType: ["interface"],
    multiple: false,
    argument: {
      name: "engine",
      type: "string",
      values: ["InnoDB", "MyISAM", "MEMORY", "CSV", "ARCHIVE"],
      description: "MySQL storage engine name.",
    },
  }),

  charset: new AnnotationSpec({
    description:
      "Specifies the character set for the table or column.\n\n" +
      '**Default:** `"utf8mb4"`\n\n' +
      '```atscript\n@db.mysql.charset "latin1"\nexport interface Legacy { ... }\n```',
    nodeType: ["interface", "prop"],
    multiple: false,
    argument: {
      name: "charset",
      type: "string",
      values: ["utf8mb4", "utf8", "latin1", "ascii", "binary"],
      description: "MySQL character set name.",
    },
  }),

  collate: new AnnotationSpec({
    description:
      "Specifies a native MySQL collation (overrides portable `@db.column.collate`).\n\n" +
      '```atscript\n@db.mysql.collate "utf8mb4_turkish_ci"\nname: string\n```',
    nodeType: ["interface", "prop"],
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
    multiple: false,
  }),

  type: new AnnotationSpec({
    description:
      "Overrides the native MySQL column type.\n\n" +
      '```atscript\n@db.mysql.type "MEDIUMTEXT"\nbio: string\n```',
    nodeType: ["prop"],
    multiple: false,
    argument: {
      name: "type",
      type: "string",
      description: 'Native MySQL column type (e.g., "MEDIUMTEXT", "TINYTEXT").',
    },
  }),

  onUpdate: new AnnotationSpec({
    description:
      "Sets the MySQL ON UPDATE clause for a column.\n\n" +
      '```atscript\n@db.mysql.onUpdate "CURRENT_TIMESTAMP"\nupdatedAt: number.timestamp\n```',
    nodeType: ["prop"],
    multiple: false,
    argument: {
      name: "expression",
      type: "string",
      values: ["CURRENT_TIMESTAMP"],
      description: "Expression to evaluate on row update.",
    },
  }),
};
