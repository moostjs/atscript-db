import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";
import { isArray, isInterface, isRef, isStructure, isPrimitive } from "@atscript/core";
import type { TMessages } from "@atscript/core";
import { getDbTableOwner, validateFieldBaseType } from "../../shared/annotation-utils";

export const dbColumnAnnotations: TAnnotationsTree = {
  patch: {
    strategy: new AnnotationSpec({
      description:
        "Defines the **patching strategy** for updating nested objects.\n\n" +
        '- **"replace"** → The field or object will be **fully replaced**.\n' +
        '- **"merge"** → The field or object will be **merged recursively** (applies only to objects, not arrays).\n\n' +
        "**Example:**\n" +
        "```atscript\n" +
        '@db.patch.strategy "merge"\n' +
        "settings: {\n" +
        "  notifications: boolean\n" +
        "  preferences: {\n" +
        "    theme: string\n" +
        "  }\n" +
        "}\n" +
        "```\n",
      nodeType: ["prop"],
      multiple: false,
      argument: {
        name: "strategy",
        type: "string",
        description: 'The **patch strategy** for this field: `"replace"` (default) or `"merge"`.',
        values: ["replace", "merge"],
      },
      validate(token, args, doc) {
        const field = token.parentNode!;
        const errors = [] as TMessages;
        const definition = field.getDefinition();
        if (!definition) {
          return errors;
        }
        let wrongType = false;
        if (isRef(definition)) {
          const def = doc.unwindType(definition.id!, definition.chain)?.def;
          if (!isStructure(def) && !isInterface(def) && !isArray(def)) {
            wrongType = true;
          }
        } else if (!isStructure(definition) && !isInterface(definition) && !isArray(definition)) {
          wrongType = true;
        }
        if (wrongType) {
          errors.push({
            message: `@db.patch.strategy requires a field of type object or array`,
            severity: 1,
            range: token.range,
          });
        }
        return errors;
      },
    }),
  },

  column: {
    $self: new AnnotationSpec({
      description:
        "Overrides the physical column name in the database. " +
        "For nested (flattened) fields, the parent prefix is still prepended automatically." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.column "first_name"\n' +
        "firstName: string\n" +
        "// → physical column: first_name\n" +
        "\n" +
        "// Nested:\n" +
        "address: {\n" +
        '  @db.column "zip_code"\n' +
        "  zip: string\n" +
        "}\n" +
        "// → physical column: address__zip_code\n" +
        "```\n",
      nodeType: ["prop"],
      argument: {
        name: "name",
        type: "string",
        description: "The column/field name (without parent prefix for nested fields).",
      },
    }),

    renamed: new AnnotationSpec({
      description:
        "Specifies the previous local field name for column rename migration. " +
        "The sync engine generates ALTER TABLE RENAME COLUMN instead of drop+add." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.column.renamed "zip"\n' +
        "postalCode: string\n" +
        "// Renames address__zip → address__postalCode\n" +
        "```\n",
      nodeType: ["prop"],
      argument: {
        name: "oldName",
        type: "string",
        description: "The old local field name (parent prefix is reconstructed automatically).",
      },
    }),

    collate: new AnnotationSpec({
      description:
        "Portable collation for string comparison and sorting. " +
        "Adapters map the generic value to their native collation." +
        "\n\n" +
        '- **"binary"** — exact byte comparison (case-sensitive)\n' +
        '- **"nocase"** — case-insensitive comparison\n' +
        '- **"unicode"** — full Unicode-aware sorting\n\n' +
        "For adapter-specific collations, use `@db.<engine>.collate` instead." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.column.collate "nocase"\n' +
        "username: string\n" +
        "```\n",
      nodeType: ["prop"],
      argument: {
        name: "collation",
        type: "string",
        values: ["binary", "nocase", "unicode"],
        description: 'Portable collation mode: "binary", "nocase", or "unicode".',
      },
      validate(token, args, doc) {
        return validateFieldBaseType(token, doc, "@db.column.collate", "string");
      },
    }),

    precision: new AnnotationSpec({
      description:
        "Sets decimal precision and scale for database storage. " +
        "Adapters map this to their native decimal type (e.g., `DECIMAL(10,2)` in SQL, ignored in MongoDB)." +
        "\n\n" +
        "For `decimal` fields the runtime value is a string; for `number` fields this is a DB storage hint only." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        "@db.column.precision 10, 2\n" +
        "price: decimal\n" +
        "```\n",
      nodeType: ["prop"],
      argument: [
        {
          name: "precision",
          type: "number",
          description: "Total number of significant digits.",
        },
        {
          name: "scale",
          type: "number",
          description: "Number of digits after the decimal point.",
        },
      ],
      validate(token, args, doc) {
        return validateFieldBaseType(token, doc, "@db.column.precision", ["number", "decimal"]);
      },
    }),

    dimension: new AnnotationSpec({
      description:
        "Marks a field as a dimension — groupable in aggregate queries ($groupBy). " +
        "Dimension fields automatically receive a database index during schema sync.",
      nodeType: ["prop"],
    }),

    measure: new AnnotationSpec({
      description:
        "Marks a field as a measure — aggregatable in aggregate queries " +
        "(sum, avg, count, min, max). Only valid on numeric or decimal fields.",
      nodeType: ["prop"],
      validate(token, _args, doc) {
        return validateFieldBaseType(token, doc, "@db.column.measure", ["number", "decimal"]);
      },
    }),

    filterable: columnCapability("filterable", "filtering"),

    sortable: columnCapability("sortable", "sorting"),
  },

  default: {
    $self: new AnnotationSpec({
      description:
        "Sets a static DB-level default value (used in DDL DEFAULT clause). " +
        "For string fields the value is used as-is; for other types it is parsed as JSON." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.default "active"\n' +
        "status: string\n" +
        "```\n",
      nodeType: ["prop"],
      argument: {
        name: "value",
        type: "string",
        description:
          "Static default value. Strings used as-is; other types parsed via JSON.parse().",
      },
    }),

    increment: new AnnotationSpec({
      description:
        "Auto-incrementing integer default. Each adapter maps this to its native mechanism " +
        "(e.g., `AUTO_INCREMENT` in MySQL, `INTEGER PRIMARY KEY` in SQLite, counter collection in MongoDB)." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        "@db.default.increment\n" +
        "id: number.int\n" +
        "\n" +
        "// With optional start value:\n" +
        "@db.default.increment 1000\n" +
        "id: number.int\n" +
        "```\n",
      nodeType: ["prop"],
      argument: {
        optional: true,
        name: "start",
        type: "number",
        description:
          "Starting value for the auto-increment sequence. Adapter-specific behavior; some adapters may ignore this.",
      },
      validate(token, args, doc) {
        return validateFieldBaseType(token, doc, "db.default.increment", "number");
      },
    }),

    uuid: new AnnotationSpec({
      description:
        "UUID generation default. Each adapter maps this to its native mechanism " +
        "(e.g., `DEFAULT (UUID())` in MySQL, `gen_random_uuid()` in PostgreSQL, app-level in SQLite)." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        "@db.default.uuid\n" +
        "id: string.uuid\n" +
        "```\n",
      nodeType: ["prop"],
      validate(token, args, doc) {
        return validateFieldBaseType(token, doc, "db.default.uuid", "string");
      },
    }),

    now: new AnnotationSpec({
      description:
        "Current timestamp default. Each adapter maps this to its native mechanism " +
        "(e.g., `DEFAULT CURRENT_TIMESTAMP` in MySQL, `DEFAULT now()` in PostgreSQL)." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        "@db.default.now\n" +
        "createdAt: number.timestamp\n" +
        "```\n",
      nodeType: ["prop"],
      validate(token, args, doc) {
        return validateFieldBaseType(token, doc, "db.default.now", ["number", "string"]);
      },
    }),
  },

  json: new AnnotationSpec({
    description:
      "Forces a field to be stored as a single JSON column instead of being flattened " +
      "into separate columns. Use on nested object fields that should remain as JSON " +
      "in the database." +
      "\n\n**Example:**\n" +
      "```atscript\n" +
      "@db.json\n" +
      "metadata: { key: string, value: string }\n" +
      "```\n",
    nodeType: ["prop"],
    validate(token, _args, doc) {
      const errors = [] as TMessages;
      const field = token.parentNode!;
      const definition = field.getDefinition();

      // J1: warning on primitive types
      if (definition && isRef(definition)) {
        const unwound = doc.unwindType(definition.id!, definition.chain);
        if (unwound && isPrimitive(unwound.def)) {
          errors.push({
            message:
              "@db.json on a primitive field has no effect — primitive fields are already stored as scalar columns",
            severity: 2,
            range: token.range,
          });
        }
      }

      return errors;
    },
  }),

  ignore: new AnnotationSpec({
    description:
      "Excludes a field from the database schema. The field exists in the Atscript type " +
      "but has no column in the DB." +
      "\n\n**Example:**\n" +
      "```atscript\n" +
      "@db.ignore\n" +
      "displayName: string\n" +
      "```\n",
    nodeType: ["prop"],
    validate(token, _args, _doc) {
      const errors = [] as TMessages;
      const field = token.parentNode!;
      if (field.countAnnotations("meta.id") > 0) {
        errors.push({
          message: `@db.ignore cannot coexist with @meta.id — a field cannot be both a primary key and excluded from the database`,
          severity: 1,
          range: token.range,
        });
      }
      return errors;
    },
  }),
};

function columnCapability(capability: "filterable" | "sortable", verb: string): AnnotationSpec {
  const example =
    capability === "filterable"
      ? "  @db.column.filterable\n  email: string\n"
      : "  @db.column.sortable\n  createdAt: number.timestamp\n";
  return new AnnotationSpec({
    description:
      `Marks a column as ${capability} in the readable controller's query/pages endpoints. ` +
      `Relevant only when the host \`@db.table\` interface opts into strict mode with ` +
      `\`@db.table.${capability} 'manual'\`; otherwise ${verb} is open on all columns ` +
      "(default-open, back-compat).\n\n" +
      "**Example:**\n" +
      "```atscript\n" +
      '@db.table "users"\n' +
      `@db.table.${capability} "manual"\n` +
      "export interface User {\n" +
      example +
      "}\n" +
      "```\n",
    nodeType: ["prop"],
    multiple: false,
    validate(token, _args, _doc) {
      const errors = [] as TMessages;
      const owner = getDbTableOwner(token);
      if (!owner || owner.countAnnotations("db.table") === 0) {
        errors.push({
          message: `@db.column.${capability} is only valid on fields of a @db.table interface`,
          severity: 1,
          range: token.range,
        });
      }
      return errors;
    },
  });
}
