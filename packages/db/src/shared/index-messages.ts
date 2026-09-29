/**
 * Wording of the "index not found" errors — one source for the core, every
 * adapter and the HTTP layer, so a request naming a hidden index reads
 * exactly like one naming a nonexistent index.
 */

/**
 * `Search index "<name>" not found`, or — without a name — the "no default
 * text index" message.
 * @since 0.1.143
 */
export function searchIndexNotFoundMessage(indexName?: string): string {
  return indexName ? `Search index "${indexName}" not found` : "No search index available";
}

/**
 * `Vector index "<name>" not found`, or — without a name — the "no vector
 * index" message.
 * @since 0.1.143
 */
export function vectorIndexNotFoundMessage(indexName?: string): string {
  return indexName ? `Vector index "${indexName}" not found` : "No vector index available";
}

/**
 * `Geo index "<name>" not found on table "<table>"`, or — without a name —
 * the "table declares no geo index" message.
 * @since 0.1.143
 */
export function geoIndexNotFoundMessage(tableName: string, indexName?: string): string {
  return indexName === undefined
    ? `Table "${tableName}" declares no @db.index.geo — geoSearch requires a geo index`
    : `Geo index "${indexName}" not found on table "${tableName}"`;
}
