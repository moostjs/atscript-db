import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type {
  AggregateFn,
  AtscriptDbReadable,
  BucketUnit,
  TBucketSourceTable,
  TDbFieldMeta,
  TFilterPredicate,
  TQueryPathOp,
  TQueryPathSource,
} from "@atscript/db";
import {
  acceptedOperatorsHint,
  ADAPTER_FILTER_REASON,
  ALL_AGGREGATE_FNS,
  bucketSourceVerdict,
  canFilterLeaf,
  classifyQueryPath,
  ENCRYPTED_REASON,
  findAncestorInSet,
  groupSourceVerdict,
  isJsonValueField,
  narrowerFilterOps,
  selfOrAncestor,
  numericOperandProblem,
  resolveDesignType,
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
 * A calendar-bucket source (`bucketable`) is the core's `bucketSourceVerdict`
 * (the same function the core path guard runs) under the HTTP-only
 * `@db.writeOnly` veto.
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
   * A calendar bucket over this path passes the gate (¬writeOnly ∧ the core's
   * `bucketSourceVerdict`). Since 0.1.132.
   */
  bucketable: boolean;
  /**
   * `$groupBy` on this path passes the gate: physically filterable (adapter ∧
   * ¬writeOnly ∧ ¬encrypted) and, on a table declaring dimensions / measures,
   * a dimension. Since 0.1.148.
   */
  groupable: boolean;
  /** Present when `groupable` is `false` — the reason clause appended to the HTTP 400 message. */
  groupReason?: string;
  /** Present when `bucketable` is `false` — the reason clause appended to the HTTP 400 message. */
  bucketReason?: string;
  /**
   * The path may be an operand of query-time arithmetic: a numeric field
   * ({@link numericOperandProblem}) that aggregates (`$groupBy` / aggregate
   * capability, ¬writeOnly, visible). Only on an adapter with
   * `supportsAggregateExpressions()`. Since 0.1.148.
   */
  numeric: boolean;
}

/** One rejected path: `path` is the offending logical path, `message` the full sentence. */
export interface TCapabilityVerdict {
  path: string;
  message: string;
}

/**
 * The positions {@link FieldCapabilityIndex.check} judges: the core's path
 * positions plus the `$select` of an aggregate query (`groupedSelect`), where
 * a plain field must be a `$groupBy` key — a display-only decoration never is.
 */
export type TGateOp = TQueryPathOp | "groupedSelect";

/** The display-only refusal clause per position. */
const DISPLAY_ONLY_POSITION: Record<Exclude<TGateOp, "select">, string> = {
  filter: "a filter",
  sort: "$sort",
  groupedSelect: "a grouped $select",
  groupBy: "$groupBy",
  having: "$having",
  aggregate: "an aggregate",
  bucket: "a calendar bucket",
};

/** The capability of a declared decoration: selectable, nothing else. */
const DECORATION_CAP: Readonly<TFieldCapability> = {
  filterable: false,
  sortable: false,
  selectable: true,
  indexed: false,
  bucketable: false,
  groupable: false,
  numeric: false,
};

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
  | "aggregateFns"
  | "supportsAggregateExpressions"
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

const REASON_ADAPTER_FILTER = `${ADAPTER_FILTER_REASON}.`;
const REASON_ADAPTER_SORT = "adapter cannot sort on this storage type.";
const REASON_WRITE_ONLY = "field is @db.writeOnly.";
const REASON_ENCRYPTED = `${ENCRYPTED_REASON}.`;
const REASON_ANNOTATION_FILTER = "add @db.column.filterable to enable.";
const REASON_ANNOTATION_SORT = "add @db.column.sortable to enable.";
/** A stored leaf never takes `$some` / `$none` (the HTTP gate answers relation refs before reaching it). */
const REASON_NOT_RELATION = "$some / $none apply to navigation relations only.";
/** The predicate alternative named by a filter on a navigation path (since 0.1.147). */
const PREDICATE_HINT = "to filter by related rows (requires @db.rel.filterable)";

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

/**
 * The verdict of a filter / sort on a `@db.writeOnly` path — the same
 * sentence {@link FieldCapabilityIndex.check} answers for this table's own
 * fields; used for `$with` sub-queries on a joined table's.
 */
export function writeOnlyVerdict(path: string, op: "filter" | "sort"): TCapabilityVerdict {
  return {
    path,
    message: `${OP_SUBJECT[op]} field "${path}" is not permitted — ${REASON_WRITE_ONLY}`,
  };
}

/** The one "nonexistent path" verdict — hidden paths answer with it byte for byte. */
function unknownField(path: string): TCapabilityVerdict {
  return { path, message: `Unknown field "${path}"` };
}

/**
 * The rejection of a navigation path. A filter names the relational
 * predicate that expresses it (since 0.1.147) — `ticket=$some(status=…)` —
 * and, at the controller's own level (`inOperand` false), the `$with`
 * alternative; other positions keep the `$with` hint alone.
 */
function navMessage(
  path: string,
  op: TQueryPathOp,
  parent: string | undefined,
  local: string,
  inOperand: boolean,
): string {
  if (parent === undefined) {
    if (op !== "filter") return `"${path}" is a navigation property — use $with=${path} to load it`;
    const predicate = `use ${local}=$some(…) ${PREDICATE_HINT}`;
    return inOperand
      ? `"${path}" is a navigation property — ${predicate}`
      : `"${path}" is a navigation property — ${predicate}, or $with=${path} to load it`;
  }
  const tail = local.slice(parent.length + 1);
  const withHint =
    `$with=${parent}(...) to filter or select fields of the related rows ` +
    `(e.g. $with=${parent}($select=${tail}))`;
  if (op !== "filter") return `"${path}" is a navigation path — use ${withHint}`;
  const predicate = `use ${parent}=$some(${tail}=…) ${PREDICATE_HINT}`;
  return inOperand
    ? `"${path}" is a navigation path — ${predicate}`
    : `"${path}" is a navigation path — ${predicate}, or ${withHint}`;
}

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
  /** Aggregate functions the adapter renders, in canonical `ALL_AGGREGATE_FNS` order (`/meta.aggregateFns`). */
  readonly aggregateFns: readonly AggregateFn[];
  /** Whether the adapter renders aggregate arithmetic (`/meta.aggregateExpressions`). */
  readonly aggregateExpressions: boolean;
  /** The adapter-level capabilities this index was built against — see {@link adapterSignature}. */
  readonly signature: string;

  /**
   * The adapter-level capabilities that can change after construction (geo
   * support, calendar-bucket units, aggregate functions): an index whose
   * {@link signature} differs from this is stale. Any new adapter-level input
   * the index reads must be added here.
   */
  static adapterSignature(
    source: Pick<
      TCapabilityReadable,
      "isGeoSearchable" | "calendarBucketUnits" | "aggregateFns" | "supportsAggregateExpressions"
    >,
  ): string {
    return `${source.isGeoSearchable()}|${[...source.calendarBucketUnits()].join(",")}|${[
      ...source.aggregateFns(),
    ].join(",")}|${source.supportsAggregateExpressions()}`;
  }

  /**
   * The navigation paths of a readable: its `navFields`, else its relation
   * names (partial readables list only the latter).
   */
  static navPathsOf(source: Pick<TCapabilityReadable, "navFields" | "relations">): Set<string> {
    const nav = new Set<string>(source.navFields);
    if (nav.size === 0) {
      for (const name of source.relations.keys()) nav.add(name);
    }
    return nav;
  }

  private readonly _entries = new Map<string, TEntry>();
  /**
   * Declared display-only decorations (`@DbDecorations`, since 0.1.148) —
   * virtual entries: key → the readable paths it `requires`. Selectable only;
   * visible while every required path is.
   */
  private readonly _decorations: ReadonlyMap<string, readonly string[]>;
  /** Nested-object parents (never listed, always selectable) → their listed leaves. */
  private readonly _objectParents = new Map<string, string[]>();
  /** What `bucketSourceVerdict` reads of the table (JSON-value parents, dimensions, measures). */
  private readonly _bucketTable: TBucketSourceTable;

  /** Listed leaves — the {@link TQueryPathSource} view for `classifyQueryPath`. */
  get leaves(): ReadonlyMap<string, unknown> {
    return this._entries;
  }

  /** Nested-object parents — the {@link TQueryPathSource} view for `classifyQueryPath`. */
  get objectParents(): ReadonlyMap<string, unknown> {
    return this._objectParents;
  }

  constructor(
    source: TCapabilityReadable,
    writeOnly: ReadonlySet<string>,
    decorations: ReadonlyMap<string, readonly string[]> = new Map(),
  ) {
    this._decorations = decorations;
    const tableMeta = source.type.metadata;
    this.filterableManual = tableMeta.get("db.table.filterable") === "manual";
    this.sortableManual = tableMeta.get("db.table.sortable") === "manual";
    this.writeOnly = writeOnly;
    this.signature = FieldCapabilityIndex.adapterSignature(source);
    const units = source.calendarBucketUnits();
    this.bucketUnits = BUCKET_UNITS.filter((unit) => units.has(unit));
    const fns = source.aggregateFns();
    this.aggregateFns = [...ALL_AGGREGATE_FNS].filter((fn) => fns.has(fn));
    this.aggregateExpressions = source.supportsAggregateExpressions();
    const physicalNames = new Set<string>();
    const jsonValueParents = new Set<string>();
    for (const fd of source.fieldDescriptors) {
      physicalNames.add(fd.physicalName);
      if (isJsonValueField(fd)) jsonValueParents.add(fd.path);
    }
    this.physicalNames = physicalNames;
    this._bucketTable = {
      jsonValueParents,
      dimensions: source.dimensions,
      measures: source.measures,
    };

    const nav = FieldCapabilityIndex.navPathsOf(source);
    this.navFields = nav;
    const isNavOrDescendant = (path: string) => selfOrAncestor(path, nav) !== undefined;

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
      // An object, a union of objects or `T | null` of one (since 0.1.155)
      if (!entry?.type || resolveDesignType(entry) !== "object") continue;
      const meta = (entry as { metadata?: { has?: (k: string) => boolean } }).metadata;
      if (meta?.has?.("db.json")) continue;
      if (isNavOrDescendant(path)) continue;
      if (ignored.has(path)) continue;
      if (findAncestorInSet(path, jsonParents) !== undefined) continue;
      if (selfOrAncestor(path, encrypted) !== undefined) continue;
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
      relation: REASON_NOT_RELATION,
    };
    // writeOnly / encrypted / policy veto every predicate alike, so narrower
    // predicates remain only when the adapter's storage veto alone blocks compare.
    const filterOps =
      filterBy.compare === REASON_ADAPTER_FILTER && !filterPolicyBlocked
        ? narrowerFilterOps(fd, source)
        : [];
    if (filterOps.length > 0) {
      filterBy.compare = `${ADAPTER_FILTER_REASON}${acceptedOperatorsHint(filterOps)}.`;
    }
    const physicalReason = verdict("compare", false);

    let sortReason = source.canSortField(fd) ? undefined : REASON_ADAPTER_SORT;
    if (fd.encrypted) sortReason = REASON_ENCRYPTED;
    // A sort order would leak the sealed value.
    if (isWriteOnly) sortReason = REASON_WRITE_ONLY;
    if (!sortReason && this.sortableManual && !annotated(fd, "db.column.sortable")) {
      sortReason = REASON_ANNOTATION_SORT;
    }
    // Bucket source: the HTTP-only writeOnly veto (a bucket label would leak
    // the sealed value), then the core's verdict — the same rules, order and
    // reason the core path guard answers with.
    const bucket = isWriteOnly ? undefined : bucketSourceVerdict(fd, this._bucketTable, source);
    const bucketReason = !bucket ? REASON_WRITE_ONLY : bucket.ok ? undefined : `${bucket.reason}.`;

    // `$groupBy`: the HTTP-only writeOnly veto, then the core's verdict (physical
    // rule, then the strict-table dimension rule).
    const group = isWriteOnly ? undefined : groupSourceVerdict(fd, this._bucketTable, source);
    const groupReason = !group ? REASON_WRITE_ONLY : group.ok ? undefined : `${group.reason}.`;
    const cap: TFieldCapability = {
      filterable: filterBy.compare === undefined,
      sortable: sortReason === undefined,
      selectable: true,
      indexed: fd.isIndexed === true,
      bucketable: bucketReason === undefined,
      groupable: groupReason === undefined,
      numeric:
        this.aggregateExpressions &&
        physicalReason === undefined &&
        numericOperandProblem(fd) === undefined,
    };
    if (groupReason) cap.groupReason = groupReason;
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

  /** The declared decoration keys, in declaration order. */
  get decorationKeys(): IterableIterator<string> {
    return this._decorations.keys();
  }

  /** The capability of the declared decoration `key` (selectable only), `undefined` when `key` is none. */
  decorationCap(key: string): Readonly<TFieldCapability> | undefined {
    return this._decorations.has(key) ? DECORATION_CAP : undefined;
  }

  /** The decoration `key` is visible: every path it `requires` passes `exists` (the hidden-field hook). */
  decorationVisible(key: string, exists: (path: string) => boolean): boolean {
    return this._decorations.get(key)?.every(exists) === true;
  }

  /** Physical filter capability (adapter ∧ ¬writeOnly ∧ ¬encrypted) — ignores the manual-mode policy. */
  isPhysicallyFilterable(path: string): boolean {
    return this._entries.get(path)?.physicalFilterable === true;
  }

  /**
   * Gate check for one path in one position. Returns `undefined` when the
   * path is accepted.
   *
   * `exists` runs FIRST, for every path (since 0.1.133): it is the
   * controller's `hasField`, the visibility hook subclasses narrow per
   * request (e.g. a projection-scoped viewer). A path it rejects answers
   * `Unknown field "x"` exactly like a nonexistent one — never a capability
   * or navigation hint, which would reveal the field and let a filter or
   * sort on it act as a value oracle. Before 0.1.133 listed leaves and
   * navigation paths skipped it.
   *
   * Then: navigation paths (a nav path exists on the target table but is
   * never a column here), a listed leaf's capability, and for other paths
   * the storage classification. Existence also runs BEFORE the JSON /
   * encrypted classification: an untyped descendant of a JSON column
   * (`address.nope`) is reported as `Unknown field`, not as "inside
   * JSON-stored column" — clients pin that wording, so do not "align" it
   * with the core backstop's text.
   *
   * A declared decoration (`@DbDecorations`) is a virtual entry: `select` while
   * every path it requires passes `exists`, any other position a display-only
   * refusal (`groupedSelect` is a `$select` of an aggregate query), and hidden
   * sources answer `Unknown field` like a nonexistent path.
   *
   * `predicate` is a filter entry's class (`collectQueryPaths` records it per
   * occurrence); it only matters for `op === "filter"` on a listed leaf.
   *
   * `nullTest` (since 0.1.155): the filter entry only tests presence
   * (`TFilterRef.nullTest`) — accepted on a nested-object parent whose leaves
   * are all visible.
   *
   * `prefix` (since 0.1.147) is this index's readable's dotted path from the
   * controller when it judges a relational predicate's operand (`"ticket."`):
   * `exists` still receives the LOCAL path, the verdict's `path` and message
   * name the prefixed one. A filter on a navigation path names the predicate
   * alternative (`ticket=$some(status=…)`).
   */
  check(
    local: string,
    gateOp: TGateOp,
    exists: (path: string) => boolean,
    predicate: TFilterPredicate = "compare",
    prefix = "",
    nullTest = false,
  ): TCapabilityVerdict | undefined {
    // Messages name the prefixed path; `exists` / classification use the local one.
    const path = prefix + local;
    // A declared decoration (this controller's own level only): selectable while
    // its sources are visible — anywhere else display-only; hidden sources answer
    // like any unknown field.
    const requires = prefix === "" ? this._decorations.get(local) : undefined;
    if (requires) {
      if (!requires.every(exists)) return unknownField(path);
      if (gateOp === "select") return undefined;
      return {
        path,
        message: `Field "${path}" is display-only and cannot be used in ${DISPLAY_ONLY_POSITION[gateOp]}`,
      };
    }
    // Past the decoration rule `groupedSelect` is a plain `$select`.
    const op: TQueryPathOp = gateOp === "groupedSelect" ? "select" : gateOp;
    if (!exists(local)) {
      return unknownField(path);
    }
    const { kind, parent: localParent } = classifyQueryPath(this, local);
    const parent = localParent === undefined ? undefined : prefix + localParent;
    if (kind === "nav") {
      return { path, message: navMessage(path, op, localParent, local, prefix !== "") };
    }
    if (kind === "leaf") {
      const entry = this._entries.get(local)!;
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
        case "groupBy":
          return entry.cap.groupable
            ? undefined
            : {
                path,
                message: `${OP_SUBJECT[op]} field "${path}" is not permitted — ${entry.cap.groupReason}`,
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
    switch (kind) {
      case "objectParent": {
        if (op === "select") return undefined;
        // The hint names visible leaves only — a hidden sibling must not leak
        // through it (since 0.1.134). A parent whose every leaf is hidden
        // answers like a nonexistent path.
        const all = this._objectParents.get(local)!;
        const leaves = all.filter(exists).map((leaf) => prefix + leaf);
        if (leaves.length === 0 && all.length > 0) {
          return unknownField(path);
        }
        // A null test (`obj=null`, `obj!=null`, `$exists`) is `$exists` on
        // every leaf (since 0.1.155) — accepted only while each leaf is visible
        // and takes `$exists` itself (not writeOnly, encrypted or policy-blocked).
        if (
          op === "filter" &&
          nullTest &&
          all.length > 0 &&
          all.every(
            (leaf) => exists(leaf) && this._entries.get(leaf)?.filterBy.exists === undefined,
          ) &&
          findAncestorInSet(local, this._bucketTable.jsonValueParents) === undefined
        ) {
          return undefined;
        }
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
        return unknownField(path);
    }
  }
}
