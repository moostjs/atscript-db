import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";

export const dbIndexAnnotations: TAnnotationsTree = {
  index: {
    plain: new AnnotationSpec({
      description:
        "Standard (non-unique) index for query performance. " +
        "Fields sharing the same index name form a composite index." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.index.plain "idx_timeline", "desc"\n' +
        "createdAt: number.timestamp\n" +
        "```\n",
      nodeType: ["prop"],
      multiple: true,
      mergeStrategy: "append",
      argument: [
        {
          optional: true,
          name: "name",
          type: "string",
          description: "Index name / composite group name.",
        },
        {
          optional: true,
          name: "sort",
          type: "string",
          values: ["asc", "desc"],
          description: 'Sort direction. Defaults to "asc".',
        },
      ],
    }),

    unique: new AnnotationSpec({
      description:
        "Unique index — ensures no two rows/documents have the same value(s). " +
        "Fields sharing the same index name form a composite unique constraint." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.index.unique "tenant_email"\n' +
        "email: string.email\n" +
        "```\n",
      nodeType: ["prop"],
      multiple: true,
      mergeStrategy: "append",
      argument: {
        optional: true,
        name: "name",
        type: "string",
        description: "Index name / composite group name.",
      },
    }),

    fulltext: new AnnotationSpec({
      description:
        "Full-text search index. " +
        "Fields sharing the same index name form a composite full-text index." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.index.fulltext "ft_content"\n' +
        "title: string\n" +
        "\n" +
        '@db.index.fulltext "ft_content", 5\n' +
        "bio: string\n" +
        "```\n",
      nodeType: ["prop"],
      multiple: true,
      mergeStrategy: "append",
      argument: [
        {
          optional: true,
          name: "name",
          type: "string",
          description: "Index name / composite group name.",
        },
        {
          optional: true,
          name: "weight",
          type: "number",
          description:
            "Field importance in search results (higher = more relevant). " +
            "Defaults to `1`. Supported by databases with weighted fulltext (e.g., MongoDB, PostgreSQL).",
        },
      ],
    }),
  },
};
