import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";
import type { TMessages } from "@atscript/core";
import { hasAnyViewAnnotation } from "../../shared/validation-utils";

export const dbTableAnnotations: TAnnotationsTree = {
  table: {
    filterable: tableCapability("filterable"),

    sortable: tableCapability("sortable"),

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

  http: {
    path: new AnnotationSpec({
      description:
        "HTTP endpoint path where this table is served. " +
        "Used by the UI for value-help on FK fields. " +
        "Gets overwritten by the final controller prefix at runtime." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.table "authors"\n' +
        '@db.http.path "/authors"\n' +
        "export interface Author { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      argument: {
        name: "path",
        type: "string",
        description: "Relative HTTP path (e.g., '/authors')",
      },
    }),
  },

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

  deep: {
    insert: new AnnotationSpec({
      description:
        "Declares the maximum nesting depth this table accepts for insert payloads. " +
        "`N` is a non-negative integer. Payloads deeper than `N` are rejected at the server boundary " +
        "with HTTP 400, and the `/meta` serializer exposes `N + 0.5` as `refDepth` so clients know " +
        "how many levels of FK expansion to expect on the wire.\n\n" +
        "**BREAKING:** A table without this annotation is treated as `@db.deep.insert 0` — nested " +
        "inserts are rejected and meta ships shallow refs only. Add `@db.deep.insert N` explicitly " +
        "to any interface that needs nested-write support." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.table "authors"\n' +
        "@db.deep.insert 2\n" +
        "export interface Author { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      multiple: false,
      argument: {
        name: "depth",
        type: "number",
        description: "Non-negative integer: maximum nesting depth accepted for nested inserts.",
      },
      validate(token, args, _doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;

        // D1: Must be on a @db.table interface
        if (owner.countAnnotations("db.table") === 0) {
          errors.push({
            message: "@db.deep.insert is only valid on @db.table interfaces",
            severity: 1,
            range: token.range,
          });
        }

        // D2: Must not appear more than once on the same interface
        if (owner.countAnnotations("db.deep.insert") > 1) {
          errors.push({
            message: "Multiple @db.deep.insert annotations on the same interface",
            severity: 1,
            range: token.range,
          });
        }

        // D3: Argument must be a non-negative integer
        const raw = args[0]?.text;
        if (raw !== undefined) {
          const num = Number(raw);
          if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
            errors.push({
              message: `@db.deep.insert depth must be a non-negative integer, got '${raw}'`,
              severity: 1,
              range: args[0]!.range,
            });
          }
        }

        return errors;
      },
    }),
  },
};

function tableCapability(capability: "filterable" | "sortable"): AnnotationSpec {
  const example =
    capability === "filterable"
      ? "  @db.column.filterable\n  email: string\n  // other fields not filterable via the controller\n"
      : "  @db.column.sortable\n  createdAt: number.timestamp\n  // other fields not sortable via the controller\n";
  const verb = capability === "filterable" ? "filter" : "sort";
  return new AnnotationSpec({
    description:
      `Controls ${verb}-gating on the readable controller's \`/query\` and \`/pages\` endpoints.\n\n` +
      `- **\`'auto'\`** (default when the annotation is absent) — every column is ${capability}.\n` +
      `- **\`'manual'\`** — only fields annotated \`@db.column.${capability}\` are ${capability}; ` +
      "  all others are rejected with HTTP 400.\n\n" +
      `Writing the annotation explicitly as \`@db.table.${capability} 'auto'\` has the same ` +
      "runtime effect as omitting it; use it to document intent.\n\n" +
      "**Example:**\n" +
      "```atscript\n" +
      '@db.table "users"\n' +
      `@db.table.${capability} "manual"\n` +
      "export interface User {\n" +
      example +
      "}\n" +
      "```\n",
    nodeType: ["interface"],
    multiple: false,
    argument: {
      optional: true,
      name: "mode",
      type: "string",
      description: `${verb[0]!.toUpperCase()}${verb.slice(1)}-gating mode: 'auto' (default) or 'manual'.`,
      values: ["auto", "manual"],
    },
    validate(token, _args, _doc) {
      const errors = [] as TMessages;
      const owner = token.parentNode!;
      if (owner.countAnnotations("db.table") === 0) {
        errors.push({
          message: `@db.table.${capability} requires @db.table on the same interface`,
          severity: 1,
          range: token.range,
        });
      }
      return errors;
    },
  });
}
