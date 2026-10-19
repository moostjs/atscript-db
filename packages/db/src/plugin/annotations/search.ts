import { AnnotationSpec, annotationExample } from "@atscript/core";
import type { TAnnotationsTree } from "@atscript/core";

import { refuseCiphertext } from "../../shared/view-validation";

export const dbSearchAnnotations: TAnnotationsTree = {
  search: {
    vector: {
      $self: new AnnotationSpec({
        description: annotationExample(
          "Marks a field as a **vector embedding** for **similarity search**.\n\n" +
            "- Each adapter maps this to its native vector type and index:\n" +
            "  - **MongoDB** → Atlas `$vectorSearch` index\n" +
            "  - **MySQL 9+** → `VECTOR(N)` column + `VEC_DISTANCE_*` functions\n" +
            "  - **PostgreSQL** → pgvector `vector(N)` column + distance operators\n" +
            "  - **SQLite** → `BLOB` column + `vec0` virtual index (requires the `sqlite-vec` extension; falls back to JSON `TEXT` when unavailable)",
          '@db.search.vector 1536, "cosine"',
          "embedding: db.vector",
        ),
        nodeType: ["prop"],
        validate: refuseCiphertext("@db.search.vector"),
        passedWhenReferred: false,
        multiple: false,
        argument: [
          {
            optional: false,
            name: "dimensions",
            type: "number",
            description:
              "The **number of dimensions in the vector** (must match your embedding model output).",
            values: [
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
            ],
          },
          {
            optional: true,
            name: "similarity",
            type: "string",
            description:
              'The **similarity metric** for vector search. Defaults to `"cosine"`.\n\n' +
              '**Available options:** `"cosine"`, `"euclidean"`, `"dotProduct"`.',
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
          "Sets a **default minimum similarity threshold** for vector search queries on this field.\n\n" +
            "- Results with a similarity score below this threshold are excluded.\n" +
            "- Query-time `$threshold` control overrides this default.\n" +
            "- Value range: `0` to `1` (where `1` means exact match).",
          '@db.search.vector 1536, "cosine"',
          "@db.search.vector.threshold 0.7",
          "embedding: db.vector",
        ),
        nodeType: ["prop"],
        passedWhenReferred: false,
        multiple: false,
        argument: {
          optional: false,
          name: "value",
          type: "number",
          description:
            "Minimum similarity score (`0`–`1`). Results below this threshold are excluded.",
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
