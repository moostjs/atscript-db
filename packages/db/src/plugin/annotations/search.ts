import { AnnotationSpec, annotationExample } from "@atscript/core";
import type { TAnnotationsTree, TMessages, Token } from "@atscript/core";

import { encryptedSearchProblem, refuseCiphertext } from "../../shared/view-validation";

/** Common embedding sizes, offered by completion; any positive integer is accepted. */
const COMMON_DIMENSIONS = [
  "256",
  "384",
  "512",
  "768",
  "1024",
  "1536",
  "2048",
  "3072",
  "4096",
  "6144",
  "8192",
  "16384",
];

function dimensionsProblem(arg: Token | undefined): TMessages[number] | undefined {
  if (!arg) return undefined;
  const num = Number(arg.text);
  if (Number.isInteger(num) && num > 0) return undefined;
  return {
    message: `@db.search.vector dimensions must be a positive integer, got '${arg.text}'`,
    severity: 1,
    range: arg.range,
  };
}

/** A threshold like `1e999` reads as `Infinity` (since 0.1.183). */
function thresholdProblem(arg: Token | undefined): TMessages[number] | undefined {
  if (!arg || Number.isFinite(Number(arg.text))) return undefined;
  return {
    message: `@db.search.vector.threshold must be a finite number, got '${arg.text}'`,
    severity: 1,
    range: arg.range,
  };
}

export const dbSearchAnnotations: TAnnotationsTree = {
  search: {
    vector: {
      $self: new AnnotationSpec({
        description: annotationExample(
          "Marks a field as a **vector embedding** for **similarity search**.\n\n" +
            "- Each adapter maps this to its native vector type and index:\n" +
            "  - **MongoDB** → Atlas `$vectorSearch` index\n" +
            "  - **MySQL** → `VECTOR(N)` column on MySQL 9+ and MariaDB (`JSON` on MySQL 8); vector search does not run on current MySQL or MariaDB servers\n" +
            "  - **PostgreSQL** → pgvector `vector(N)` column + distance operators\n" +
            "  - **SQLite** → `BLOB` column + `vec0` virtual index (requires the `sqlite-vec` extension; falls back to JSON `TEXT` when unavailable)\n" +
            "- Each search result carries `$score`: higher = closer, on the MongoDB Atlas `vectorSearchScore` scale on every database.",
          '@db.search.vector 1536, "cosine"',
          "embedding: db.vector",
        ),
        nodeType: ["prop"],
        validate: (token, args, doc) =>
          [
            dimensionsProblem(args[0]),
            encryptedSearchProblem(token, doc, "@db.search.vector"),
          ].filter((m) => m !== undefined),
        passedWhenReferred: false,
        multiple: false,
        argument: [
          {
            optional: false,
            name: "dimensions",
            type: "number",
            description:
              "The **number of dimensions in the vector** — a positive integer that must match your embedding model output.\n\n" +
              `**Common sizes:** ${COMMON_DIMENSIONS.join(", ")}.`,
            valueScope: () => COMMON_DIMENSIONS.map((value) => ({ value })),
          },
          {
            optional: true,
            name: "similarity",
            type: "string",
            description:
              'The **similarity metric** for vector search. Defaults to `"cosine"`.\n\n' +
              '**Available options:** `"cosine"`, `"euclidean"`, `"dotProduct"`.\n\n' +
              "**Result `$score`:** cosine `(1 + cosine similarity) / 2`; euclidean `1 / (1 + distance)`; " +
              "dotProduct `(1 + dot product) / 2` (use normalized vectors — otherwise it can leave `0`–`1`).",
            values: ["cosine", "euclidean", "dotProduct"],
          },
          {
            optional: true,
            name: "indexName",
            type: "string",
            description:
              "The **name of the vector search index** (optional, defaults to the field name).",
          },
        ],
      }),

      threshold: new AnnotationSpec({
        description: annotationExample(
          "Sets a **default minimum similarity score** for vector search queries on this field.\n\n" +
            "- A result is returned only when its `$score` reaches this value (up to floating-point rounding), on every database.\n" +
            "- `$score` (MongoDB Atlas scale): cosine `(1 + cosine similarity) / 2`; euclidean `1 / (1 + distance)`; dotProduct `(1 + dot product) / 2`.\n" +
            "- Query-time `$threshold` control overrides this default.\n" +
            "- Value range: `0` to `1` (where `1` means exact match).",
          '@db.search.vector 1536, "cosine"',
          "@db.search.vector.threshold 0.7",
          "embedding: db.vector",
        ),
        nodeType: ["prop"],
        validate: (_token, args) => [thresholdProblem(args[0])].filter((m) => m !== undefined),
        passedWhenReferred: false,
        multiple: false,
        argument: {
          optional: false,
          name: "value",
          type: "number",
          description:
            "Minimum `$score` (`0`–`1`). Results whose `$score` is below it are excluded.",
        },
      }),
    },

    filter: new AnnotationSpec({
      description: annotationExample(
        "Assigns a field as a **pre-filter** for a **vector search index**.\n\n" +
          "- Filters allow vector search queries to return results only within a specific subset.\n" +
          "- The referenced index must be defined using `@db.search.vector`.",
        '@db.search.vector 1536, "cosine"',
        "embedding: db.vector",
        "",
        '@db.search.filter "embedding"',
        "category: string",
      ),
      nodeType: ["prop"],
      validate: refuseCiphertext("@db.search.filter"),
      passedWhenReferred: false,
      multiple: true,
      argument: {
        optional: false,
        name: "indexName",
        type: "string",
        description:
          "The **name of the vector search index** (field name or explicit indexName from `@db.search.vector`) this field filters.",
      },
    }),
  },
};
