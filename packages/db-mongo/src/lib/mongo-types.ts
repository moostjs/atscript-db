// ── Constants ─────────────────────────────────────────────────────────────────

export const INDEX_PREFIX = "atscript__";
export const DEFAULT_INDEX_NAME = "DEFAULT";
export const JOINED_PREFIX = "__joined_";

// ── Index types ──────────────────────────────────────────────────────────────

export interface TPlainIndex {
  key: string;
  name: string;
  type: "plain" | "unique" | "text" | "2dsphere";
  fields: Record<string, 1 | "text" | "2dsphere">;
  weights: Record<string, number>;
  /**
   * For "present-only" unique indexes on optional fields: a MongoDB
   * `partialFilterExpression` restricting the index to rows where the optional
   * field(s) are present. This lets multiple value-less rows coexist (matching
   * SQL's `NULLS DISTINCT`) while present values stay unique. Absent for plain
   * unique indexes (all fields required) and non-unique indexes.
   */
  partialFilterExpression?: Record<string, unknown>;
}

export interface TSearchIndex {
  key: string;
  name: string;
  type: "dynamic_text" | "search_text" | "vector";
  definition: TMongoSearchIndexDefinition;
  /**
   * Query-time fuzzy (typo tolerance) declared via `@db.mongo.search.dynamic` /
   * `@db.mongo.search.static`. Carried as index metadata — NOT part of the Atlas
   * index `definition` (Atlas applies fuzzy at query time on the `text`/
   * `autocomplete` operator, not in the index schema). `buildSearchStage` reads
   * this and attaches it to the emitted operator.
   */
  fuzzy?: { maxEdits: number };
  /**
   * The match strategy declared via `@db.mongo.search.static`, locking this
   * index's query shape. `buildSearchStage` reads it; undefined → `"compound"`.
   * - `compound` — wildcard `text` + per-field `autocomplete` (exact ranks above prefix).
   * - `autocomplete` — autocomplete fields only (pure typeahead, no word clause).
   * - `text` — single `text` operator over all string-mapped fields.
   */
  strategy?: "compound" | "autocomplete" | "text";
}

export type TMongoIndex = TPlainIndex | TSearchIndex;

export function isPlainIndex(index: TMongoIndex): index is TPlainIndex {
  return (
    index.type === "plain" ||
    index.type === "unique" ||
    index.type === "text" ||
    index.type === "2dsphere"
  );
}

export function mongoIndexKey(type: TMongoIndex["type"], name: string) {
  const cleanName = name
    .replace(/[^a-z0-9_.-]/gi, "_")
    .replace(/_+/g, "_")
    .slice(0, 127 - INDEX_PREFIX.length - type.length - 2);
  return `${INDEX_PREFIX}${type}__${cleanName}`;
}

// ── Search index definition ──────────────────────────────────────────────────

type TVectorSimilarity = "cosine" | "euclidean" | "dotProduct";

/**
 * One Atlas Search field-type mapping. `type: "string"` is plain word matching;
 * `type: "autocomplete"` enables prefix/typeahead (edgeGram) or substring (nGram).
 * A field may carry several mappings at once (an array of these) — e.g. an
 * autocomplete field double-mapped as `string` so exact-word hits still rank.
 *
 * Container nodes carry `fields` instead of leaf attributes:
 * - `type: "document"` — a single embedded object (`identity: Identity`). Atlas
 *   does NOT accept a dotted mapping key, so each parent object on a nested path
 *   must be its own `document` node. Nested fields are reachable by the dotted
 *   query path and by a `{ wildcard: "*" }` `text` operator.
 * - `type: "embeddedDocuments"` — an array of objects (`items: Item[]`). Atlas
 *   cannot index array-of-object fields under a `document` node; they MUST use
 *   `embeddedDocuments` and be queried via the `embeddedDocument` operator
 *   (the wildcard `text` operator does not reach them).
 */
export interface TSearchFieldMapping {
  type: string;
  analyzer?: string;
  tokenization?: "edgeGram" | "rightEdgeGram" | "nGram";
  minGrams?: number;
  maxGrams?: number;
  foldDiacritics?: boolean;
  /** Nested mappings for `document` / `embeddedDocuments` container nodes. */
  fields?: Record<string, TSearchFieldMapping | TSearchFieldMapping[]>;
}

export interface TMongoSearchIndexDefinition {
  mappings?: {
    dynamic?: boolean;
    fields?: Record<string, TSearchFieldMapping | TSearchFieldMapping[]>;
  };
  fields?: Array<{
    path: string;
    type: "filter" | "vector";
    similarity?: TVectorSimilarity;
    numDimensions?: number;
  }>;
  analyzer?: string;
}
