import { resolveBuckets, type ResolvedBucket } from "@uniqu/core";

import { DbError } from "../db-error";
import type { TDbFieldMeta } from "../types";

/**
 * A calendar bucket as adapters receive it (`controls.$select.buckets`): the
 * normalized uniqu bucket (canonical zone, week start, alias) whose `field` is
 * the PHYSICAL column / document path, plus the source field's descriptor —
 * dialects read the storage kind from `fd` (since 0.1.132).
 */
export type TResolvedBucket = ResolvedBucket & {
  /** Physical column (relational) or document path (nested-object adapters). */
  field: string;
  /** Descriptor of the source field (a `number.timestamp` leaf). */
  fd: TDbFieldMeta;
};

/**
 * The names a bucket alias must not shadow: `TableMetadata` provides them, and
 * moost-db's HTTP gate assembles the same set from its readable and capability
 * index, so both layers resolve against the same names.
 */
export interface TBucketFieldSource {
  /** Every logical path of the table type (nested parents and navigation fields included). */
  flatMap: ReadonlyMap<string, unknown>;
  /** Every field descriptor's `physicalName` — reserved too. */
  physicalNames: ReadonlySet<string>;
  navFields: ReadonlySet<string>;
}

/**
 * The one normalizer of `$select` computed entries (since 0.1.132) — uniqu's
 * `resolveBuckets` (entry shapes, unit, time zone canonicalization, week
 * start, alias syntax and uniqueness, "grouped queries only", "must also
 * appear in $groupBy", string `$groupBy` entries) with the table's names as
 * the collision set: a bucket alias may not equal a logical path, a physical
 * column or a navigation field, so a label is never reverse-mapped as a
 * column.
 *
 * Which layer validates what:
 * - **Shapes** (this normalizer) run FIRST at every entry point — the core's
 *   read path (`guardQuery`), its aggregate path (`AtscriptDbReadable.aggregate`,
 *   which hands the result on to `guardAggregate` and the field mapper), and
 *   moost-db's HTTP gate — so both layers answer with the same wording.
 *   Everything downstream (`collectQueryPaths`, the field mappers,
 *   `UniquSelect`, adapters) assumes normalized input and does not re-check.
 * - **Schema** (timestamp-typed source, JSON ancestor, encryption, physical
 *   filterability) is the path guard's (`guardPath` op `bucket`), mirrored by
 *   moost-db's capability index; dimensions are the aggregate rules'.
 * - **Adapter capability** (`calendarBucketUnits()`) is `guardAggregate`'s
 *   (`BUCKET_NOT_SUPPORTED`); SQL builders only re-assert the inlined
 *   literals (defense in depth).
 *
 * `aggregate` defaults to "`$groupBy` is non-empty".
 *
 * @throws DbError `INVALID_QUERY` carrying every issue (`path` `$select` / `$groupBy`).
 */
export function resolveCalendarBuckets(
  controls: { $select?: unknown; $groupBy?: unknown } | undefined,
  fields: TBucketFieldSource,
  aggregate?: boolean,
): ResolvedBucket[] {
  const res = resolveBuckets(controls, {
    aggregate,
    isField: (name) =>
      fields.flatMap.has(name) || fields.navFields.has(name) || fields.physicalNames.has(name),
  });
  if (!res.ok) {
    throw new DbError("INVALID_QUERY", res.issues);
  }
  return res.buckets;
}

/**
 * Whether a field can be the source of a calendar bucket: a `number` /
 * `integer` leaf carrying the `timestamp` tag (`number.timestamp`,
 * `.created`, `.updated`) that is not `@db.encrypted`. The type is the
 * declaration — no annotation opts a field in. Physical filterability is the
 * caller's (the core path guard and moost-db's capability index both add it).
 */
export function isBucketableField(fd: TDbFieldMeta): boolean {
  if (fd.encrypted) return false;
  if (fd.designType !== "number" && fd.designType !== "integer") return false;
  const tags = (fd.type?.type as { tags?: ReadonlySet<string> } | undefined)?.tags;
  return tags?.has("timestamp") === true;
}

/**
 * Whether a field holds a JSON value — a `@db.json` object / JSON-stored
 * column or an array. The members of `TableMetadata.jsonValueParents` (and
 * moost-db's equivalent set) — see {@link jsonValueAncestor}.
 */
export function isJsonValueField(fd: TDbFieldMeta): boolean {
  return fd.storage === "json" || fd.designType === "json" || fd.designType === "array";
}

/**
 * The outermost ancestor of `path` in `jsonValueParents` (the paths of the
 * {@link isJsonValueField} descriptors), or `undefined`. A timestamp inside a
 * JSON value is never a bucket source — relational adapters cannot address
 * it and nested-object adapters (which can) must not diverge from them.
 */
export function jsonValueAncestor(
  path: string,
  jsonValueParents: ReadonlySet<string>,
): string | undefined {
  if (jsonValueParents.size === 0) return undefined;
  let pos = path.indexOf(".");
  while (pos !== -1) {
    const ancestor = path.slice(0, pos);
    if (jsonValueParents.has(ancestor)) return ancestor;
    pos = path.indexOf(".", pos + 1);
  }
  return undefined;
}
