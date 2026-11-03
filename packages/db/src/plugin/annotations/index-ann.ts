import { AnnotationSpec, annotationExample, isInterface, isStructure } from "@atscript/core";
import type { SemanticNode, TAnnotationsTree, TMessages, Token } from "@atscript/core";

import { DB_FULLTEXT_LANGUAGES, DB_FULLTEXT_MATCH_MODES } from "../../shared/fulltext-options";

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

    fulltext: {
      $self: new AnnotationSpec({
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
          // `atscript__…` keys alias the declared names (since 0.1.165): a declared
          // name with that prefix could shadow another index's key.
          const indexName = args[0]?.text;
          if (indexName?.startsWith("atscript__")) {
            return [
              {
                message: `@db.index.fulltext name "${indexName}" is reserved — names starting with "atscript__" are internal index keys`,
                severity: 1,
                range: args[0]!.range,
              },
            ];
          }
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

      language: new AnnotationSpec({
        description: annotationExample(
          "Text language of the table's full-text indexes: word stemming and stop words " +
            "follow it. Without an index name it applies to every `@db.index.fulltext` " +
            "index of the interface; with one, to that index (and wins over the table-wide " +
            "one). Changing it rebuilds the index on the next schema sync. Without it each " +
            "database keeps its default (`english` on PostgreSQL and MongoDB).\n\n" +
            "- **PostgreSQL**: the text search configuration (`russian`, …; `none` → `simple`).\n" +
            "- **MongoDB**: the text index `default_language`.\n" +
            "- **SQLite**: `english` tokenizes with the Porter stemmer; FTS5 has no other " +
            "stemmer, so every other language indexes words unstemmed (a warning at sync).\n" +
            "- **MySQL**: ignored, with a warning at sync — `FULLTEXT` has no per-index language.",
          "@db.table 'articles'",
          '@db.index.fulltext.language "russian"',
          "export interface Article {",
          '  @db.index.fulltext "ft_body"',
          "  body: string",
          "}",
        ),
        nodeType: ["interface"],
        passedWhenReferred: false,
        multiple: true,
        mergeStrategy: "append",
        argument: [
          {
            name: "language",
            type: "string",
            values: [...DB_FULLTEXT_LANGUAGES],
            description:
              "The text language. `none` indexes words as they are (no stemming, no stop words).",
          },
          {
            optional: true,
            name: "index",
            type: "string",
            description:
              "The `@db.index.fulltext` index it applies to. Omit to apply to every full-text index of the interface.",
          },
        ],
        validate: (token, args) => validateFulltextOption(token, args, "language"),
      }),

      match: new AnnotationSpec({
        description: annotationExample(
          "Whether a text search needs every term (`all`) or any term (`any`). Without an " +
            "index name it applies to every `@db.index.fulltext` index of the interface; " +
            'with one, to that index. Without it each database keeps its default: `"all"` ' +
            'on PostgreSQL and SQLite, `"any"` on MySQL and MongoDB.\n\n' +
            "- **PostgreSQL**: the search runs through `websearch_to_tsquery` (`all`: the " +
            "terms AND-ed; `any`: OR-ed, without `-` exclusions).\n" +
            "- **SQLite**: the FTS5 terms AND-ed or OR-ed.\n" +
            "- **MySQL**: `all` searches `IN BOOLEAN MODE` with every word required (words " +
            "shorter than 3 characters and InnoDB stop words stay optional); `any` " +
            "is the default natural-language search.\n" +
            "- **MongoDB** (`$text`): `all` requires every word (as written, no stemming); " +
            "`any` is the default.",
          "@db.table 'articles'",
          '@db.index.fulltext.match "any"',
          "export interface Article {",
          '  @db.index.fulltext "ft_body"',
          "  body: string",
          "}",
        ),
        nodeType: ["interface"],
        passedWhenReferred: false,
        multiple: true,
        mergeStrategy: "append",
        argument: [
          {
            name: "mode",
            type: "string",
            values: [...DB_FULLTEXT_MATCH_MODES],
            description: "`all` — every term must match; `any` — at least one term.",
          },
          {
            optional: true,
            name: "index",
            type: "string",
            description:
              "The `@db.index.fulltext` index it applies to. Omit to apply to every full-text index of the interface.",
          },
        ],
        validate: (token, args) => validateFulltextOption(token, args, "match"),
      }),
    },

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

/** Every `@db.index.fulltext` index name declared on the props of `owner` (nested props included). */
function collectFulltextIndexNames(owner: SemanticNode | undefined): Set<string> {
  const names = new Set<string>();
  if (!isInterface(owner)) return names;
  const walk = (node: SemanticNode | undefined, prefix: string, depth: number) => {
    if (!isStructure(node) || depth > 8) return;
    for (const [propName, prop] of node.props) {
      const path = prefix ? `${prefix}.${propName}` : propName;
      for (const ann of prop.annotations ?? []) {
        if (ann.name === "db.index.fulltext") names.add(ann.args[0]?.text ?? path);
      }
      walk(prop.getDefinition(), path, depth + 1);
    }
  };
  walk(owner.getDefinition(), "", 0);
  return names;
}

/**
 * `@db.index.fulltext.language` / `.match`: the interface declares full-text
 * indexes, a named index exists, and no index gets the option twice.
 */
function validateFulltextOption(
  token: Token,
  args: Token[],
  option: "language" | "match",
): TMessages {
  const label = `@db.index.fulltext.${option}`;
  const owner = token.parentNode;
  const names = collectFulltextIndexNames(owner);
  if (names.size === 0) {
    return [
      {
        message: `${label} needs at least one @db.index.fulltext on a prop of this interface`,
        severity: 1,
        range: token.range,
      },
    ];
  }
  const target = args[1]?.text;
  if (target !== undefined && !names.has(target)) {
    return [
      {
        message: `${label}: no @db.index.fulltext "${target}" on this interface; declared: ${JSON.stringify([...names])}`,
        severity: 1,
        range: args[1]!.range,
      },
    ];
  }
  const same = (owner?.annotations ?? []).filter(
    (ann) => ann.name === `db.index.fulltext.${option}` && ann.args[1]?.text === target,
  );
  if (same.length > 1 && same[0]!.token !== token) {
    return [
      {
        message:
          target === undefined
            ? `${label} without an index name is declared twice on this interface`
            : `${label} for index "${target}" is declared twice on this interface`,
        severity: 1,
        range: token.range,
      },
    ];
  }
  return [];
}
