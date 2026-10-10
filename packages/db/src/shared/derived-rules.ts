import type { TViewJsonType } from "../types";

/**
 * The rules the compiler plugin and the runtime share about entities and
 * `@db.column.derived` fields — one dependency-free list each, so a
 * compile-time diagnostic and its runtime mirror can never disagree.
 * @since 0.1.141
 */

/** The annotations that make a declaration a DB entity: a table, or a managed / external view. */
export const DB_ENTITY_ANNOTATIONS = ["db.table", "db.view", "db.view.for"] as const;

/** Primitive leaf types a JSON-stored path may end at (view JSON leaves, derived columns). */
export const JSON_LEAF_TYPES: ReadonlySet<string> = new Set<TViewJsonType>([
  "string",
  "number",
  "boolean",
]);

/** Whether `type` (a resolved design type) is one of {@link JSON_LEAF_TYPES}. */
export function isJsonLeafType(type: string): type is TViewJsonType {
  return JSON_LEAF_TYPES.has(type);
}

/** Annotations a `@db.column.derived` field cannot carry (D8), with the reason. */
export const DERIVED_INCOMPATIBLE: ReadonlyArray<[name: string, why: string]> = [
  ["meta.id", "a computed column cannot identify the row"],
  ["db.rel.FK", "a foreign key needs a stored, writable column"],
  ["db.default", "the value is computed, never defaulted"],
  ["db.default.increment", "the value is computed, never defaulted"],
  ["db.default.uuid", "the value is computed, never defaulted"],
  ["db.default.now", "the value is computed, never defaulted"],
  ["db.onUpdate.now", "a derived column is never written"],
  ["db.column.version", "the version column is adapter-managed"],
  ["db.column.version.exempt", "a derived column is never written"],
  ["db.encrypted", "the value is a cleartext extraction of its source"],
  ["db.json", "a derived column is a primitive leaf, not a JSON value"],
  ["db.ignore", "an ignored field has no column to derive"],
  ["db.writeOnly", "a derived column is never written"],
  ["db.index.fulltext", "fulltext indexes need a stored text column"],
  ["db.index.geo", "a geo index needs a db.geoPoint column"],
  ["db.search.vector", "a vector index needs a stored embedding column"],
  [
    "db.mongo.search.text",
    "Atlas Search indexes the stored document, which holds no derived field",
  ],
  [
    "db.mongo.search.autocomplete",
    "Atlas Search indexes the stored document, which holds no derived field",
  ],
];
