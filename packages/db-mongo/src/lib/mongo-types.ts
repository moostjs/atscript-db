// ── Constants ─────────────────────────────────────────────────────────────────

export const INDEX_PREFIX = "atscript__";
export const DEFAULT_INDEX_NAME = "DEFAULT";
export const JOINED_PREFIX = "__joined_";

// ── Index types ──────────────────────────────────────────────────────────────

export interface TPlainIndex {
  key: string;
  name: string;
  type: "plain" | "unique" | "text";
  fields: Record<string, 1 | "text">;
  weights: Record<string, number>;
}

export interface TSearchIndex {
  key: string;
  name: string;
  type: "dynamic_text" | "search_text" | "vector";
  definition: TMongoSearchIndexDefinition;
}

export type TMongoIndex = TPlainIndex | TSearchIndex;

export function mongoIndexKey(type: TMongoIndex["type"], name: string) {
  const cleanName = name
    .replace(/[^a-z0-9_.-]/gi, "_")
    .replace(/_+/g, "_")
    .slice(0, 127 - INDEX_PREFIX.length - type.length - 2);
  return `${INDEX_PREFIX}${type}__${cleanName}`;
}

// ── Search index definition ──────────────────────────────────────────────────

type TVectorSimilarity = "cosine" | "euclidean" | "dotProduct";

export interface TMongoSearchIndexDefinition {
  mappings?: {
    dynamic?: boolean;
    fields?: Record<string, { type: string; analyzer?: string }>;
  };
  fields?: Array<{
    path: string;
    type: "filter" | "vector";
    similarity?: TVectorSimilarity;
    numDimensions?: number;
  }>;
  analyzer?: string;
  text?: { fuzzy?: { maxEdits: number } };
}
