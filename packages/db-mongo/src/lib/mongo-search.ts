import type { Collection, Document } from "mongodb";
import { DbError } from "@atscript/db";
import type { DbControls, DbQuery, TDbIndex, TSearchIndexInfo } from "@atscript/db";
import type { TMongoIndex, TSearchFieldMapping, TSearchIndex } from "./mongo-types";
import { buildMongoFilter } from "./mongo-filter";
import { dedupeProjection } from "./projection-dedupe";
import { wrapInvalidQuery } from "./mongo-errors";
import { joinPath } from "./path-utils";

// ── Host interface ───────────────────────────────────────────────────────────

export interface TMongoSearchHost {
  readonly collection: Collection<any>;
  getMongoSearchIndex(name?: string): TMongoIndex | undefined;
  getMongoSearchIndexes(): Map<string, TMongoIndex>;
  getVectorThreshold(indexKey?: string): number | undefined;
  _getSessionOpts(): Record<string, unknown>;
  _log(...args: unknown[]): void;
}

/** Host interface for geo search — needs the table's generic index map. */
export interface TMongoGeoHost {
  readonly collection: Collection<any>;
  readonly _table: { indexes: Map<string, TDbIndex>; tableName: string };
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
  const plan = buildSearchStage(host, text, indexName, query.controls);
  if (!plan) {
    throw new Error(
      indexName ? `Search index "${indexName}" not found` : "No search index available",
    );
  }
  return runSearchPipeline(host, plan.stage, query, "search", undefined, plan.classicText);
}

/** Text search with faceted count. */
export async function searchWithCountImpl(
  host: TMongoSearchHost,
  text: string,
  query: DbQuery,
  indexName?: string,
): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
  const plan = buildSearchStage(host, text, indexName, query.controls);
  if (!plan) {
    throw new Error(
      indexName ? `Search index "${indexName}" not found` : "No search index available",
    );
  }
  return runSearchWithCountPipeline(
    host,
    plan.stage,
    query,
    "searchWithCount",
    undefined,
    plan.classicText,
  );
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

// ── Geo search ($geoNear) ────────────────────────────────────────────────────

/**
 * Field name `$geoNear` writes the computed distance into. Renamed to the
 * public `$distance` pseudo-field after fetch — Mongo field paths cannot
 * start with `$`, so the public name can't be used as `distanceField`.
 */
const DISTANCE_FIELD = "__atscript_distance";

/** Distance-ranked geo search via a leading `$geoNear` aggregation stage. */
export async function geoSearchImpl(
  host: TMongoGeoHost,
  point: [number, number],
  query: DbQuery,
  indexName?: string,
): Promise<Array<Record<string, unknown>>> {
  const controls = (query.controls || {}) as Record<string, unknown>;
  // $geoNear MUST be the first pipeline stage (hard MongoDB requirement) —
  // it absorbs the filter via its `query` option.
  const pipeline: Document[] = [buildGeoNearStage(host, point, query, indexName)];
  if (controls.$skip) {
    pipeline.push({ $skip: controls.$skip });
  }
  pipeline.push({ $limit: (controls.$limit as number) || 1000 });
  pushGeoProjection(pipeline, query.controls);

  host._log("aggregate (geoSearch)", pipeline);
  const rows = await wrapInvalidQuery(() =>
    host.collection.aggregate(pipeline, host._getSessionOpts()).toArray(),
  );
  return rows.map((row) => renameDistance(row));
}

/** Geo search with faceted count (rows within the distance window). */
export async function geoSearchWithCountImpl(
  host: TMongoGeoHost,
  point: [number, number],
  query: DbQuery,
  indexName?: string,
): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
  const controls = (query.controls || {}) as Record<string, unknown>;
  const dataStages: Document[] = [];
  if (controls.$skip) {
    dataStages.push({ $skip: controls.$skip });
  }
  if (controls.$limit) {
    dataStages.push({ $limit: controls.$limit });
  }
  pushGeoProjection(dataStages, query.controls);

  const pipeline: Document[] = [
    buildGeoNearStage(host, point, query, indexName),
    { $facet: { data: dataStages, meta: [{ $count: "count" }] } },
  ];

  host._log("aggregate (geoSearchWithCount)", pipeline);
  const result = await wrapInvalidQuery(() =>
    host.collection.aggregate(pipeline, host._getSessionOpts()).toArray(),
  );
  return {
    data: ((result[0]?.data as Array<Record<string, unknown>>) || []).map((row) =>
      renameDistance(row),
    ),
    count: (result[0]?.meta?.[0]?.count as number) || 0,
  };
}

/** Builds the leading `$geoNear` stage; the filter rides in its `query` option. */
function buildGeoNearStage(
  host: TMongoGeoHost,
  point: [number, number],
  query: DbQuery,
  indexName?: string,
): Document {
  const controls = (query.controls || {}) as Record<string, unknown>;
  const geoNear: Document = {
    near: { type: "Point", coordinates: point },
    distanceField: DISTANCE_FIELD,
    spherical: true,
    // `key` pins the 2dsphere index — required when several geo indexes exist.
    key: resolveGeoKeyPath(host, indexName),
    query: buildMongoFilter(query.filter),
  };
  if (typeof controls.$maxDistance === "number") {
    geoNear.maxDistance = controls.$maxDistance;
  }
  if (typeof controls.$minDistance === "number") {
    geoNear.minDistance = controls.$minDistance;
  }
  return { $geoNear: geoNear };
}

/** Resolves the physical field path of the targeted geo index. */
function resolveGeoKeyPath(host: TMongoGeoHost, indexName?: string): string {
  const geoIndexes = [...host._table.indexes.values()].filter((index) => index.type === "geo");
  const index = indexName
    ? geoIndexes.find((candidate) => candidate.name === indexName)
    : geoIndexes[0];
  const field = index?.fields[0]?.name;
  if (!field) {
    // The core layer guards this before delegating; defensive for direct adapter use.
    throw new DbError("GEO_INDEX_MISSING", [
      {
        path: indexName ?? "",
        message: `No geo index${indexName ? ` "${indexName}"` : ""} on "${host._table.tableName}"`,
      },
    ]);
  }
  return field;
}

/** Appends a `$project` stage, keeping the computed distance in inclusion mode. */
function pushGeoProjection(stages: Document[], controls: DbControls | undefined): void {
  const projection = controls?.$select?.asProjection;
  if (!projection) {
    return;
  }
  const deduped = dedupeProjection(projection) as Record<string, 0 | 1>;
  const isInclusion = Object.values(deduped).some((v) => v === 1);
  if (isInclusion) {
    deduped[DISTANCE_FIELD] = 1;
  }
  stages.push({ $project: deduped });
}

/** Renames the internal distance field to the public `$distance` pseudo-field. */
function renameDistance(row: Record<string, unknown>): Record<string, unknown> {
  if (DISTANCE_FIELD in row) {
    row.$distance = row[DISTANCE_FIELD];
    delete row[DISTANCE_FIELD];
  }
  return row;
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

/**
 * Builds the first pipeline stage for a text search and reports whether it is a
 * classic `$text` query (vs. an Atlas `$search`).
 *
 * Two distinct execution paths share the `search()` API:
 *  - **Classic text** (`@db.index.fulltext`, or an adapter-scanned `text`
 *    index): served by the collection's MongoDB text index via `$match $text`.
 *    Works on community MongoDB and Atlas alike.
 *  - **Atlas Search** (`search_text` / `dynamic_text`): served by `mongot` via
 *    `$search`, which can ONLY resolve Atlas Search indexes.
 *
 * Routing a classic index through `$search` (as this used to) is guaranteed to
 * fail at runtime — `$search` can't see a classic text index, and on community
 * MongoDB the stage is unsupported entirely — even though the table reports
 * `searchable: true`. The discriminator is the resolved index's `type`.
 */
function buildSearchStage(
  host: TMongoSearchHost,
  text: string,
  indexName?: string,
  controls?: DbControls,
): { stage: Document; classicText: boolean } | undefined {
  const index = host.getMongoSearchIndex(indexName);
  if (!index) {
    return undefined;
  }
  if (index.type === "vector") {
    throw new Error("Vector indexes cannot be used with text search. Use vectorSearch() instead.");
  }
  if (index.type === "text") {
    // Classic text index — relevance via { $meta: 'textScore' }. `$text` must be
    // the first pipeline stage, which the runners guarantee.
    return { stage: { $match: { $text: { $search: text } } }, classicText: true };
  }
  // Atlas Search (search_text / dynamic_text). The index's declared `strategy`
  // locks the query shape — there is no query-time mode switching.
  const searchIndex = index as TSearchIndex;
  const fuzzy = resolveSearchFuzzy(searchIndex, controls);
  const strategy = searchIndex.strategy ?? "compound";
  const paths = collectSearchPathsCached(searchIndex);

  const fuzzyOpt = fuzzy ? { fuzzy } : {};
  // Shared operator payloads so the flat and `embeddedDocument`-wrapped variants
  // can't drift if the payload shape changes. `text` accepts a single path, an
  // array of paths, or a wildcard; `autocomplete` takes one path.
  const textOp = (path: string | string[] | { wildcard: string }): Document => ({
    text: { query: text, path, ...fuzzyOpt },
  });
  const autocompleteOp = (path: string): Document => ({
    autocomplete: { query: text, path, ...fuzzyOpt },
  });
  // Wildcard word match — reaches top-level and `document`-nested string fields,
  // but NOT `embeddedDocuments` (array-of-object) fields.
  const textClause = (): Document => textOp({ wildcard: "*" });
  // Array-of-object fields are only reachable through the `embeddedDocument`
  // operator. `wrapEmbedded` nests one operator per array level on the path
  // (outermost last, so `a` wraps `a.b`); the innermost operator uses the full
  // dotted path.
  const wrapEmbedded = (chain: string[], operator: Document): Document => {
    let wrapped = operator;
    for (let i = chain.length - 1; i >= 0; i--) {
      wrapped = { embeddedDocument: { path: chain[i], operator: wrapped } };
    }
    return wrapped;
  };
  const embeddedTextClause = (chain: string[], leaves: string[]): Document =>
    wrapEmbedded(chain, textOp(leaves.length === 1 ? leaves[0] : leaves));
  const embeddedAutocompleteClause = (chain: string[], leaf: string): Document =>
    wrapEmbedded(chain, autocompleteOp(leaf));

  const wantWord = strategy === "text" || strategy === "compound";
  const wantAutocomplete = strategy === "autocomplete" || strategy === "compound";

  const clauses: Document[] = [];
  if (wantWord) {
    clauses.push(textClause());
    for (const group of paths.arrayGroups) {
      if (group.textLeaves.length > 0) {
        clauses.push(embeddedTextClause(group.chain, group.textLeaves));
      }
    }
  }
  if (wantAutocomplete) {
    for (const path of paths.autocompleteOutside) {
      clauses.push(autocompleteOp(path));
    }
    for (const group of paths.arrayGroups) {
      for (const leaf of group.autocompleteLeaves) {
        clauses.push(embeddedAutocompleteClause(group.chain, leaf));
      }
    }
  }

  // Collapse a lone clause (e.g. a `text`-strategy index, or a `compound` index
  // that maps no autocomplete/array field) so it degrades to the prior shape.
  let body: Document;
  if (clauses.length <= 1) {
    body = clauses[0] ?? textClause();
  } else {
    body = { compound: { should: clauses, minimumShouldMatch: 1 } };
  }
  return { stage: { $search: { index: index.key, ...body } }, classicText: false };
}

/**
 * Resolves query-time fuzzy (typo tolerance): the `$fuzzy` request control
 * overrides the schema-declared `@db.mongo.search.*` fuzzy. Only an edit distance
 * of 1 or 2 is emitted (Atlas rejects 0) — anything else means "no fuzzy".
 */
function resolveSearchFuzzy(
  index: TSearchIndex,
  controls?: DbControls,
): { maxEdits: number } | undefined {
  const override = (controls as Record<string, unknown> | undefined)?.$fuzzy;
  const maxEdits = override === undefined ? index.fuzzy?.maxEdits : Number(override);
  return maxEdits === 1 || maxEdits === 2 ? { maxEdits } : undefined;
}

/**
 * Searchable leaves sharing one chain of `embeddedDocuments` array ancestors
 * (outermost → innermost). A leaf `a.b.c` where both `a` and `a.b` are arrays has
 * `chain: ["a", "a.b"]`; a leaf under a single array `x.y` has `chain: ["x"]`.
 * Each chain entry becomes one nested `embeddedDocument` wrapper at query time.
 */
interface TArrayLeafGroup {
  chain: string[];
  textLeaves: string[];
  autocompleteLeaves: string[];
}

interface TCollectedSearchPaths {
  /** Autocomplete leaf paths NOT inside any array (top-level or `document`-nested). */
  autocompleteOutside: string[];
  /** Searchable leaves under `embeddedDocuments` arrays, grouped by array chain. */
  arrayGroups: TArrayLeafGroup[];
}

/**
 * An index's mapping tree is immutable once schema sync builds it, and the index
 * object is cached for the adapter's lifetime — so the walk runs once per index,
 * not once per query (`buildSearchStage` is on the search hot path).
 */
const searchPathsCache = new WeakMap<TSearchIndex, TCollectedSearchPaths>();

function collectSearchPathsCached(index: TSearchIndex): TCollectedSearchPaths {
  let cached = searchPathsCache.get(index);
  if (!cached) {
    cached = collectSearchPaths(index.definition.mappings?.fields);
    searchPathsCache.set(index, cached);
  }
  return cached;
}

/**
 * Walks an index's nested mapping tree, classifying each searchable leaf by how
 * it must be queried: a plain dotted path (top-level / `document`-nested) vs.
 * scoped under an `embeddedDocuments` array root (queried via `embeddedDocument`).
 * Word-matching for non-array fields rides the wildcard `text` clause, so only
 * autocomplete leaves are tracked outside arrays.
 */
function collectSearchPaths(
  fields: Record<string, TSearchFieldMapping | TSearchFieldMapping[]> | undefined,
): TCollectedSearchPaths {
  const out: TCollectedSearchPaths = { autocompleteOutside: [], arrayGroups: [] };
  const byChain = new Map<string, TArrayLeafGroup>();
  const walk = (
    map: Record<string, TSearchFieldMapping | TSearchFieldMapping[]> | undefined,
    prefix: string,
    chain: string[],
  ): void => {
    if (!map) return;
    for (const [key, mapping] of Object.entries(map)) {
      const path = joinPath(prefix, key);
      const list = Array.isArray(mapping) ? mapping : [mapping];
      const embedded = list.find((m) => m.type === "embeddedDocuments");
      const document = list.find((m) => m.type === "document");
      if (embedded?.fields) {
        // Crossing an array boundary — append this array root so a deeper leaf
        // gets one `embeddedDocument` wrapper per array level on its path.
        walk(embedded.fields, path, [...chain, path]);
      } else if (document?.fields) {
        // Single object — same array scope, chain unchanged.
        walk(document.fields, path, chain);
      } else {
        const isAutocomplete = list.some((m) => m.type === "autocomplete");
        const isText = list.some((m) => m.type === "string");
        if (chain.length > 0) {
          const chainKey = chain.join(">");
          let group = byChain.get(chainKey);
          if (!group) {
            group = { chain, textLeaves: [], autocompleteLeaves: [] };
            byChain.set(chainKey, group);
            out.arrayGroups.push(group);
          }
          if (isText) group.textLeaves.push(path);
          if (isAutocomplete) group.autocompleteLeaves.push(path);
        } else if (isAutocomplete) {
          out.autocompleteOutside.push(path);
        }
      }
    }
  };
  walk(fields, "", []);
  return out;
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
  classicText = false,
): Promise<Array<Record<string, unknown>>> {
  const filter = buildMongoFilter(query.filter);
  const controls = query.controls || {};
  const pipeline: Document[] = [stage];
  if (threshold !== undefined) {
    pipeline.push({ $addFields: { _score: { $meta: "vectorSearchScore" } } });
    pipeline.push({ $match: { _score: { $gte: threshold } } });
  } else if (classicText) {
    pipeline.push({ $addFields: { _score: { $meta: "textScore" } } });
  }
  pipeline.push({ $match: filter });
  if (controls.$sort) {
    pipeline.push({ $sort: controls.$sort });
  } else if (classicText) {
    // Default to relevance order, mirroring Atlas $search's implicit ordering.
    pipeline.push({ $sort: { _score: -1 } });
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
    const projection = controls.$select.asProjection;
    if (projection) pipeline.push({ $project: dedupeProjection(projection) });
  }

  host._log(`aggregate (${label})`, pipeline);
  return wrapInvalidQuery(() =>
    host.collection.aggregate(pipeline, host._getSessionOpts()).toArray(),
  );
}

/** Runs a search/vector pipeline with $facet for count. Shared by searchWithCount + vectorSearchWithCount. */
async function runSearchWithCountPipeline(
  host: TMongoSearchHost,
  stage: Document,
  query: DbQuery,
  label: string,
  threshold?: number,
  classicText = false,
): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
  const filter = buildMongoFilter(query.filter);
  const controls = query.controls || {};

  const preStages: Document[] = [];
  if (threshold !== undefined) {
    preStages.push({ $addFields: { _score: { $meta: "vectorSearchScore" } } });
    preStages.push({ $match: { _score: { $gte: threshold } } });
  } else if (classicText) {
    // textScore meta is NOT accessible inside $facet sub-pipelines, so project
    // it into a field BEFORE the $facet stage.
    preStages.push({ $addFields: { _score: { $meta: "textScore" } } });
  }

  const dataStages: Document[] = [];
  if (controls.$sort) {
    dataStages.push({ $sort: controls.$sort });
  } else if (classicText) {
    dataStages.push({ $sort: { _score: -1 } });
  }
  if (controls.$skip) {
    dataStages.push({ $skip: controls.$skip });
  }
  if (controls.$limit) {
    dataStages.push({ $limit: controls.$limit });
  }
  if (controls.$select) {
    const projection = controls.$select.asProjection;
    if (projection) dataStages.push({ $project: dedupeProjection(projection) });
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
  const result = await wrapInvalidQuery(() =>
    host.collection.aggregate(pipeline, host._getSessionOpts()).toArray(),
  );
  return {
    data: result[0]?.data || [],
    count: result[0]?.meta[0]?.count || 0,
  };
}
