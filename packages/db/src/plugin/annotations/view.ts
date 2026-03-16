import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";
import type { TMessages } from "@atscript/core";
import { getAnnotationAlias } from "../../shared/annotation-utils";
import {
  hasAnyViewAnnotation,
  validateQueryScope,
  validateRefArgument,
} from "../../shared/validation-utils";

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
        return errors;
      },
    }),

    joins: new AnnotationSpec({
      description:
        "Declares an explicit join for a view. Use when no `@db.rel.*` path exists between the entry table and the target.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.view.for Order\n" +
        "@db.view.joins Warehouse, `Warehouse.regionId = Order.regionId`\n" +
        "export interface OrderWarehouse { ... }\n" +
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

        // VJ1/VJ2: Validate query scope — only join target and entry table allowed
        if (args[1]?.queryNode && args[0]) {
          const joinTargetName = args[0].text;
          errors.push(
            ...validateQueryScope(args[1], [joinTargetName, entryTypeName], entryTypeName, doc),
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

        // Collect all joined tables for scope
        const allowedTypes = [entryTypeName];
        const joinsAnnotations = owner.annotations?.filter((a) => a.name === "db.view.joins");
        if (joinsAnnotations) {
          for (const join of joinsAnnotations) {
            if (join.args[0]) {
              allowedTypes.push(join.args[0].text);
            }
          }
        }

        // VF1/VF2: Validate query scope
        errors.push(...validateQueryScope(args[0], allowedTypes, entryTypeName, doc));

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
