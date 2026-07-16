import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";
import type { TMessages } from "@atscript/core";
import type { SemanticNode } from "@atscript/core";
import { isInterface, isStructure } from "@atscript/core";
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

    preferredId: {
      uniqueIndex: new AnnotationSpec({
        description:
          "Selects a unique index as the table's preferred row identifier. " +
          "When the unique-index name is omitted, the first declared unique-index group wins." +
          "\n\n**Example:**\n" +
          "```atscript\n" +
          "@db.table\n" +
          '@db.table.preferredId.uniqueIndex "by_slug"\n' +
          "export interface Post {\n" +
          '  @db.index.unique "by_slug"\n' +
          "  slug: string\n" +
          "}\n" +
          "```\n",
        nodeType: ["interface"],
        multiple: false,
        argument: {
          optional: true,
          name: "name",
          type: "string",
          description: "Unique-index group name. If omitted, the first declared group is used.",
        },
        validate(token, args, _doc) {
          const errors = [] as TMessages;
          const owner = token.parentNode!;

          if (hasAnyViewAnnotation(owner)) {
            errors.push({
              message:
                "@db.table.preferredId.uniqueIndex is not supported on @db.view interfaces (views have no unique-index declarations).",
              severity: 1,
              range: token.range,
            });
          }

          if (owner.countAnnotations("db.table") === 0) {
            errors.push({
              message: "@db.table.preferredId.uniqueIndex requires @db.table on the same interface",
              severity: 1,
              range: token.range,
            });
          }

          const groups = collectUniqueIndexGroups(owner);
          if (groups.length === 0) {
            errors.push({
              message:
                "@db.table.preferredId.uniqueIndex requires at least one @db.index.unique on a prop of this interface.",
              severity: 1,
              range: token.range,
            });
            return errors;
          }

          const requestedName = args[0]?.text;
          if (requestedName !== undefined && !groups.some((group) => group === requestedName)) {
            errors.push({
              message:
                `@db.table.preferredId.uniqueIndex("${requestedName}") does not match any declared ` +
                `@db.index.unique on this interface; declared groups: ${JSON.stringify(groups)}.`,
              severity: 1,
              range: args[0]!.range,
            });
          }

          if (requestedName === undefined && groups.length >= 2) {
            errors.push({
              message:
                "@db.table.preferredId.uniqueIndex without a name uses the first declared unique-index group; " +
                "this can shift if props are reordered.",
              severity: 2,
              range: token.range,
            });
          }

          return errors;
        },
      }),
    },
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

  space: new AnnotationSpec({
    description:
      "Binds the entity to a named database space (a `DbSpace` — one per " +
      "physical database) for apps running more than one database at once " +
      "(e.g. MongoDB + PostgreSQL). Absent means the default space." +
      "\n\n" +
      "Consumed by the generated model manifest (grouping in `modelsBySpace`) " +
      "and by `@TableController(Model)` token binding, which resolves the " +
      "space registered under this name via `provideDbSpace(space, name)`." +
      "\n\n**Example:**\n" +
      "```atscript\n" +
      '@db.table "feed_runs"\n' +
      '@db.space "analytics"\n' +
      "export interface FeedRun { ... }\n" +
      "```\n",
    nodeType: ["interface"],
    argument: {
      name: "name",
      type: "string",
      description: 'Space name (matches `provideDbSpace(space, name)`). Default: "default".',
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

  depth: {
    limit: new AnnotationSpec({
      description:
        "Security guard on nested-write payloads. `N` is a non-negative integer declaring " +
        "the maximum depth a client may nest `@db.rel.from` children in insert, replace, " +
        "or patch payloads. Writes deeper than `N` are rejected at the server boundary with " +
        "HTTP 400 before any DB access.\n\n" +
        "**Default when absent:** `0` — any nested-write payload is rejected. Authors opt in " +
        "explicitly to `N >= 1` when they want the server to accept deep writes. This is a " +
        "security / blast-radius control, not a performance knob.\n\n" +
        "**Scope:** affects only write acceptance. Has no effect on `/meta` serialization, " +
        "read/query paths, or wire shape — the meta endpoint always ships FK refs as the " +
        "shallow `{ id, metadata }` shape regardless of this annotation." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.table "authors"\n' +
        "@db.depth.limit 2\n" +
        "export interface Author { ... }\n" +
        "```\n",
      nodeType: ["interface"],
      multiple: false,
      argument: {
        name: "depth",
        type: "number",
        description: "Non-negative integer: maximum nesting depth accepted for nested writes.",
      },
      validate(token, args, _doc) {
        const errors = [] as TMessages;
        const owner = token.parentNode!;

        // D1: Must be on a @db.table interface
        if (owner.countAnnotations("db.table") === 0) {
          errors.push({
            message: "@db.depth.limit is only valid on @db.table interfaces",
            severity: 1,
            range: token.range,
          });
        }

        // D2: Must not appear more than once on the same interface
        if (owner.countAnnotations("db.depth.limit") > 1) {
          errors.push({
            message: "Multiple @db.depth.limit annotations on the same interface",
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
              message: `@db.depth.limit depth must be a non-negative integer, got '${raw}'`,
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

function collectUniqueIndexGroups(owner: SemanticNode | undefined): string[] {
  if (!isInterface(owner)) {
    return [];
  }
  const definition = owner.getDefinition();
  if (!isStructure(definition)) {
    return [];
  }

  const groups: string[] = [];
  const seen = new Set<string>();
  for (const [propName, prop] of definition.props) {
    const annotations = prop.annotations?.filter((ann) => ann.name === "db.index.unique") ?? [];
    for (const ann of annotations) {
      const groupName = ann.args[0]?.text ?? propName;
      if (!seen.has(groupName)) {
        seen.add(groupName);
        groups.push(groupName);
      }
    }
  }
  return groups;
}

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
