import { AnnotationSpec } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";
import { isArray, isInterface, isProp, isRef, isStructure, isPrimitive } from "@atscript/core";
import type { SemanticNode, SemanticRefNode, Token, TMessages } from "@atscript/core";
import {
  getDbTableOwner,
  getParentStruct,
  getParentTypeName,
  validateFieldBaseType,
} from "../../shared/annotation-utils";
import { DERIVED_INCOMPATIBLE, JSON_LEAF_TYPES } from "../../shared/derived-rules";
import { jsonChainInfo } from "../../shared/view-validation";

/** Nav-field annotations: a navigation field has no column on this table. */
const NAV_ANNOTATIONS = ["db.rel.to", "db.rel.from", "db.rel.via"] as const;

/**
 * Compile-time placement rules of `@db.column.version.exempt` (E1–E5, W1, W2).
 * E6 (derived) lives in `DERIVED_INCOMPATIBLE`. The runtime mirror is
 * `TableMetadata._finalizeVersionExempt`.
 * @since 0.1.150
 */
function validateVersionExempt(token: Token): TMessages {
  const errors = [] as TMessages;
  const field = token.parentNode!;
  const fail = (message: string, severity: 1 | 2 = 1) => {
    errors.push({ message, severity, range: token.range });
  };
  const tag = "@db.column.version.exempt";

  if (field.countAnnotations("db.column.version") > 0) {
    fail(`${tag} cannot mark the version column itself`);
  }
  if (field.countAnnotations("meta.id") > 0) {
    fail(`${tag} cannot mark a primary key — it identifies the row and is never patched`);
  }
  if (NAV_ANNOTATIONS.some((n) => field.countAnnotations(n) > 0)) {
    fail(
      `${tag} cannot mark a navigation field — related rows follow their own table's versioning`,
    );
  }
  if (field.countAnnotations("db.ignore") > 0) {
    fail(`${tag} has no effect on an ignored field`, 2);
  }

  // Ancestor walk: prop → structure → (prop | array → prop | interface)
  let node: SemanticNode = field;
  let tableOwner: SemanticNode | undefined;
  let reported = false;
  while (node.ownerNode && isStructure(node.ownerNode)) {
    let up: SemanticNode | undefined = node.ownerNode.ownerNode;
    let viaArray = false;
    while (up && isArray(up)) {
      viaArray = true;
      up = up.ownerNode;
    }
    if (!up) break;
    if (isInterface(up)) {
      tableOwner = up;
      break;
    }
    if (!isProp(up)) break;
    if (!reported && viaArray) {
      fail(
        `${tag} cannot sit inside an array — mark the array field '${up.id ?? ""}' itself; array elements are not separate columns`,
      );
      reported = true;
    } else if (!reported && up.countAnnotations("db.json") > 0) {
      fail(
        `${tag} cannot sit inside a @db.json field — mark the @db.json field '${up.id ?? ""}' itself; a JSON column is written as one value`,
      );
      reported = true;
    }
    node = up;
  }

  // W1: the enclosing top-level table declares no version column
  if (tableOwner && isInterface(tableOwner) && tableOwner.countAnnotations("db.table") > 0) {
    const struct = tableOwner.getDefinition();
    let hasVersion = false;
    if (struct && isStructure(struct)) {
      for (const [, prop] of struct.props) {
        if (prop.countAnnotations("db.column.version") > 0) hasVersion = true;
      }
    }
    if (!hasVersion) {
      fail(
        `${tag} has no effect — table '${tableOwner.id ?? ""}' declares no @db.column.version`,
        2,
      );
    }
  }
  return errors;
}

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
      passedWhenReferred: false,
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
        "For nested (flattened) fields, the parent prefix is still prepended automatically. " +
        "Document storage (MongoDB) renames top-level fields only — a nested field keeps its name there." +
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
      passedWhenReferred: false,
      argument: {
        name: "name",
        type: "string",
        description: "The column/field name (without parent prefix for nested fields).",
      },
    }),

    renamed: new AnnotationSpec({
      description:
        "Specifies the previous local field name for column rename migration. " +
        "The sync engine generates ALTER TABLE RENAME COLUMN instead of drop+add " +
        "(on document storage, top-level fields only)." +
        "\n\n**Example:**\n" +
        "```atscript\n" +
        '@db.column.renamed "zip"\n' +
        "postalCode: string\n" +
        "// Renames address__zip → address__postalCode\n" +
        "```\n",
      nodeType: ["prop"],
      passedWhenReferred: false,
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
      passedWhenReferred: false,
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
      passedWhenReferred: false,
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

    derived: new AnnotationSpec({
      description:
        "Declares a **derived column**: a read-only column computed from one `string`, " +
        "`number` or `boolean` leaf inside a `@db.json` field of the **same table**, so the " +
        "leaf can be filtered, sorted, grouped and indexed like a real column. The field's " +
        "type is a chain reference into that field (`customerId: Order.payload.customer.id`); " +
        "the path may not cross an array or a `@db.encrypted` field. Declare the field " +
        "optional when the path can be absent (a missing leaf reads as `null`). A value " +
        "written to it is dropped; `$inc` / `$dec` / `$mul` on it are rejected.\n\n" +
        "Storage per adapter, schema sync and the compatible annotations: " +
        "https://atscript.dev/db/api/storage#derived-columns\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        "@db.table 'orders'\n" +
        "export interface Order {\n" +
        "  @meta.id\n" +
        "  id: number\n\n" +
        "  @db.json\n" +
        "  payload: {\n" +
        "    customer: { id: string, vip: boolean }\n" +
        "    total: number\n" +
        "  }\n\n" +
        "  @db.column.derived\n" +
        "  @db.index.plain\n" +
        "  customerId: Order.payload.customer.id\n\n" +
        "  @db.column.derived\n" +
        "  vip?: Order.payload.customer.vip\n" +
        "}\n" +
        "```\n",
      nodeType: ["prop"],
      passedWhenReferred: false,
      multiple: false,
      validate(token, _args, doc) {
        const errors = [] as TMessages;
        const field = token.parentNode!;
        const fail = (message: string, severity: 1 | 2 = 1) => {
          errors.push({ message, severity, range: token.range });
        };

        // D1: a top-level field of a @db.table
        const owner = getDbTableOwner(token);
        if (!owner || !isInterface(owner) || owner.countAnnotations("db.table") === 0) {
          fail("@db.column.derived is only valid on a top-level field of a @db.table interface");
          return errors;
        }

        // D8: exclusive with every annotation that needs a stored / writable column
        for (const [name, why] of DERIVED_INCOMPATIBLE) {
          if (field.countAnnotations(name) > 0) {
            fail(`@db.column.derived cannot coexist with @${name} — ${why}`);
          }
        }

        // D2/D3: the type is a chain reference into the enclosing table
        const definition = field.getDefinition();
        if (!definition || !isRef(definition) || !(definition as SemanticRefNode).hasChain) {
          fail(
            "@db.column.derived requires a chain reference into a @db.json field of the same table (e.g. `customerId: Order.payload.customer.id`)",
          );
          return errors;
        }
        const ref = definition as SemanticRefNode;
        const tableName = getParentTypeName(token);
        if (ref.id !== tableName) {
          fail(
            `@db.column.derived must reference the enclosing table '${tableName ?? ""}', not '${ref.id ?? ""}' — a derived column reads its own row`,
          );
          return errors;
        }

        const info = jsonChainInfo(ref, doc);
        const path = `${info.typeName}.${info.chain.join(".")}`;
        const notInsideJson = `@db.column.derived path '${path}' does not read inside a @db.json field — a flattened or scalar column needs no derived column`;
        if (info.chain.length < 2) {
          fail(notInsideJson);
          return errors;
        }
        if (!info.resolved) return errors;
        // D5: no arrays anywhere on the path
        if (info.viaArray) {
          fail(
            `@db.column.derived path '${path}' crosses an array — a derived column reads one scalar leaf`,
          );
          return errors;
        }
        // D4: the path descends into a @db.json field (no array — D5 above —
        // so the JSON root is a @db.json prop, and it is a step ABOVE the leaf)
        if (info.jsonRoot === undefined || info.jsonRoot >= info.chain.length) {
          fail(notInsideJson);
          return errors;
        }
        // D7: not inside an encrypted field
        if (info.viaEncrypted) {
          fail(
            `@db.column.derived path '${path}' reads inside a @db.encrypted field — ciphertext cannot be extracted`,
          );
          return errors;
        }
        // D6: string | number | boolean leaf
        if (info.leafType === undefined || !JSON_LEAF_TYPES.has(info.leafType)) {
          fail(
            `@db.column.derived path '${path}' must end at a string, number or boolean leaf` +
              (info.leafType ? ` (got '${info.leafType}')` : ""),
          );
          return errors;
        }
        // D9: an optional path may be absent → the field should be optional (warning)
        if (info.optional && !field.has("optional")) {
          fail(
            `@db.column.derived path '${path}' may be absent — declare the field optional (\`${field.id ?? ""}?:\`) so a missing leaf reads as null`,
            2,
          );
        }
        return errors;
      },
    }),

    dimension: new AnnotationSpec({
      description:
        "Marks a field as a dimension — groupable in aggregate queries ($groupBy). " +
        "Dimension fields automatically receive a database index during schema sync.",
      nodeType: ["prop"],
      passedWhenReferred: false,
    }),

    measure: new AnnotationSpec({
      description:
        "Marks a field as a measure — aggregatable in aggregate queries " +
        "(sum, avg, count, min, max). Only valid on numeric or decimal fields.",
      nodeType: ["prop"],
      passedWhenReferred: false,
      validate(token, _args, doc) {
        return validateFieldBaseType(token, doc, "@db.column.measure", ["number", "decimal"]);
      },
    }),

    filterable: columnCapability("filterable", "filtering"),

    sortable: columnCapability("sortable", "sorting"),

    searchable: new AnnotationSpec({
      description:
        "Includes this column in the generic `$search` fallback: when the adapter reports no " +
        "native search capability (no FTS / Atlas index configured), the readable controller " +
        "matches the `$search` term as a case-insensitive substring across all " +
        "`@db.column.searchable` fields (`$or`). Where adapter-native search IS available it " +
        "wins and this annotation is not consulted. The term is escaped literally — no " +
        "user-supplied regex. String-typed columns only.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        '@db.table "jobs"\n' +
        "export interface Job {\n" +
        "  @db.column.searchable\n" +
        "  jobName: string\n" +
        "  @db.column.searchable\n" +
        "  description: string\n" +
        "}\n" +
        "```\n",
      nodeType: ["prop"],
      passedWhenReferred: false,
      multiple: false,
      validate(token, _args, doc) {
        return validateFieldBaseType(token, doc, "@db.column.searchable", ["string"]);
      },
    }),

    version: {
      $self: new AnnotationSpec({
        description:
          "Marks a numeric column as the row's version for optimistic concurrency control (OCC). " +
          "The adapter auto-increments this column on every UPDATE, and callers may pass " +
          "`$cas: { <col>: N }` in a write payload to make the update conditional on the current version. " +
          "Direct writes to the version column (as plain SET, `$inc`, or `$mul`) are rejected. " +
          "Fields marked `@db.column.version.exempt` do not bump it." +
          "\n\n**Constraints:**\n" +
          "- At most one version column per table.\n" +
          "- Must resolve to an integer type (`int`, `int32`, `int64`, etc.).\n" +
          "- Default value on insert is `0`.\n" +
          "\n**Example:**\n" +
          "```atscript\n" +
          "@db.column.version\n" +
          "version: int\n" +
          "```\n",
        nodeType: ["prop"],
        passedWhenReferred: false,
        validate(token, _args, doc) {
          const errors = validateFieldBaseType(token, doc, "@db.column.version", "number");

          // Reject optional version fields — the column is server-managed and
          // always populated (DEFAULT 0); a nullable version column would let
          // `NULL + 1` produce `NULL` and silently break the auto-bump invariant.
          const field = token.parentNode!;
          if (field.has("optional")) {
            errors.push({
              message:
                "@db.column.version requires a non-optional field — version columns are always populated (default 0)",
              severity: 1,
              range: token.range,
            });
          }

          // Cross-field uniqueness: at most one @db.column.version per struct.
          const struct = getParentStruct(token);
          if (struct) {
            let count = 0;
            for (const [, prop] of struct.props) {
              if (prop.countAnnotations("db.column.version") > 0) count++;
            }
            if (count > 1) {
              errors.push({
                message: "At most one @db.column.version per table",
                severity: 1,
                range: token.range,
              });
            }
          }
          return errors;
        },
      }),

      exempt: new AnnotationSpec({
        description:
          "Marks a field as **version-exempt**: a patch that writes ONLY exempt fields " +
          "(`updateOne` / `bulkUpdate` without `$cas`, `updateMany`) leaves `@db.column.version` unchanged " +
          "and adds no version check. A patch touching any other field bumps as usual; `$cas`, replace and " +
          "`touchMany` always bump. Use it for derived/reporting columns refreshed in the background " +
          "(scores, counters, caches) so they do not invalidate versions held by editors. " +
          "On an object field it covers every nested field." +
          "\n\n**Example:**\n" +
          "```atscript\n" +
          "@db.column.version\n" +
          "version: number.int\n" +
          "@db.column.version.exempt\n" +
          "score: number\n" +
          "```\n",
        nodeType: ["prop"],
        passedWhenReferred: false,
        multiple: false,
        validate(token) {
          return validateVersionExempt(token);
        },
      }),
    },
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
      passedWhenReferred: false,
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
      passedWhenReferred: false,
      argument: {
        optional: true,
        name: "start",
        type: "number",
        description:
          "Starting value for the auto-increment sequence. Adapter-specific behavior; some adapters may ignore this.",
      },
      validate(token, args, doc) {
        const errors = validateFieldBaseType(token, doc, "db.default.increment", "number");
        // Schema sync refuses a primary-key change that demotes an auto-increment
        // column (MySQL cannot keep AUTO_INCREMENT off a key) — flag it at compile time.
        if (token.parentNode!.countAnnotations("meta.id") === 0) {
          errors.push({
            message: `@db.default.increment on a field without @meta.id — auto-increment columns must be primary-key columns for schema sync to manage them`,
            severity: 2,
            range: token.range,
          });
        }
        return errors;
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
      passedWhenReferred: false,
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
      passedWhenReferred: false,
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
    passedWhenReferred: false,
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
    passedWhenReferred: false,
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

  encrypted: new AnnotationSpec({
    description:
      "Encrypts this field at rest. Values are AES-256-GCM encrypted by the core layer " +
      "before reaching the database and decrypted on read — transparent to application code.\n\n" +
      "Constraints: the field cannot be filtered, sorted, indexed, used as PK/FK, " +
      "patched with arithmetic ops, or referenced by search/vector/geo features.\n\n" +
      "**Example:**\n" +
      "```atscript\n" +
      "@db.encrypted\n" +
      "apiToken?: string\n" +
      "```\n",
    nodeType: ["prop"],
    passedWhenReferred: false,
    multiple: false,
    validate(token, _args, _doc) {
      const errors = [] as TMessages;
      const field = token.parentNode!;
      const incompatible: Array<[string, string]> = [
        ["meta.id", "the primary key must be addressable"],
        ["db.rel.FK", "joins are impossible over ciphertext"],
        ["db.index.plain", "indexes over ciphertext are meaningless"],
        ["db.index.unique", "indexes over ciphertext are meaningless"],
        ["db.index.fulltext", "indexes over ciphertext are meaningless"],
        ["db.index.geo", "geo indexes over ciphertext are meaningless"],
        ["db.search.vector", "vector search over ciphertext is impossible"],
        ["db.search.filter", "search filters need cleartext equality"],
        ["db.column.version", "the OCC filter needs cleartext equality"],
        ["db.default.increment", "engine-side defaults bypass the encryption transform"],
        ["db.default.now", "engine-side defaults bypass the encryption transform"],
        ["db.mongo.search.text", "Atlas Search over ciphertext is impossible"],
        ["db.mongo.search.autocomplete", "Atlas Search over ciphertext is impossible"],
      ];
      for (const [name, why] of incompatible) {
        if (field.countAnnotations(name) > 0) {
          errors.push({
            message: `@db.encrypted cannot coexist with @${name} — ${why}`,
            severity: 1,
            range: token.range,
          });
        }
      }
      return errors;
    },
  }),

  writeOnly: new AnnotationSpec({
    description:
      "Marks a field as write-only over HTTP: it may be set through insert/update/replace " +
      "payloads but NEVER appears in read responses — the readable controller excludes it " +
      "from every projection, rejects filtering/sorting/grouping on it, and `/meta` serves " +
      "its TYPE (flagged `writeOnly`) so client preflight validation and generated forms " +
      "still know its shape. The classic case is a sealed secret (pair with `@db.encrypted`): " +
      "writable via generic forms, unreadable by anyone.\n\n" +
      "Server-side code reading through `AtscriptDbTable` still sees the value — the seal is " +
      "an HTTP-layer contract, not a storage one.\n\n" +
      "**Example:**\n" +
      "```atscript\n" +
      "@db.writeOnly\n" +
      "@db.encrypted\n" +
      "credentials?: string\n" +
      "```\n",
    nodeType: ["prop"],
    passedWhenReferred: false,
    multiple: false,
    validate(token, _args, _doc) {
      const errors = [] as TMessages;
      const field = token.parentNode!;
      if (field.countAnnotations("meta.id") > 0) {
        errors.push({
          message: `@db.writeOnly cannot coexist with @meta.id — the primary key must be readable`,
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
      `\`@db.table.${capability} 'manual'\`; otherwise ${verb} is open on every column the ` +
      "adapter can handle (default-open, back-compat) and the annotation is a no-op. Adapter " +
      "capability always wins: `@db.json` / array columns stay non-sortable (and non-filterable " +
      "on SQL adapters) even when annotated. `/meta.fields` advertises exactly what the gate " +
      "accepts; index-backed columns additionally carry the advisory `indexed` flag.\n\n" +
      "**Example:**\n" +
      "```atscript\n" +
      '@db.table "users"\n' +
      `@db.table.${capability} "manual"\n` +
      "export interface User {\n" +
      example +
      "}\n" +
      "```\n",
    nodeType: ["prop"],
    passedWhenReferred: false,
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
