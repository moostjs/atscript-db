import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type {
  AtscriptDbReadable,
  BucketUnit,
  TDbFieldMeta,
  TFilterPredicate,
  TQueryPathOp,
  TQueryPathSource,
} from "@atscript/db";
import {
  acceptedOperatorsHint,
  canFilterLeaf,
  classifyQueryPath,
  findAncestorInSet,
  isBucketableField,
  isJsonValueField,
  jsonValueAncestor,
  narrowerFilterOps,
} from "@atscript/db";
import { BUCKET_UNITS } from "@uniqu/core";

/**
 * Per-path HTTP capability of a DB readable — the single source that both the
 * `/meta.fields` projection and the request gate are computed from, so the
 * two can never disagree (since 0.1.128).
 *
 * Physical capability (adapter `canFilterField` / `canSortField`, storage,
 * `@db.encrypted`) is combined with HTTP policy (`@db.writeOnly`,
 * `@db.table.filterable / sortable 'manual'` + `@db.column.*`). Policy applies
 * to filters and `$sort` only; `$groupBy`, `$having` keys and aggregate
 * `$field`s use the physical capability alone.
 *
 * A filter entry is judged by its predicate class (the core's `canFilterLeaf`):
 * `filterable` is the value-comparison verdict, `filterOps` the narrower
 * predicates that still pass where it is `false`.
 *
 * A calendar-bucket source (`bucketable`) needs the physical capability, a
 * `number.timestamp` type, dimension status on a strict (dimension / measure
 * declaring) table, and an adapter with calendar-bucket units.
 */
export interface TFieldCapability {
  /** A value-comparison filter on this path passes the gate (adapter ∧ ¬writeOnly ∧ ¬encrypted ∧ policy). */
  filterable: boolean;
  /** Present when `filterable` is `false` yet narrower predicates (`$exists`, `$geoWithin`) pass the gate. */
  filterOps?: string[];
  /** A `$sort` on this path passes the gate (adapter ∧ ¬writeOnly ∧ ¬encrypted ∧ policy). */
  sortable: boolean;
  /** The path may appear in `$select`. `@db.writeOnly` fields are selectable — the seal strips them after the gate. */
  selectable: boolean;
  /** Advisory: index-backed (explicit `@db.index*`, primary key, unique). Never affects acceptance. */
  indexed: boolean;
  /** Present when `filterable` is `false` — the reason clause appended to the HTTP 400 message. */
  filterReason?: string;
  /** Present when `sortable` is `false` — the reason clause appended to the HTTP 400 message. */
  sortReason?: string;
  /**
   * A calendar bucket over this path passes the gate (physical ∧ timestamp ∧
   * (¬strict ∨ dimension) ∧ adapter has calendar buckets). Since 0.1.132.
   */
  bucketable: boolean;
  /** Present when `bucketable` is `false` — the reason clause appended to the HTTP 400 message. */
  bucketReason?: string;
}

/** One rejected path: `path` is the offending logical path, `message` the full sentence. */
export interface TCapabilityVerdict {
  path: string;
  message: string;
}

/** The readable members the index reads. */
export type TCapabilityReadable = Pick<
  AtscriptDbReadable,
  | "type"
  | "fieldDescriptors"
  | "flatMap"
  | "navFields"
  | "relations"
  | "ignoredFields"
  | "canFilterField"
  | "canSortField"
  | "isGeoSearchable"
  | "calendarBucketUnits"
  | "dimensions"
  | "measures"
>;

interface TEntry {
  fd: TDbFieldMeta;
  cap: TFieldCapability;
  /** Filter verdict per predicate class: `undefined` = accepted, else the reason clause. */
  filterBy: Record<TFilterPredicate, string | undefined>;
  /** adapter ∧ ¬writeOnly ∧ ¬encrypted — policy-free; what `$groupBy` / `$having` / aggregate `$field` need. */
  physicalFilterable: boolean;
  physicalReason?: string;
}

const ADAPTER_FILTER = "adapter cannot filter on this storage type";
const REASON_ADAPTER_FILTER = `${ADAPTER_FILTER}.`;
const REASON_ADAPTER_SORT = "adapter cannot sort on this storage type.";
const REASON_WRITE_ONLY = "field is @db.writeOnly.";
const REASON_ENCRYPTED = "field is @db.encrypted (ciphertext cannot be compared or ordered).";
const REASON_ANNOTATION_FILTER = "add @db.column.filterable to enable.";
const REASON_ANNOTATION_SORT = "add @db.column.sortable to enable.";
const REASON_NOT_TIMESTAMP = "not a timestamp field (declare it number.timestamp).";
const REASON_NOT_DIMENSION = "not a dimension.";
const REASON_NO_BUCKETS = "adapter has no calendar buckets.";

/** Sentence subject per op ("Filtering on field …"). */
const OP_SUBJECT: Record<TQueryPathOp, string> = {
  filter: "Filtering on",
  sort: "Sorting on",
  select: "Selecting",
  groupBy: "Grouping by",
  having: "Filtering ($having) on",
  aggregate: "Aggregating over",
  bucket: "Bucketing",
};

/** Lower-case verb per op ("… cannot filter JSON paths"). */
const OP_VERB: Record<TQueryPathOp, string> = {
  filter: "filter",
  sort: "sort by",
  select: "select",
  groupBy: "group by",
  having: "filter ($having) on",
  aggregate: "aggregate over",
  bucket: "bucket",
};

function leafHint(leaves: readonly string[]): string {
  if (leaves.length === 0) return "no leaf fields";
  const shown = leaves.slice(0, 5).join(", ");
  return leaves.length > 5 ? `${shown}, …` : shown;
}

/**
 * Capability index of one readable.
 *
 * - {@link entries} feeds `/meta.fields` (listed leaves in descriptor order);
 * - {@link check} is the request gate: same inputs, same answer.
 *
 * Built from the adapter's capabilities as they are NOW. Some are only known
 * after schema sync (PostgreSQL learns PostGIS there), so owners rebuild the
 * index when {@link adapterSignature} changes (see `AsDbReadableController`'s
 * `capabilities` getter) instead of keeping a constructor-time snapshot.
 *
 * Paths outside the index are classified by the core's `classifyQueryPath`
 * (the same rules the core backstop applies) — navigation path, nested-object
 * parent, JSON descendant (relational adapters), encrypted descendant,
 * unknown — so the 400 names the storage reason and the alternative.
 */
export class FieldCapabilityIndex implements TQueryPathSource {
  readonly filterableManual: boolean;
  readonly sortableManual: boolean;
  /** Navigation relations (`@db.rel.to/from/via`), incl. nested ones. */
  readonly navFields: ReadonlySet<string>;
  /** `@db.writeOnly` paths. */
  readonly writeOnly: ReadonlySet<string>;
  /** Descriptors stored as one JSON column (relational adapters). */
  readonly jsonParents: ReadonlySet<string>;
  /** Descriptors carrying `@db.encrypted` (the ciphertext column on relational adapters). */
  readonly encryptedFields: ReadonlySet<string>;
  /** Every field descriptor's `physicalName` — names a calendar-bucket alias may not take. */
  readonly physicalNames: ReadonlySet<string>;
  /** Calendar-bucket units the adapter groups by, in `BUCKET_UNITS` order (`/meta.bucketUnits`). */
  readonly bucketUnits: readonly BucketUnit[];
  /** The adapter-level capabilities this index was built against — see {@link adapterSignature}. */
  readonly signature: string;

  /**
   * The adapter-level capabilities that can change after construction (geo
   * support, calendar-bucket units): an index whose {@link signature}
   * differs from this is stale. Any new adapter-level input the index reads
   * must be added here.
   */
  static adapterSignature(
    source: Pick<TCapabilityReadable, "isGeoSearchable" | "calendarBucketUnits">,
  ): string {
    return `${source.isGeoSearchable()}|${[...source.calendarBucketUnits()].join(",")}`;
  }

  private readonly _entries = new Map<string, TEntry>();
  /** Nested-object parents (never listed, always selectable) → their listed leaves. */
  private readonly _objectParents = new Map<string, string[]>();
  /**
   * Declared dimensions when the table is strict (declares dimensions or
   * measures), else `undefined` — the core rule: a grouping source, a
   * bucketed field included, must then be a dimension.
   */
  private readonly _dimensions: ReadonlySet<string> | undefined;
  /** Paths of every JSON-value descriptor (`isJsonValueField`) — see `jsonValueAncestor`. */
  private readonly _jsonValueParents: ReadonlySet<string>;

  /** Listed leaves — the {@link TQueryPathSource} view for `classifyQueryPath`. */
  get leaves(): ReadonlyMap<string, unknown> {
    return this._entries;
  }

  /** Nested-object parents — the {@link TQueryPathSource} view for `classifyQueryPath`. */
  get objectParents(): ReadonlyMap<string, unknown> {
    return this._objectParents;
  }

  constructor(source: TCapabilityReadable, writeOnly: ReadonlySet<string>) {
    const tableMeta = source.type.metadata;
    this.filterableManual = tableMeta.get("db.table.filterable") === "manual";
    this.sortableManual = tableMeta.get("db.table.sortable") === "manual";
    this.writeOnly = writeOnly;
    this.signature = FieldCapabilityIndex.adapterSignature(source);
    const units = source.calendarBucketUnits();
    this.bucketUnits = BUCKET_UNITS.filter((unit) => units.has(unit));
    this._dimensions =
      source.dimensions.length > 0 || source.measures.length > 0
        ? new Set(source.dimensions)
        : undefined;
    const physicalNames = new Set<string>();
    const jsonValueParents = new Set<string>();
    for (const fd of source.fieldDescriptors) {
      physicalNames.add(fd.physicalName);
      if (isJsonValueField(fd)) jsonValueParents.add(fd.path);
    }
    this.physicalNames = physicalNames;
    this._jsonValueParents = jsonValueParents;

    const nav = new Set<string>(source.navFields);
    if (nav.size === 0) {
      for (const name of source.relations.keys()) nav.add(name);
    }
    this.navFields = nav;
    const isNavOrDescendant = (path: string) =>
      nav.has(path) || findAncestorInSet(path, nav) !== undefined;

    const flatMap = source.flatMap;
    const annotated = (fd: TDbFieldMeta, key: string): boolean => {
      const entry = flatMap.get(fd.path) as
        | { metadata?: { has?: (k: string) => boolean } }
        | undefined;
      const fromFlat = entry?.metadata?.has?.(key);
      if (fromFlat !== undefined) return fromFlat;
      return fd.type?.metadata?.has?.(key) ?? false;
    };

    const jsonParents = new Set<string>();
    const encrypted = new Set<string>();
    for (const fd of source.fieldDescriptors) {
      if (fd.ignored) continue;
      if (isNavOrDescendant(fd.path)) continue;
      if (fd.storage === "json") jsonParents.add(fd.path);
      if (fd.encrypted) encrypted.add(fd.path);
      if (fd.designType === "object") {
        // Non-JSON nested-object parent (nested-object adapters keep them as
        // descriptors): selectable, never filter/sort-able, kept out of /meta —
        // Mongo `$project` rejects parent+leaf pairs (code 31249) and parents
        // render as `[object Object]`.
        this._objectParents.set(fd.path, []);
        continue;
      }
      this._entries.set(fd.path, this._buildEntry(fd, source, annotated));
    }

    // Relational adapters flatten object parents away — they are not
    // descriptors, but `$select=parent` expands to the leaf columns. Derive
    // them from the type's flat map (skipping anything that is not a plain
    // stored object: JSON subtrees, encrypted subtrees, nav trees, ignored).
    const ignored = source.ignoredFields;
    for (const [path, entry] of flatMap as Map<string, TAtscriptAnnotatedType>) {
      if (!path || this._entries.has(path) || this._objectParents.has(path)) continue;
      const kind = (entry as { type?: { kind?: string } } | undefined)?.type?.kind;
      if (kind !== "object") continue;
      const meta = (entry as { metadata?: { has?: (k: string) => boolean } }).metadata;
      if (meta?.has?.("db.json")) continue;
      if (isNavOrDescendant(path)) continue;
      if (ignored.has(path)) continue;
      if (findAncestorInSet(path, jsonParents) !== undefined) continue;
      if (encrypted.has(path) || findAncestorInSet(path, encrypted) !== undefined) continue;
      this._objectParents.set(path, []);
    }
    for (const [parent, leaves] of this._objectParents) {
      const prefix = `${parent}.`;
      for (const path of this._entries.keys()) {
        if (path.startsWith(prefix)) leaves.push(path);
      }
    }
    this.jsonParents = jsonParents;
    this.encryptedFields = encrypted;
  }

  private _buildEntry(
    fd: TDbFieldMeta,
    source: TCapabilityReadable,
    annotated: (fd: TDbFieldMeta, key: string) => boolean,
  ): TEntry {
    const isWriteOnly = this.writeOnly.has(fd.path);
    const filterPolicyBlocked = this.filterableManual && !annotated(fd, "db.column.filterable");
    // The one filter verdict: writeOnly (any probe, existence included, would
    // leak the sealed value) → encrypted → the predicate's physical rule →
    // manual-mode policy (filters only; `$groupBy` / `$having` skip it).
    const verdict = (predicate: TFilterPredicate, policy: boolean): string | undefined => {
      if (isWriteOnly) return REASON_WRITE_ONLY;
      if (fd.encrypted) return REASON_ENCRYPTED;
      if (!canFilterLeaf(fd, predicate, source)) return REASON_ADAPTER_FILTER;
      if (policy && filterPolicyBlocked) return REASON_ANNOTATION_FILTER;
      return undefined;
    };
    const filterBy: Record<TFilterPredicate, string | undefined> = {
      compare: verdict("compare", true),
      exists: verdict("exists", true),
      geo: verdict("geo", true),
    };
    // writeOnly / encrypted / policy veto every predicate alike, so narrower
    // predicates remain only when the adapter's storage veto alone blocks compare.
    const filterOps =
      filterBy.compare === REASON_ADAPTER_FILTER && !filterPolicyBlocked
        ? narrowerFilterOps(fd, source)
        : [];
    if (filterOps.length > 0) {
      filterBy.compare = `${ADAPTER_FILTER}${acceptedOperatorsHint(filterOps)}.`;
    }
    const physicalReason = verdict("compare", false);

    let sortReason = source.canSortField(fd) ? undefined : REASON_ADAPTER_SORT;
    if (fd.encrypted) sortReason = REASON_ENCRYPTED;
    // A sort order would leak the sealed value.
    if (isWriteOnly) sortReason = REASON_WRITE_ONLY;
    if (!sortReason && this.sortableManual && !annotated(fd, "db.column.sortable")) {
      sortReason = REASON_ANNOTATION_SORT;
    }
    // Bucket source: the physical capability `$groupBy` needs, then no JSON
    // ancestor (parity with relational adapters), the type, the strict-mode
    // dimension rule and the adapter's units.
    let bucketReason = physicalReason;
    const jsonAncestor = jsonValueAncestor(fd.path, this._jsonValueParents);
    if (!bucketReason && jsonAncestor !== undefined) {
      bucketReason = `inside JSON-stored column "${jsonAncestor}".`;
    }
    if (!bucketReason && !isBucketableField(fd)) bucketReason = REASON_NOT_TIMESTAMP;
    if (!bucketReason && this._dimensions && !this._dimensions.has(fd.path)) {
      bucketReason = REASON_NOT_DIMENSION;
    }
    if (!bucketReason && this.bucketUnits.length === 0) bucketReason = REASON_NO_BUCKETS;

    const cap: TFieldCapability = {
      filterable: filterBy.compare === undefined,
      sortable: sortReason === undefined,
      selectable: true,
      indexed: fd.isIndexed === true,
      bucketable: bucketReason === undefined,
    };
    if (filterOps.length > 0) cap.filterOps = filterOps;
    if (filterBy.compare) cap.filterReason = filterBy.compare;
    if (sortReason) cap.sortReason = sortReason;
    if (bucketReason) cap.bucketReason = bucketReason;
    return {
      fd,
      cap,
      filterBy,
      physicalFilterable: physicalReason === undefined,
      physicalReason,
    };
  }

  /** Listed leaves in descriptor order — the `/meta.fields` projection source. */
  *entries(): IterableIterator<[path: string, cap: TFieldCapability, fd: TDbFieldMeta]> {
    for (const [path, entry] of this._entries) {
      yield [path, entry.cap, entry.fd];
    }
  }

  /** Physical filter capability (adapter ∧ ¬writeOnly ∧ ¬encrypted) — ignores the manual-mode policy. */
  isPhysicallyFilterable(path: string): boolean {
    return this._entries.get(path)?.physicalFilterable === true;
  }

  /**
   * Gate check for one path in one position. Returns `undefined` when the
   * path is accepted. Order: navigation paths first (a nav path "exists" on
   * the target table but is never a column here), then a listed leaf's
   * capability (no existence lookup needed — every listed leaf is a real
   * field), then `exists` (the readable's `isValidFieldPath`) and, for paths
   * that exist but are not leaves, the storage classification.
   *
   * Existence deliberately runs BEFORE the JSON / encrypted classification:
   * an untyped descendant of a JSON column (`address.nope`) is reported as
   * `Unknown field`, not as "inside JSON-stored column" — clients pin that
   * wording, so do not "align" it with the core backstop's text.
   *
   * `predicate` is a filter entry's class (`collectQueryPaths` records it per
   * occurrence); it only matters for `op === "filter"` on a listed leaf.
   */
  check(
    path: string,
    op: TQueryPathOp,
    exists: (path: string) => boolean,
    predicate: TFilterPredicate = "compare",
  ): TCapabilityVerdict | undefined {
    const { kind, parent } = classifyQueryPath(this, path);
    if (kind === "nav") {
      if (parent === undefined) {
        return {
          path,
          message: `"${path}" is a navigation property — use $with=${path} to load it`,
        };
      }
      const tail = path.slice(parent.length + 1);
      return {
        path,
        message:
          `"${path}" is a navigation path — use $with=${parent}(...) to filter or select fields ` +
          `of the related rows (e.g. $with=${parent}($select=${tail}))`,
      };
    }
    if (kind === "leaf") {
      const entry = this._entries.get(path)!;
      switch (op) {
        case "select":
          return entry.cap.selectable
            ? undefined
            : { path, message: `Selecting field "${path}" is not permitted.` };
        case "filter": {
          const reason = entry.filterBy[predicate];
          return reason === undefined
            ? undefined
            : { path, message: `Filtering on field "${path}" is not permitted — ${reason}` };
        }
        case "sort":
          return entry.cap.sortable
            ? undefined
            : {
                path,
                message: `Sorting on field "${path}" is not permitted — ${entry.cap.sortReason}`,
              };
        case "bucket":
          return entry.cap.bucketable
            ? undefined
            : {
                path,
                message: `Bucketing field "${path}" is not permitted — ${entry.cap.bucketReason}`,
              };
        default:
          return entry.physicalFilterable
            ? undefined
            : {
                path,
                message: `${OP_SUBJECT[op]} field "${path}" is not permitted — ${entry.physicalReason}`,
              };
      }
    }
    if (!exists(path)) {
      return { path, message: `Unknown field "${path}"` };
    }
    switch (kind) {
      case "objectParent": {
        if (op === "select") return undefined;
        const leaves = this._objectParents.get(path)!;
        return {
          path,
          message: `"${path}" is a nested object — filter or sort on one of its leaves (${leafHint(leaves)})`,
        };
      }
      case "jsonDescendant":
        return {
          path,
          message:
            `"${path}" is inside JSON-stored column "${parent}" — this adapter cannot ${OP_VERB[op]} ` +
            `JSON paths; select "${parent}" and read the value client-side.`,
        };
      case "encryptedDescendant":
        return op === "select"
          ? {
              path,
              message: `"${path}" is inside encrypted field "${parent}" — select the encrypted parent "${parent}" instead.`,
            }
          : { path, message: `Cannot ${OP_VERB[op]} encrypted field "${path}"` };
      default:
        return { path, message: `Unknown field "${path}"` };
    }
  }
}
