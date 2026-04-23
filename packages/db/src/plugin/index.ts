import type { TAtscriptPlugin } from "@atscript/core";
import { dbAggAnnotations } from "./annotations/agg";
import { dbColumnAnnotations } from "./annotations/column";
import { dbIndexAnnotations } from "./annotations/index-ann";
import { dbRelAnnotations } from "./annotations/rel";
import { dbSearchAnnotations } from "./annotations/search";
import { dbTableAnnotations } from "./annotations/table";
import { dbViewAnnotations } from "./annotations/view";

export const dbPlugin: () => TAtscriptPlugin = () => ({
  name: "db",

  config() {
    return {
      annotations: {
        db: {
          patch: dbColumnAnnotations.patch,
          table: dbTableAnnotations.table,
          schema: dbTableAnnotations.schema,
          index: dbIndexAnnotations.index,
          column: dbColumnAnnotations.column,
          default: dbColumnAnnotations.default,
          json: dbColumnAnnotations.json,
          ignore: dbColumnAnnotations.ignore,
          http: dbTableAnnotations.http,
          sync: dbTableAnnotations.sync,
          deep: dbTableAnnotations.deep,
          rel: dbRelAnnotations.rel,
          view: dbViewAnnotations.view,
          agg: dbAggAnnotations.agg,
          search: dbSearchAnnotations.search,
        },
      },
      primitives: {
        db: {
          extensions: {
            vector: {
              type: { kind: "array", of: "number" },
              documentation:
                "Represents a **vector embedding** (array of numbers) for **similarity search**.\n\n" +
                "- Equivalent to `number[]` but explicitly marks the field as a vector embedding.\n" +
                "- Each adapter maps this to its native vector type:\n" +
                "  - **MongoDB** → BSON array\n" +
                "  - **MySQL 9+** → `VECTOR(N)`\n" +
                "  - **PostgreSQL** → pgvector `vector(N)`\n" +
                "  - **SQLite** → JSON\n\n" +
                "**Example:**\n" +
                "```atscript\n" +
                '@db.search.vector 1536, "cosine"\n' +
                "embedding: db.vector\n" +
                "```\n",
            },
          },
        },
      },
    };
  },
});
