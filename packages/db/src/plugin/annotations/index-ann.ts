import { AnnotationSpec, annotationExample } from "@atscript/core";
import type { TAnnotationsTree, TMessages } from "@atscript/core";

import { integerMemberIndexProblem, searchFieldVerdict } from "../../shared/annotation-utils";
import { refuseCiphertext, sealedSearchProblem } from "../../shared/view-validation";

export const dbIndexAnnotations: TAnnotationsTree = {
  index: {
    plain: new AnnotationSpec({
      description: annotationExample(
        "Standard (non-unique) index for query performance. " +
          "Fields sharing the same index name form a composite index.",
        '@db.index.plain "idx_timeline", "desc"',
        "createdAt: number.timestamp",
      ),
      nodeType: ["prop"],
      passedWhenReferred: false,
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
      description: annotationExample(
        "Unique index — ensures no two rows/documents have the same value(s). " +
          "Fields sharing the same index name form a composite unique constraint.",
        '@db.index.unique "tenant_email"',
        "email: string.email",
      ),
      nodeType: ["prop"],
      passedWhenReferred: false,
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
      description: annotationExample(
        "Full-text search index. " +
          "Fields sharing the same index name form a composite full-text index. " +
          "A string member is part of the engine's text index. An integer member " +
          "(`number.int` and its sizes, `@expect.int`, `@db.default.increment`) is never part of " +
          "the physical text index: when the whole search term is a whole number (`2946`, `-12`; " +
          "no leading zeros), rows whose member equals it exactly also match (OR'd with the text " +
          "match). An integer member must be index-backed — the primary key (first `@meta.id`) or " +
          "the first field of a `@db.index.plain` / `@db.index.unique`. " +
          "Floats, decimals and timestamps are refused.",
        '@db.index.fulltext "ft_content"',
        "title: string",
        "",
        '@db.index.fulltext "ft_content", 5',
        "bio: string",
        "",
        '@db.index.fulltext "ft_content"',
        "@db.index.unique",
        "refNo: number.int",
      ),
      validate(token, args, doc): TMessages {
        const field = token.parentNode!;
        const sealed = sealedSearchProblem(token, doc, "@db.index.fulltext");
        if (sealed) return [sealed];
        const verdict = searchFieldVerdict(field, doc);
        if ("problem" in verdict) {
          return [
            {
              message: `@db.index.fulltext needs a string or an integer field — "${field.id}" ${verdict.problem}`,
              severity: 1,
              range: token.range,
            },
          ];
        }
        if (verdict.kind !== "integer") return [];
        const errors = [] as TMessages;
        const missing = integerMemberIndexProblem(token);
        if (missing) errors.push({ message: missing, severity: 1, range: token.range });
        if (args[1]) {
          errors.push({
            message:
              "the weight is ignored on an integer member (it is matched by exact number, not by text)",
            severity: 2,
            range: args[1].range,
          });
        }
        return errors;
      },
      nodeType: ["prop"],
      passedWhenReferred: false,
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
            "Defaults to `1`. Supported by databases with weighted fulltext (e.g., MongoDB, PostgreSQL). " +
            "Ignored on integer members.",
        },
      ],
    }),

    geo: new AnnotationSpec({
      description: annotationExample(
        "Geospatial index on a `db.geoPoint` field. " +
          "Enables `geoSearch()` (distance-ranked) and accelerates `$geoWithin` filters.",
        "@db.index.geo",
        "geo: db.geoPoint",
      ),
      nodeType: ["prop"],
      passedWhenReferred: false,
      multiple: false,
      argument: {
        optional: true,
        name: "name",
        type: "string",
        description: "Index name. Defaults to the field name.",
      },
      validate: refuseCiphertext("@db.index.geo"),
    }),
  },
};
