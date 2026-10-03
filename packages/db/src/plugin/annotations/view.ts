import { AnnotationSpec } from "@atscript/core";
import type { AtscriptDoc, TAnnotationsTree, Token, TQueryScope } from "@atscript/core";
import type { TMessages } from "@atscript/core";
import { getFieldsForType, isArray, isPrimitive, isProp } from "@atscript/core";
import { getAnnotationAlias } from "../../shared/annotation-utils";
import {
  earlierJoinTargets,
  findViewCycle,
  hasAnyViewAnnotation,
  isAliasDecl,
  isDbSourceDecl,
  validateQueryScope,
  validateRefArgument,
  viewJoins,
} from "../../shared/validation-utils";
import {
  fieldScopes,
  isJoinTarget,
  joinOrderScope,
  viewFilterScope,
  viewHavingScope,
  viewJoinScope,
} from "../lsp-scopes";
import { validateViewInterface } from "../../shared/view-validation";
import { VIEW_SOURCE_ARGUMENT } from "./alias";

/**
 * VJ6–VJ8 — the ordering of a first-row join: every key is a scalar field of
 * the join target (no object, array, `@db.json`, `@db.encrypted` or
 * navigation field), no key repeats, and the target (through `@db.alias`)
 * declares exactly one `@meta.id` field — the anchor of the join's
 * correlated subquery.
 */
function validateJoinOrder(orderToken: Token, scope: TQueryScope, doc: AtscriptDoc): TMessages {
  const target = scope.unqualifiedTarget!;
  const errors = validateQueryScope(
    orderToken,
    scope,
    doc,
    `a first-row join orders by fields of its target '${target}'`,
  );
  const seen = new Set<string>();
  for (const item of orderToken.orderNode!.items) {
    const { ref } = item;
    if (ref.typeRef && ref.typeRef.text !== target) continue; // reported above
    const path = ref.fieldRef.text;
    if (seen.has(path)) {
      errors.push({
        message: `Order key '${path}' appears more than once`,
        severity: 1,
        range: ref.fieldRef.range,
      });
      continue;
    }
    seen.add(path);
    const why = orderKeyProblem(doc, target, path.split("."));
    if (why) {
      errors.push({
        message: `Order key '${path}' ${why} — order by a scalar field of '${target}'`,
        severity: 1,
        range: ref.fieldRef.range,
      });
    }
  }
  const ids = getFieldsForType(doc, target).filter((p) => p.countAnnotations("meta.id") > 0);
  if (ids.length !== 1) {
    errors.push({
      message: `A first-row join needs a target with exactly one @meta.id field — '${target}' has ${ids.length === 0 ? "none" : `${ids.length} (a composite key)`}`,
      severity: 1,
      range: orderToken.range,
    });
  }
  return errors;
}

/** Why `path` of `target` cannot order a first-row join, or `undefined` when it can. */
function orderKeyProblem(doc: AtscriptDoc, target: string, path: string[]): string | undefined {
  for (let i = 1; i <= path.length; i++) {
    const step = doc.unwindType(target, path.slice(0, i));
    if (!step) return undefined; // unknown field — reported by the scope check
    const node = step.node;
    if (node && isProp(node)) {
      if (node.countAnnotations("db.json") > 0) return "reads a @db.json field";
      if (node.countAnnotations("db.encrypted") > 0) return "is @db.encrypted";
      if (node.countAnnotations("db.ignore") > 0) return "is @db.ignore'd";
    }
    if (isArray(step.def)) return "is an array";
    if (i === path.length && !isPrimitive(step.def)) return "is not a scalar";
  }
  return undefined;
}

export const dbViewAnnotations: TAnnotationsTree = {
  view: {
    $self: new AnnotationSpec({
      description:
        "Marks an interface as a **database view**. Optionally takes a view name argument.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        '@db.view "active_premium_users"\n' +
        "@db.view.for User\n" +
        "export interface ActivePremiumUser { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      passedWhenReferred: false,
      argument: {
        optional: true,
        name: "name",
        type: "string",
        description: "The view name in the database. If omitted, derived from the interface name.",
      },
      validate(token, _args, _doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;
        // VW6: Cannot be both @db.table and @db.view
        if (owner.countAnnotations("db.table") > 0) {
          errors.push({
            message: "An interface cannot be both a @db.table and a @db.view",
            severity: 1,
            range: token.range,
          });
        }
        return errors;
      },
    }),

    for: new AnnotationSpec({
      description:
        "Specifies the entry/primary source for a computed view — a `@db.table`, or another " +
        "`@db.view` (views over views, since 0.1.141). Required for views that map fields via chain refs. " +
        "A `@db.alias` type cannot be the entry.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.view.for Order\n" +
        "@db.view.filter `Order.status = 'active'`\n" +
        "export interface ActiveOrderDetails { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      passedWhenReferred: false,
      argument: {
        name: "entry",
        type: "ref",
        description: "The primary/entry table or view type (must have @db.table or @db.view).",
        refFilter: isDbSourceDecl,
      },
      validate(token, args, doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;
        // VW6: Cannot be both @db.table and @db.view
        if (owner.countAnnotations("db.table") > 0) {
          errors.push({
            message: "An interface cannot be both a @db.table and a @db.view",
            severity: 1,
            range: token.range,
          });
        }
        // The entry is a table or a view (never a @db.alias)
        if (args[0]) {
          errors.push(...validateRefArgument(args[0], doc, VIEW_SOURCE_ARGUMENT));
        }
        // VW9: a view cannot read itself through its sources
        const cycle = findViewCycle(owner, doc);
        if (cycle) {
          errors.push({
            message: `View '${cycle[0]}' depends on itself: ${cycle.join(" → ")}`,
            severity: 1,
            range: args[0]?.range ?? token.range,
          });
        }
        // VW7 (left-joined fields optional) / VW8 (JSON chains end at a primitive)
        errors.push(...validateViewInterface(owner, doc));
        return errors;
      },
    }),

    joins: new AnnotationSpec({
      description:
        "Declares an explicit join for a view. Joins are INNER by default — pass `'left'` as the " +
        "third argument to keep entry rows without a match (fields read from a left-joined table " +
        "must be optional). A join condition may reference the entry table and joins declared " +
        "before it (chained joins). The target is a `@db.table`, a `@db.view` (since 0.1.141), or a " +
        "`@db.alias` type — the way to join one table twice or to self-join the entry table: " +
        "every scope name (entry + joins) must be unique.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.view.for Order\n" +
        "@db.view.joins Customer, `Customer.id = Order.customerId`\n" +
        "@db.view.joins Region, `Region.id = Customer.regionId`, 'left'\n" +
        "export interface OrderRegion { ... }\n" +
        "```\n\n" +
        "**First-row join** (since 0.1.147): a 4th argument — an ordering of the target's fields " +
        "(`` `raisedAt, id` ``, `` `severity desc` ``) — joins only the FIRST matching target row " +
        "by that ordering (the target's primary key is appended as the final tie-break), so every " +
        "field read through the join comes from that one row. NULL sorts first in `asc`.\n" +
        "```atscript\n" +
        "@db.view.joins OldestOpenIssue, `OldestOpenIssue.ticketId = Ticket.id and OldestOpenIssue.status = 'open'`, 'left', `raisedAt`\n" +
        "```\n",
      nodeType: ["interface"],
      passedWhenReferred: false,
      multiple: true,
      mergeStrategy: "append",
      argument: [
        {
          name: "target",
          type: "ref",
          description:
            "The type to join: a @db.table, a @db.view, or a @db.alias of one (for a second join of the same table / a self-join).",
          refFilter: isJoinTarget,
        },
        {
          name: "condition",
          type: "query",
          description:
            "Join condition expression — may reference the join target, the entry table and the joins declared before this one.",
          fieldScope: fieldScopes.viewJoin,
        },
        {
          name: "kind",
          type: "string",
          optional: true,
          description:
            '`"inner"` (default) drops entry rows without a match; `"left"` keeps them with NULLs.',
          values: ["inner", "left"],
        },
        {
          name: "order",
          type: "order",
          optional: true,
          description:
            "Makes this a first-row join: of the target rows matching the condition only the first " +
            "by this ordering joins (`` `raisedAt, id` ``, `` `severity desc` ``). Keys are scalar " +
            "fields of the join target; its primary key is appended as the final tie-break. " +
            "NULL is the smallest value (first in `asc`, last in `desc`).",
          fieldScope: fieldScopes.joinOrder,
        },
      ],
      validate(token, args, doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;

        // VW1: Must be on a @db.view interface
        if (!hasAnyViewAnnotation(owner) && !args[0]) {
          errors.push({
            message: "@db.view.joins is only valid on @db.view interfaces",
            severity: 1,
            range: token.range,
          });
          return errors;
        }

        // The join target is a table, a view, or a @db.alias of one
        if (args[0]) {
          errors.push(
            ...validateRefArgument(args[0], doc, {
              accept: isJoinTarget,
              expected: "must be a @db.table or a @db.view.",
            }),
          );
        }

        // VJ3: Must have @db.view.for
        const entryTypeName = getAnnotationAlias(owner, "db.view.for");
        if (!entryTypeName) {
          errors.push({
            message: "@db.view.joins requires @db.view.for to identify the entry table",
            severity: 1,
            range: token.range,
          });
          return errors;
        }

        // This join (token identity locates it) and the joins declared before it
        const joins = viewJoins(owner);
        const join = joins.find((a) => a.token === token);
        const earlier = join ? earlierJoinTargets(joins, join) : [];

        // VJ5: every scope name (the entry + each join) is unique — a second
        // join of one table, or a self-join, goes through a @db.alias type
        if (args[0]) {
          const target = args[0].text;
          const aliasHint = (name: string): string => {
            const decl = doc.getDeclarationOwnerNode(target)?.node;
            return decl && isAliasDecl(decl)
              ? ""
              : ` — declare a @db.alias type (\`@db.alias ${name}\` + \`export type Other = ${name}\`) to join it under another name`;
          };
          if (target === entryTypeName) {
            errors.push({
              message: `@db.view.joins cannot join the entry table '${target}' directly${aliasHint(target)}`,
              severity: 1,
              range: args[0].range,
            });
          } else if (earlier.includes(target)) {
            errors.push({
              message: `'${target}' is joined more than once${aliasHint(target)}`,
              severity: 1,
              range: args[0].range,
            });
          }
        }

        // VJ1/VJ2: the condition may reference the join target, the entry
        // table and joins declared before this one (chained joins) — the
        // scope the editor completes (lsp-scopes)
        const scope = join && viewJoinScope(owner, join, earlier);
        if (args[1]?.queryNode && scope) {
          errors.push(
            ...validateQueryScope(
              args[1],
              scope,
              doc,
              "a join may reference the entry table and joins declared before it",
            ),
          );
        }

        // VJ6–VJ8: the ordering of a first-row join
        const order = join && args[3]?.orderNode ? joinOrderScope(join) : undefined;
        if (order) {
          errors.push(...validateJoinOrder(args[3], order, doc));
        }

        return errors;
      },
    }),

    filter: new AnnotationSpec({
      description:
        "WHERE clause for a view, filtering which rows are included.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.view.for User\n" +
        "@db.view.filter `User.status = 'active' and User.age >= 18`\n" +
        "export interface ActiveUser { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      passedWhenReferred: false,
      argument: {
        name: "condition",
        type: "query",
        description:
          "Filter expression for the view WHERE clause — may reference the entry table and every join; unqualified fields belong to the entry.",
        fieldScope: fieldScopes.viewFilter,
      },
      validate(token, args, doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;

        // VW2: Must be on a @db.view interface
        if (!hasAnyViewAnnotation(owner) && !args[0]) {
          errors.push({
            message: "@db.view.filter is only valid on @db.view interfaces",
            severity: 1,
            range: token.range,
          });
          return errors;
        }

        if (!args[0]?.queryNode) {
          return errors;
        }

        // VF3: Must have @db.view.for
        const scope = viewFilterScope(owner);
        if (!scope) {
          errors.push({
            message: "@db.view.filter requires @db.view.for to identify the entry table",
            severity: 1,
            range: token.range,
          });
          return errors;
        }

        // VF1/VF2: the entry table and every joined table are in scope — the
        // scope the editor completes (lsp-scopes)
        errors.push(...validateQueryScope(args[0], scope, doc));

        return errors;
      },
    }),

    materialized: new AnnotationSpec({
      description:
        "Marks a view as materialized (precomputed, stored on disk). " +
        "Supported by PostgreSQL, CockroachDB, Oracle, SQL Server (indexed views), Snowflake. " +
        "MongoDB supports on-demand materialized views via $merge/$out. " +
        "Not applicable to MySQL or SQLite.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.view.materialized\n" +
        "@db.view.for User\n" +
        "@db.view.filter `User.status = 'active'`\n" +
        "export interface ActiveUsers { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      passedWhenReferred: false,
      validate(token, _args, _doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;

        // VW3: Must be on a @db.view interface
        if (!hasAnyViewAnnotation(owner)) {
          errors.push({
            message: "@db.view.materialized is only valid on @db.view interfaces",
            severity: 1,
            range: token.range,
          });
        }

        return errors;
      },
    }),

    renamed: new AnnotationSpec({
      description:
        "Specifies the previous view name for view rename migration. " +
        "The sync engine drops the old view and creates the new one." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.view "active_premium_users"\n' +
        '@db.view.renamed "active_users"\n' +
        "@db.view.for User\n" +
        "export interface ActivePremiumUser { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      passedWhenReferred: false,
      argument: {
        name: "oldName",
        type: "string",
        description: "The previous view name.",
      },
      validate(token, _args, _doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;
        if (!hasAnyViewAnnotation(owner)) {
          errors.push({
            message: "@db.view.renamed requires @db.view on the same interface",
            severity: 1,
            range: token.range,
          });
        }
        return errors;
      },
    }),

    having: new AnnotationSpec({
      description:
        "Post-aggregation filter (HAVING clause) for analytical views. " +
        "References the view's own fields, unqualified (`totalRevenue > 100`) — aggregate " +
        "fields by their alias, plain fields as GROUP BY dimensions; source-table refs are not in scope.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.view\n" +
        "@db.view.for Order\n" +
        "@db.view.having `totalRevenue > 100`\n" +
        "export interface TopCategories { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      passedWhenReferred: false,
      argument: {
        name: "condition",
        type: "query",
        description: "HAVING condition — the view's own fields, unqualified.",
        fieldScope: fieldScopes.viewHaving,
      },
      validate(token, args, doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;
        if (!hasAnyViewAnnotation(owner)) {
          errors.push({
            message: "@db.view.having is only valid on @db.view interfaces",
            severity: 1,
            range: token.range,
          });
          return errors;
        }
        // VH1: refs name the view's own fields, unqualified — the scope the
        // editor completes (lsp-scopes)
        const scope = viewHavingScope(owner);
        if (args[0]?.queryNode && scope) {
          errors.push(
            ...validateQueryScope(
              args[0],
              scope,
              doc,
              "@db.view.having references the view's own fields unqualified",
            ),
          );
        }
        return errors;
      },
    }),
  },
};
