import type { TAnnotationsTree } from "@atscript/core";
import { AnnotationSpec } from "@atscript/core";

/**
 * PostgreSQL-specific annotations.
 *
 * Merged into the global config under `{ db: { pg: ... } }` so they
 * live alongside core's `@db.table`, `@db.index.*`, etc.
 *
 * These annotations opt-in to PostgreSQL-specific behavior. Files using only
 * portable `@db.*` annotations remain adapter-agnostic.
 */
export const annotations: TAnnotationsTree = {
  type: new AnnotationSpec({
    description:
      "Overrides the native PostgreSQL column type.\n\n" +
      '```atscript\n@db.pg.type "CITEXT"\nname: string\n```',
    nodeType: ["prop"],
    multiple: false,
    argument: {
      name: "type",
      type: "string",
      description: 'Native PostgreSQL column type (e.g., "CITEXT", "INET", "MACADDR").',
    },
  }),

  schema: new AnnotationSpec({
    description:
      "Specifies the PostgreSQL schema for the table.\n\n" +
      '**Default:** `"public"`\n\n' +
      '```atscript\n@db.pg.schema "analytics"\nexport interface Events { ... }\n```',
    nodeType: ["interface"],
    multiple: false,
    argument: {
      name: "schema",
      type: "string",
      description: 'PostgreSQL schema name (e.g., "public", "analytics").',
    },
  }),

  collate: new AnnotationSpec({
    description:
      "Specifies a native PostgreSQL collation (overrides portable `@db.column.collate`).\n\n" +
      '```atscript\n@db.pg.collate "tr-x-icu"\nname: string\n```',
    nodeType: ["interface", "prop"],
    multiple: false,
    argument: {
      name: "collation",
      type: "string",
      description: 'Native PostgreSQL collation name (e.g., "tr-x-icu", "C", "und-x-icu").',
    },
  }),
};
