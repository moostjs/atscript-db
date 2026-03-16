import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";
import type { TMessages } from "@atscript/core";
import { hasAnyViewAnnotation } from "../../shared/validation-utils";

export const dbTableAnnotations: TAnnotationsTree = {
  table: {
    $self: new AnnotationSpec({
      description:
        "Marks an interface as a database-persisted entity (table in SQL, collection in MongoDB). " +
        "If the name argument is omitted, the adapter derives the table name from the interface name." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.table "users"\n' +
        "export interface User { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      argument: {
        optional: true,
        name: "name",
        type: "string",
        description: "Table/collection name. If omitted, derived from interface name.",
      },
      validate(token, _args, _doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;
        // VW6: Cannot be both @db.table and @db.view
        if (hasAnyViewAnnotation(owner)) {
          errors.push({
            message: "An interface cannot be both a @db.table and a @db.view",
            severity: 1,
            range: token.range,
          });
        }
        return errors;
      },
    }),

    renamed: new AnnotationSpec({
      description:
        "Specifies the previous table name for table rename migration. " +
        "The sync engine generates ALTER TABLE RENAME instead of drop+create." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.table "app_users"\n' +
        '@db.table.renamed "users"\n' +
        "export interface User { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      argument: {
        name: "oldName",
        type: "string",
        description: "The previous table/collection name.",
      },
      validate(token, _args, _doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;
        if (owner.countAnnotations("db.table") === 0) {
          errors.push({
            message: "@db.table.renamed requires @db.table on the same interface",
            severity: 1,
            range: token.range,
          });
        }
        return errors;
      },
    }),
  },

  schema: new AnnotationSpec({
    description:
      "Assigns the entity to a database schema/namespace." +
      "\n\n**Example:**\n" +
      "```atscript\n" +
      '@db.table "users"\n' +
      '@db.schema "auth"\n' +
      "export interface User { ... }\n" +
      "```\n",
    nodeType: ["interface"],
    argument: {
      name: "name",
      type: "string",
      description: "Schema/namespace name.",
    },
  }),

  sync: {
    method: new AnnotationSpec({
      description:
        "Controls how the sync engine handles structural changes that cannot be applied via ALTER TABLE." +
        "\n\n" +
        '- `"recreate"` — lossless: create temp table, copy data, drop old, rename.\n' +
        '- `"drop"` — lossy: drop table entirely and create from scratch.\n\n' +
        "Without this annotation, structural changes fail with an error requiring manual intervention." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.sync.method "drop"\n' +
        "interface Logs { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      argument: {
        name: "method",
        type: "string",
        description: 'Sync method: "drop" (lossy) or "recreate" (lossless with data copy).',
        values: ["drop", "recreate"],
      },
    }),
  },
};
