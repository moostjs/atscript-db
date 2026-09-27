import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";
import type { TMessages } from "@atscript/core";
import { getAnnotationAlias } from "../../shared/annotation-utils";
import {
  hasAnyViewAnnotation,
  joinTargets,
  validateQueryScope,
  validateRefArgument,
  viewJoins,
  viewScopeTypes,
} from "../../shared/validation-utils";
import { validateViewInterface } from "../../shared/view-validation";

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
        "Specifies the entry/primary table for a computed view. Required for views that map fields via chain refs.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.view.for Order\n" +
        "@db.view.filter `Order.status = 'active'`\n" +
        "export interface ActiveOrderDetails { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      argument: {
        name: "entry",
        type: "ref",
        description: "The primary/entry table type (must have @db.table).",
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
        // Entry type must be @db.table
        if (args[0]) {
          errors.push(...validateRefArgument(args[0], doc, { requireDbTable: true }));
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
        "before it (chained joins); a table can be joined once (no aliases / self-joins).\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.view.for Order\n" +
        "@db.view.joins Customer, `Customer.id = Order.customerId`\n" +
        "@db.view.joins Region, `Region.id = Customer.regionId`, 'left'\n" +
        "export interface OrderRegion { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      multiple: true,
      mergeStrategy: "append",
      argument: [
        {
          name: "target",
          type: "ref",
          description: "The table type to join (must have @db.table).",
        },
        {
          name: "condition",
          type: "query",
          description: "Join condition expression.",
        },
        {
          name: "kind",
          type: "string",
          optional: true,
          description:
            '`"inner"` (default) drops entry rows without a match; `"left"` keeps them with NULLs.',
          values: ["inner", "left"],
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

        // Validate join target is @db.table
        if (args[0]) {
          errors.push(...validateRefArgument(args[0], doc, { requireDbTable: true }));
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

        // Joins declared before this one (token identity locates it)
        const allJoins = viewJoins(owner);
        const position = allJoins.findIndex((a) => a.token === token);
        const earlier = joinTargets(position === -1 ? [] : allJoins.slice(0, position));

        // VJ5: one join per table, never the entry table (no aliases / self-joins yet)
        if (args[0]) {
          const target = args[0].text;
          if (target === entryTypeName) {
            errors.push({
              message: `@db.view.joins cannot join the entry table '${target}' — no join aliases / self-joins yet`,
              severity: 1,
              range: args[0].range,
            });
          } else if (earlier.includes(target)) {
            errors.push({
              message: `'${target}' is joined more than once — no join aliases / self-joins yet`,
              severity: 1,
              range: args[0].range,
            });
          }
        }

        // VJ1/VJ2: the condition may reference the join target, the entry
        // table and joins declared before this one (chained joins)
        if (args[1]?.queryNode && args[0]) {
          const joinTargetName = args[0].text;
          errors.push(
            ...validateQueryScope(
              args[1],
              [joinTargetName, entryTypeName, ...earlier],
              entryTypeName,
              doc,
              "a join may reference the entry table and joins declared before it",
            ),
          );
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
      argument: {
        name: "condition",
        type: "query",
        description: "Filter expression for the view WHERE clause.",
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
        const entryTypeName = getAnnotationAlias(owner, "db.view.for");
        if (!entryTypeName) {
          errors.push({
            message: "@db.view.filter requires @db.view.for to identify the entry table",
            severity: 1,
            range: token.range,
          });
          return errors;
        }

        // VF1/VF2: the entry table and every joined table are in scope
        errors.push(...validateQueryScope(args[0], viewScopeTypes(owner), entryTypeName, doc));

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
        "References view field aliases with applied aggregate functions.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.view\n" +
        "@db.view.for Order\n" +
        "@db.view.having `totalRevenue > 100`\n" +
        "export interface TopCategories { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      argument: {
        name: "condition",
        type: "query",
        description: "HAVING condition referencing view aliases.",
      },
      validate(token, _args, _doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;
        if (!hasAnyViewAnnotation(owner)) {
          errors.push({
            message: "@db.view.having is only valid on @db.view interfaces",
            severity: 1,
            range: token.range,
          });
        }
        return errors;
      },
    }),
  },
};
