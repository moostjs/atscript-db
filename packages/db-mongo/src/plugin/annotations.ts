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

const tokenizations = ["edgeGram", "rightEdgeGram", "nGram"];

const searchStrategies = ["compound", "autocomplete", "text"];

const strategyDescription =
  "How `search()` matches a term against this index. Locks the query shape into the index — there is no query-time mode switching.\n\n" +
  "- `compound` (default) → rank exact-word hits above prefix hits: a wildcard `text` clause **plus** one `autocomplete` clause per autocomplete field. Degrades to plain `text` when the index has no autocomplete field.\n" +
  "- `autocomplete` → **prefix/typeahead only** — query just the autocomplete fields, no word-match ranking clause.\n" +
  "- `text` → **word matching only** — a single `text` operator over all string-mapped fields (autocomplete fields are matched via their companion `string` mapping).\n\n" +
  "To use the same data with a different strategy, declare a second index and select it per request with `$index`.";

const fuzzyDescription =
  "Maximum typo tolerance, applied **at query time** to the search operator.\n\n" +
  "- `0` (default) → no fuzzy matching (exact tokens).\n" +
  '- `1` → allows small typos (e.g., `"mongo"` ≈ `"mango"`).\n' +
  '- `2` → more typo tolerance (e.g., `"mongodb"` ≈ `"mangodb"`).\n\n' +
  "Atlas only accepts an edit distance of `1` or `2`; `0` simply disables fuzzy. " +
  "Can be overridden per request via the `$fuzzy` query control.";

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
          description: fuzzyDescription,
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
          description: fuzzyDescription,
        },
        {
          optional: true,
          name: "indexName",
          type: "string",
          description:
            'The name of the search index. Fields must reference this name using `@db.mongo.search.text` or `@db.mongo.search.autocomplete`. If not set, defaults to `"DEFAULT"`.',
        },
        {
          optional: true,
          name: "strategy",
          type: "string",
          description: strategyDescription,
          values: searchStrategies,
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

    autocomplete: new AnnotationSpec({
      description:
        "Marks a field for **prefix / typeahead (as-you-type)** matching in a MongoDB Atlas Search Index.\n\n" +
        "- Indexes the field as the Atlas **`autocomplete`** type, **and** double-maps it as `string` so exact-word hits still rank.\n" +
        '- Lets `search()` match partial words: with the default `edgeGram` tokenization, `"art"` matches `"Artem"` **as you type** (no whole word required).\n' +
        "- Use `nGram` tokenization for true mid-word (infix/substring) matching at higher index cost.\n" +
        "- Like `@db.mongo.search.text`, the field joins the index named by `indexName` (or the default index).\n\n" +
        "**Example:**\n" +
        "```atscript\n" +
        '@db.mongo.search.autocomplete "users"\n' +
        "username: string\n" +
        "```\n",
      nodeType: ["prop"],
      multiple: true,
      argument: [
        {
          optional: true,
          name: "indexName",
          type: "string",
          description:
            'The **name of the search index** (defined by `@db.mongo.search.static`) this field joins. If not set, defaults to `"DEFAULT"`.',
        },
        {
          optional: true,
          name: "tokenization",
          type: "string",
          description:
            "How the field is tokenized for partial matching:\n\n" +
            '- `"edgeGram"` (default) → **prefix** matching from the start of each word (`"art"` → `"Artem"`).\n' +
            '- `"nGram"` → **substring/infix** matching anywhere inside a word (`"tem"` → `"Artem"`); larger index, slower builds.\n' +
            '- `"rightEdgeGram"` → **suffix** matching from the end of each word.',
          values: tokenizations,
        },
        {
          optional: true,
          name: "minGrams",
          type: "number",
          description: "Minimum number of characters per indexed sequence. Defaults to `2`.",
        },
        {
          optional: true,
          name: "maxGrams",
          type: "number",
          description: "Maximum number of characters per indexed sequence. Defaults to `15`.",
        },
        {
          optional: true,
          name: "foldDiacritics",
          type: "boolean",
          description:
            'Whether to fold (ignore) diacritics so `"café"` matches `"cafe"`. Defaults to `true`.',
        },
        {
          optional: true,
          name: "analyzer",
          type: "string",
          description:
            'The text analyzer for the companion `string` mapping. Defaults to `"lucene.standard"`.',
          values: analyzers,
        },
      ],
    }),
  },
};
