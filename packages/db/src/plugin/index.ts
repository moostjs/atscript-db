import type { TAtscriptPlugin } from "@atscript/core";
import { dbAggAnnotations } from "./annotations/agg";
import { dbAmountAnnotations } from "./annotations/amount";
import { dbColumnAnnotations } from "./annotations/column";
import { dbIndexAnnotations } from "./annotations/index-ann";
import { dbRelAnnotations } from "./annotations/rel";
import { dbSearchAnnotations } from "./annotations/search";
import { dbTableAnnotations } from "./annotations/table";
import { dbUnitAnnotations } from "./annotations/unit";
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
          encrypted: dbColumnAnnotations.encrypted,
          http: dbTableAnnotations.http,
          sync: dbTableAnnotations.sync,
          depth: dbTableAnnotations.depth,
          rel: dbRelAnnotations.rel,
          view: dbViewAnnotations.view,
          agg: dbAggAnnotations.agg,
          search: dbSearchAnnotations.search,
          amount: dbAmountAnnotations.amount,
          unit: dbUnitAnnotations.unit,
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
            geoPoint: {
              type: { kind: "array", of: "number" },
              documentation:
                "Represents a **geographic point** as a `[longitude, latitude]` tuple " +
                "(GeoJSON coordinate order).\n\n" +
                "- Equivalent to `number[]` of length 2, but explicitly marks the field as a geo point.\n" +
                "- **Coordinate order is GeoJSON order: longitude first.**\n" +
                "- Each adapter maps this to its native storage:\n" +
                "  - **MongoDB** → GeoJSON `{ type: 'Point', coordinates: [lng, lat] }`\n" +
                "  - **PostgreSQL** → PostGIS `geography(Point,4326)` (Phase 2)\n" +
                "  - **MySQL** → `POINT` SRID 4326 (Phase 2)\n" +
                "  - **SQLite** → JSON `TEXT` (Phase 2)\n\n" +
                "**Example:**\n" +
                "```atscript\n" +
                "@db.index.geo\n" +
                "geo: db.geoPoint\n" +
                "```\n",
            },
            currencyCode: {
              type: "string",
              documentation:
                "Represents a **currency code** — typically ISO 4217 (`'USD'`, `'EUR'`, `'JPY'`) " +
                "but accepts any uppercase alphanumeric code 2–10 chars long, so crypto and " +
                "custom codes (`'BTC'`, `'USDC'`, `'POINTS'`) fit too.\n\n" +
                "Pair with `@db.amount.currency.ref 'fieldName'` on a `decimal` field to bind " +
                "the amount to its row-level currency. The validator checks that the ref target " +
                "resolves to this type (or a plain `string`).\n\n" +
                "**Example:**\n" +
                "```atscript\n" +
                "currency: db.currencyCode\n" +
                "@db.amount.currency.ref 'currency'\n" +
                "amount: decimal\n" +
                "```\n",
              annotations: {
                "expect.pattern": [
                  {
                    pattern: "^[A-Z0-9]{2,10}$",
                    message: "Invalid currency code (expected 2–10 uppercase letters or digits)",
                  },
                ],
              },
            },
          },
        },
      },
    };
  },
});
