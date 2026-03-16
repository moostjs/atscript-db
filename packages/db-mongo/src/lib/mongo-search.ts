import type { Collection, Document } from "mongodb";
import type { DbControls, DbQuery, TSearchIndexInfo } from "@atscript/db";
import type { TMongoIndex, TSearchIndex } from "./mongo-types";
import { buildMongoFilter } from "./mongo-filter";

// ── Host interface ───────────────────────────────────────────────────────────

export interface TMongoSearchHost {
  readonly collection: Collection<any>;
  getMongoSearchIndex(name?: string): TMongoIndex | undefined;
  getMongoSearchIndexes(): Map<string, TMongoIndex>;
  getVectorThreshold(indexKey?: string): number | undefined;
  _getSessionOpts(): Record<string, unknown>;
  _log(...args: unknown[]): void;
}

// ── Exported functions ───────────────────────────────────────────────────────

/** Returns available search indexes as generic metadata for UI. */
export function getSearchIndexesImpl(host: TMongoSearchHost): TSearchIndexInfo[] {
  const result: TSearchIndexInfo[] = [];
  for (const [name, index] of host.getMongoSearchIndexes()) {
    result.push({
      name,
      description: `${index.type} index`,
      type: index.type === "vector" ? ("vector" as const) : ("text" as const),
    });
  }
  return result;
}

/** Checks if any vector search index is available. */
export function isVectorSearchableImpl(host: TMongoSearchHost): boolean {
  for (const index of host.getMongoSearchIndexes().values()) {
    if (index.type === "vector") {
      return true;
    }
  }
  return false;
}

/** Text search via $search aggregation stage. */
export async function searchImpl(
  host: TMongoSearchHost,
  text: string,
  query: DbQuery,
  indexName?: string,
): Promise<Array<Record<string, unknown>>> {
  const stage = buildSearchStage(host, text, indexName);
  if (!stage) {
    throw new Error(
      indexName ? `Search index "${indexName}" not found` : "No search index available",
    );
  }
  return runSearchPipeline(host, stage, query, "search");
}

/** Text search with faceted count. */
export async function searchWithCountImpl(
  host: TMongoSearchHost,
  text: string,
  query: DbQuery,
  indexName?: string,
): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
  const stage = buildSearchStage(host, text, indexName);
  if (!stage) {
    throw new Error(
      indexName ? `Search index "${indexName}" not found` : "No search index available",
    );
  }
  return runSearchWithCountPipeline(host, stage, query, "searchWithCount");
}

/** Vector search via $vectorSearch aggregation stage. */
export async function vectorSearchImpl(
  host: TMongoSearchHost,
  vector: number[],
  query: DbQuery,
  indexName?: string,
): Promise<Array<Record<string, unknown>>> {
  const controls = query.controls || {};
  const stage = buildVectorSearchStage(
    host,
    vector,
    indexName,
    controls.$limit as number | undefined,
  );
  const threshold = resolveThreshold(host, controls, indexName);
  return runSearchPipeline(host, stage, query, "vectorSearch", threshold);
}

/** Vector search with faceted count. */
export async function vectorSearchWithCountImpl(
  host: TMongoSearchHost,
  vector: number[],
  query: DbQuery,
  indexName?: string,
): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
  const controls = query.controls || {};
  const stage = buildVectorSearchStage(
    host,
    vector,
    indexName,
    controls.$limit as number | undefined,
  );
  const threshold = resolveThreshold(host, controls, indexName);
  return runSearchWithCountPipeline(host, stage, query, "vectorSearchWithCount", threshold);
}

/** Resolves the effective threshold: query-time $threshold > schema-level @db.search.vector.threshold. */
function resolveThreshold(
  host: TMongoSearchHost,
  controls: DbControls,
  indexName?: string,
): number | undefined {
  const queryThreshold = (controls as Record<string, unknown>).$threshold as number | undefined;
  if (queryThreshold !== undefined) {
    return queryThreshold;
  }
  return host.getVectorThreshold(indexName);
}

// ── Stage builders ───────────────────────────────────────────────────────────

/** Builds a MongoDB $search pipeline stage for text search. */
function buildSearchStage(
  host: TMongoSearchHost,
  text: string,
  indexName?: string,
): Document | undefined {
  const index = host.getMongoSearchIndex(indexName);
  if (!index) {
    return undefined;
  }
  if (index.type === "vector") {
    throw new Error("Vector indexes cannot be used with text search. Use vectorSearch() instead.");
  }
  return {
    $search: { index: index.key, text: { query: text, path: { wildcard: "*" } } },
  };
}

/** Builds a $vectorSearch aggregation stage from a pre-computed vector. */
function buildVectorSearchStage(
  host: TMongoSearchHost,
  vector: number[],
  indexName?: string,
  limit?: number,
): Document {
  let index: TSearchIndex | undefined;
  if (indexName) {
    const found = host.getMongoSearchIndex(indexName);
    if (!found || found.type !== "vector") {
      throw new Error(`Vector index "${indexName}" not found`);
    }
    index = found as TSearchIndex;
  } else {
    for (const idx of host.getMongoSearchIndexes().values()) {
      if (idx.type === "vector") {
        index = idx as TSearchIndex;
        break;
      }
    }
  }
  if (!index) {
    throw new Error("No vector index available");
  }

  let vectorField: { path: string } | undefined;
  if (index.definition.fields) {
    for (const f of index.definition.fields) {
      if (f.type === "vector") {
        vectorField = f;
        break;
      }
    }
  }
  if (!vectorField) {
    throw new Error(`Vector index "${index.name}" has no vector field`);
  }

  return {
    $vectorSearch: {
      index: index.key,
      path: vectorField.path,
      queryVector: vector,
      numCandidates: Math.max((limit || 20) * 10, 100),
      limit: limit || 20,
    },
  };
}

// ── Shared pipeline runners ──────────────────────────────────────────────────

/** Runs a search/vector pipeline and returns results. Shared by search + vectorSearch. */
async function runSearchPipeline(
  host: TMongoSearchHost,
  stage: Document,
  query: DbQuery,
  label: string,
  threshold?: number,
): Promise<Array<Record<string, unknown>>> {
  const filter = buildMongoFilter(query.filter);
  const controls = query.controls || {};
  const pipeline: Document[] = [stage];
  if (threshold !== undefined) {
    pipeline.push({ $addFields: { _score: { $meta: "vectorSearchScore" } } });
    pipeline.push({ $match: { _score: { $gte: threshold } } });
  }
  pipeline.push({ $match: filter });
  if (controls.$sort) {
    pipeline.push({ $sort: controls.$sort });
  }
  if (controls.$skip) {
    pipeline.push({ $skip: controls.$skip });
  }
  if (controls.$limit) {
    pipeline.push({ $limit: controls.$limit });
  } else {
    pipeline.push({ $limit: 1000 });
  }
  if (controls.$select) {
    pipeline.push({ $project: controls.$select.asProjection });
  }

  host._log(`aggregate (${label})`, pipeline);
  return host.collection.aggregate(pipeline, host._getSessionOpts()).toArray();
}

/** Runs a search/vector pipeline with $facet for count. Shared by searchWithCount + vectorSearchWithCount. */
async function runSearchWithCountPipeline(
  host: TMongoSearchHost,
  stage: Document,
  query: DbQuery,
  label: string,
  threshold?: number,
): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
  const filter = buildMongoFilter(query.filter);
  const controls = query.controls || {};

  const preStages: Document[] = [];
  if (threshold !== undefined) {
    preStages.push({ $addFields: { _score: { $meta: "vectorSearchScore" } } });
    preStages.push({ $match: { _score: { $gte: threshold } } });
  }

  const dataStages: Document[] = [];
  if (controls.$sort) {
    dataStages.push({ $sort: controls.$sort });
  }
  if (controls.$skip) {
    dataStages.push({ $skip: controls.$skip });
  }
  if (controls.$limit) {
    dataStages.push({ $limit: controls.$limit });
  }
  if (controls.$select) {
    dataStages.push({ $project: controls.$select.asProjection });
  }

  const pipeline: Document[] = [
    stage,
    ...preStages,
    { $match: filter },
    {
      $facet: {
        data: dataStages,
        meta: [{ $count: "count" }],
      },
    },
  ];

  host._log(`aggregate (${label})`, pipeline);
  const result = await host.collection.aggregate(pipeline, host._getSessionOpts()).toArray();
  return {
    data: result[0]?.data || [],
    count: result[0]?.meta[0]?.count || 0,
  };
}
