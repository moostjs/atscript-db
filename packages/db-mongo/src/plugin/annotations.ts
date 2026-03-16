import type { TAnnotationsTree, TMessages } from "@atscript/core";
import { AnnotationSpec, isInterface, isStructure, isRef, isPrimitive } from "@atscript/core";

const analyzers = [
  "lucene.standard",
  "lucene.simple",
  "lucene.whitespace",
  "lucene.english",
  "lucene.french",
  "lucene.german",
  "lucene.italian",
  "lucene.portuguese",
  "lucene.spanish",
  "lucene.chinese",
  "lucene.hindi",
  "lucene.bengali",
  "lucene.russian",
  "lucene.arabic",
];

/**
 * MongoDB-specific annotations.
 *
 * Merged into the global config under `{ db: { mongo: ... } }` so they
 * live alongside core's `@db.table`, `@db.index.*`, etc.
 *
 * Annotations removed (now in core):
 * - `@mongo.index.plain` → use `@db.index.plain`
 * - `@mongo.index.unique` → use `@db.index.unique`
 * - `@db.mongo.index.text` → use `@db.index.fulltext` (with optional weight arg)
 * - `@db.mongo.patch.strategy` → use `@db.patch.strategy`
 * - `@db.mongo.array.uniqueItems` → use `@expect.array.uniqueItems`
 * - `@db.mongo.autoIndexes` → removed (use explicit syncIndexes() calls)
 * - `@db.mongo.search.vector` → use `@db.search.vector` (generic, in @atscript/db/plugin)
 * - `@db.mongo.search.filter` → use `@db.search.filter` (generic, in @atscript/db/plugin)
 */
export const annotations: TAnnotationsTree = {
  collection: new AnnotationSpec({
    description:
      "Marks an interface as a **MongoDB collection**.\n\n" +
      '- Use together with `@db.table "name"` which provides the collection name.\n' +
      "- Automatically injects a **non-optional** `_id` field if not explicitly defined.\n" +
      "- `_id` must be of type **`string`**, **`number`**, or **`mongo.objectId`**.\n\n" +
      "**Example:**\n" +
      "```atscript\n" +
      '@db.table "users"\n' +
      "@db.mongo.collection\n" +
      "export interface User {\n" +
      "    _id: mongo.objectId\n" +
      "    email: string.email\n" +
      "}\n" +
      "```\n",
    nodeType: ["interface"],
    validate(token, args, doc) {
      const parent = token.parentNode;
      const struc = parent?.getDefinition();
      const errors = [] as TMessages;
      if (isInterface(parent) && parent.props.has("_id") && isStructure(struc)) {
        const _id = parent.props.get("_id")!;
        const isOptional = !!_id.token("optional");
        if (isOptional) {
          errors.push({
            message: `[db.mongo] _id can't be optional in Mongo Collection`,
            severity: 1,
            range: _id.token("identifier")!.range,
          });
        }
        const definition = _id.getDefinition();
        if (!definition) {
          return errors;
        }
        let wrongType = false;
        if (isRef(definition)) {
          const def = doc.unwindType(definition.id!, definition.chain)?.def;
          if (isPrimitive(def) && !["string", "number"].includes(def.config.type as string)) {
            wrongType = true;
          }
        } else {
          wrongType = true;
        }
        if (wrongType) {
          errors.push({
            message: `[db.mongo] _id must be of type string, number or mongo.objectId`,
            severity: 1,
            range: _id.token("identifier")!.range,
          });
        }
      }
      return errors;
    },
    modify(token, _args, _doc) {
      // add _id property if not exists
      const parent = token.parentNode;
      const struc = parent?.getDefinition();
      if (isInterface(parent) && !parent.props.has("_id") && isStructure(struc)) {
        struc.addVirtualProp({
          name: "_id",
          type: "mongo.objectId",
          documentation: "Mongodb Primary Key ObjectId",
        });
      }
    },
  }),

  capped: new AnnotationSpec({
    description:
      "Creates a **capped collection** with a fixed maximum size.\n\n" +
      "- Capped collections have fixed size and maintain insertion order.\n" +
      "- Ideal for logs, event streams, and cache-like data.\n" +
      '- Changing the cap size requires dropping and recreating the collection — use `@db.sync.method "drop"` to allow this.\n\n' +
      "**Example:**\n" +
      "```atscript\n" +
      '@db.table "logs"\n' +
      "@db.mongo.collection\n" +
      "@db.mongo.capped 10485760, 10000\n" +
      '@db.sync.method "drop"\n' +
      "export interface LogEntry {\n" +
      "    message: string\n" +
      "    timestamp: number\n" +
      "}\n" +
      "```\n",
    nodeType: ["interface"],
    multiple: false,
    argument: [
      {
        optional: false,
        name: "size",
        type: "number",
        description: "Maximum size of the collection in **bytes**.",
      },
      {
        optional: true,
        name: "max",
        type: "number",
        description:
          "Maximum number of documents in the collection. If omitted, only the byte size limit applies.",
      },
    ],
  }),

  search: {
    dynamic: new AnnotationSpec({
      description:
        "Creates a **dynamic MongoDB Search Index** that applies to the entire collection.\n\n" +
        "- **Indexes all text fields automatically** (no need to specify fields).\n" +
        "- Supports **language analyzers** for text tokenization.\n" +
        "- Enables **fuzzy search** (typo tolerance) if needed.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        '@db.mongo.search.dynamic "lucene.english", 1\n' +
        "export interface MongoCollection {}\n" +
        "```\n",
      nodeType: ["interface"],
      multiple: false,
      argument: [
        {
          optional: true,
          name: "analyzer",
          type: "string",
          description:
            'The **text analyzer** for tokenization. Defaults to `"lucene.standard"`.\n\n' +
            '**Available options:** `"lucene.standard"`, `"lucene.english"`, `"lucene.spanish"`, etc.',
          values: analyzers,
        },
        {
          optional: true,
          name: "fuzzy",
          type: "number",
          description:
            "Maximum typo tolerance (`0-2`). Defaults to `0` (no fuzzy search).\n\n" +
            "- `0` → Exact match required.\n" +
            '- `1` → Allows small typos (e.g., `"mongo"` ≈ `"mango"`).\n' +
            '- `2` → More typo tolerance (e.g., `"mongodb"` ≈ `"mangodb"`).',
        },
      ],
    }),

    static: new AnnotationSpec({
      description:
        "Defines a **MongoDB Atlas Search Index** for the collection. The props can refer to this index using `@db.mongo.search.text` annotation.\n\n" +
        "- **Creates a named search index** for full-text search.\n" +
        "- **Specify analyzers and fuzzy search** behavior at the index level.\n" +
        "- **Fields must explicitly use `@db.mongo.search.text`** to be included in this search index.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        '@db.mongo.search.static "lucene.english", 1, "mySearchIndex"\n' +
        "export interface MongoCollection {}\n" +
        "```\n",
      nodeType: ["interface"],
      multiple: true,
      argument: [
        {
          optional: true,
          name: "analyzer",
          type: "string",
          description:
            'The text analyzer for tokenization. Defaults to `"lucene.standard"`.\n\n' +
            '**Available options:** `"lucene.standard"`, `"lucene.english"`, `"lucene.spanish"`, `"lucene.german"`, etc.',
          values: analyzers,
        },
        {
          optional: true,
          name: "fuzzy",
          type: "number",
          description:
            "Maximum typo tolerance (`0-2`). **Defaults to `0` (no fuzzy matching).**\n\n" +
            "- `0` → No typos allowed (exact match required).\n" +
            '- `1` → Allows small typos (e.g., "mongo" ≈ "mango").\n' +
            '- `2` → More typo tolerance (e.g., "mongodb" ≈ "mangodb").',
        },
        {
          optional: true,
          name: "indexName",
          type: "string",
          description:
            'The name of the search index. Fields must reference this name using `@db.mongo.search.text`. If not set, defaults to `"DEFAULT"`.',
        },
      ],
    }),

    text: new AnnotationSpec({
      description:
        "Marks a field to be **included in a MongoDB Atlas Search Index** defined by `@db.mongo.search.static`.\n\n" +
        "- **The field has to reference an existing search index name**.\n" +
        "- If index name is not defined, a new search index with default attributes will be created.\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        '@db.mongo.search.text "lucene.english", "mySearchIndex"\n' +
        "firstName: string\n" +
        "```\n",
      nodeType: ["prop"],
      multiple: true,
      argument: [
        {
          optional: true,
          name: "analyzer",
          type: "string",
          description:
            'The text analyzer for tokenization. Defaults to `"lucene.standard"`.\n\n' +
            '**Available options:** `"lucene.standard"`, `"lucene.english"`, `"lucene.spanish"`, `"lucene.german"`, etc.',
          values: analyzers,
        },
        {
          optional: true,
          name: "indexName",
          type: "string",
          description:
            'The **name of the search index** defined in `@db.mongo.search.static`. This links the field to the correct index. If not set, defaults to `"DEFAULT"`.',
        },
      ],
    }),
  },
};
