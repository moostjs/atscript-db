import { AnnotationSpec } from "@atscript/core";
import type {
  AtscriptDoc,
  TAnnotationArgument,
  TAnnotationsTree,
  TMessages,
  Token,
} from "@atscript/core";
import { NULL_WHEN_EMPTY_AGGREGATE_FNS, type TDbAggregateFn } from "../../query/aggregate-fns";
import { validateFieldBaseType } from "../../shared/annotation-utils";
import { validateQueryScope } from "../../shared/validation-utils";
import { aggConditionScope, fieldScopes } from "../lsp-scopes";

/**
 * A conditional aggregate that is NULL when no row matches (so its field
 * must be optional): every NULL-when-empty function but `sum`, whose
 * conditional form is `COALESCE(…, 0)`.
 */
function conditionalIsNullable(name: TDbAggregateFn): boolean {
  return name !== "sum" && NULL_WHEN_EMPTY_AGGREGATE_FNS.has(name);
}

/** The optional 2nd argument every `@db.agg.*` takes. */
const CONDITION_ARG: TAnnotationArgument = {
  name: "condition",
  type: "query",
  optional: true,
  description:
    "Row predicate of a conditional aggregate: only rows where it holds are aggregated " +
    "(SQL `FN(CASE WHEN … THEN field END)`). May reference the entry table and every join; " +
    "unqualified fields resolve to the entry table.",
  fieldScope: fieldScopes.aggCondition,
};

/**
 * The rules every `@db.agg.*` shares: `'*'` is `count`'s only, and a
 * condition (2nd argument) must stay within the view's tables (entry + every
 * join, like `@db.view.filter`) and — for the aggregates that are NULL when
 * no row matches (avg / min / max) — sit on an optional field.
 */
function validateAggArgs(
  name: TDbAggregateFn,
  token: Token,
  args: Token[],
  doc: AtscriptDoc,
): TMessages {
  const errors: TMessages = [];
  const annotation = `@db.agg.${name}`;
  if (args[0]?.text === "*" && name !== "count") {
    errors.push({
      message: `${annotation} needs a field — only @db.agg.count accepts '*'`,
      severity: 1,
      range: args[0].range,
    });
  }

  const condition = args[1];
  if (!condition?.queryNode) return errors;

  // The scope of the view's @db.view.filter — what the editor completes too (lsp-scopes)
  const scope = aggConditionScope(token);
  if (!scope) {
    errors.push({
      message: `A conditional ${annotation} requires @db.view.for on the view`,
      severity: 1,
      range: condition.range,
    });
    return errors;
  }
  errors.push(...validateQueryScope(condition, scope, doc));

  const prop = token.parentNode;
  if (conditionalIsNullable(name) && prop && !prop.has("optional")) {
    const field = prop.id ?? "field";
    errors.push({
      message: `Field "${field}" has a conditional ${annotation} and must be optional (${field}?: …) — it is NULL when no row matches`,
      severity: 1,
      range: token.range,
    });
  }
  return errors;
}

const CONDITIONAL =
  " An optional 2nd argument (a query) makes it conditional: only rows where it holds are aggregated.";

/** What a conditional `name` yields when no row matches (from `NULL_WHEN_EMPTY_AGGREGATE_FNS`). */
function conditionalNote(name: TDbAggregateFn): string {
  if (!NULL_WHEN_EMPTY_AGGREGATE_FNS.has(name)) return "";
  const fn = name.toUpperCase();
  return conditionalIsNullable(name)
    ? ` A conditional ${fn} is NULL when no row matches, so its field must be optional.`
    : ` A conditional ${fn} is 0 (not NULL) when no row matches.`;
}

/**
 * One `@db.agg.<name>` spec: `[field, condition?]` (field optional for count
 * only). The description gets the conditional-form sentences appended.
 */
function aggSpec(
  name: TDbAggregateFn,
  description: string,
  field: { description: string; optional?: boolean },
  types?: string[],
  extra = "",
): AnnotationSpec {
  return new AnnotationSpec({
    description: description + CONDITIONAL + conditionalNote(name) + extra,
    nodeType: ["prop"],
    passedWhenReferred: false,
    argument: [
      {
        name: "field",
        type: "string",
        optional: field.optional,
        description: field.description,
        fieldScope: fieldScopes.aggField,
      },
      CONDITION_ARG,
    ],
    validate(token, args, doc) {
      const errors = validateAggArgs(name, token, args, doc);
      if (types) errors.push(...validateFieldBaseType(token, doc, `@db.agg.${name}`, types));
      return errors;
    },
  });
}

export const dbAggAnnotations: TAnnotationsTree = {
  agg: {
    sum: aggSpec(
      "sum",
      "Declares a view field as SUM of a source column.",
      { description: "Source column name to sum." },
      ["number", "decimal"],
    ),
    avg: aggSpec(
      "avg",
      "Declares a view field as AVG of a source column.",
      { description: "Source column name to average." },
      ["number", "decimal"],
    ),
    count: aggSpec(
      "count",
      "Declares a view field as COUNT. Without argument (or with `'*'`): COUNT(*). " +
        "With field name argument: COUNT(field) (non-null count).",
      {
        optional: true,
        description: "Source column name to count non-null values. Omit (or `'*'`) for COUNT(*).",
      },
      ["number"],
      " A conditional COUNT(*) is spelled `@db.agg.count '*', <query>`.",
    ),
    countDistinct: aggSpec(
      "countDistinct",
      "Declares a view field as COUNT(DISTINCT field): the number of distinct non-null values " +
        "of a source column.",
      { description: "Source column name whose distinct non-null values are counted." },
      ["number"],
    ),
    min: aggSpec("min", "Declares a view field as MIN of a source column.", {
      description: "Source column name.",
    }),
    max: aggSpec("max", "Declares a view field as MAX of a source column.", {
      description: "Source column name.",
    }),
  },
};
