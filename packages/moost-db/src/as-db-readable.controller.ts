import { type TAtscriptAnnotatedType, type TAtscriptDataType } from "@atscript/typescript/utils";
import type {
  AtscriptDbReadable,
  FilterExpr,
  TCrudPermissions,
  TDbActionInfo,
  TDbActionTargetSummary,
  TDbAvailableActions,
  TFieldMeta,
  TIdResolveOptions,
  TMetaResponse,
  TQueryPathOp,
  UniqueryControls,
  Uniquery,
} from "@atscript/db";
import type { AtscriptDbTable } from "@atscript/db";
import {
  DbError,
  andFilters,
  checkHavingKeys,
  collectQueryPaths,
  geoIndexNotFoundMessage,
  normalizeComputedSelect,
  searchIndexNotFoundMessage,
  selfOrAncestor,
  unsupportedOperatorMessage,
  vectorIndexNotFoundMessage,
} from "@atscript/db";
import { Get, HttpError, MoostHttp, Query, Url } from "@moostjs/event-http";
import { current, useRouteParams } from "@wooksjs/event-core";
import { useBody } from "@wooksjs/http-body";
import { Inherit, Inject, Moost, Optional, Param, useControllerContext } from "moost";

import { registerAsDbReadableController } from "./actions/controller-registry";
import type { IdValidationSource } from "./actions/id-validation";
import { discoverRowLevelActions, type TDbActionEnvelope } from "./actions/discover";
import { augmentRowsWithActions, getCandidate } from "./actions/list-augmenter";
import {
  targetInvalid,
  ActionTargetError,
  errorMessage,
  errorStatus,
} from "./actions/action-target-error";
import {
  ACTION_VERDICTS,
  ALLOWED_ACTIONS,
  AVAILABLE_ACTIONS,
  discoverDelegations,
  hasActionDelegations,
  isAuthRefusal,
  mapToSourceIds,
  runAsController,
  runSourceActionBatch,
  type TDelegateSource,
  type TDelegation,
} from "./actions/delegation";
import { validateMultiId } from "./actions/id-validation";
import {
  parseQueryTargetBody,
  RESOLVE_TARGET,
  type TResolvedTarget,
  type TTargetRequest,
} from "./actions/query-target";
import {
  ACTION_OVERLAY,
  ACTION_SCOPE,
  ACTION_SCOPED,
  nonEmptyFilter,
  withOverlay,
} from "./actions/row-scope";
import {
  candidateIds,
  createScopeContext,
  filterKey,
  type TDbActionScopeContext,
  type TDbActionScopePurpose,
} from "./actions/scope-context";
import {
  actionRowFields,
  alignRowsToIds,
  findRowsByIds,
  idKey,
  projectRow,
  requiredFieldsOf,
  type TRowsByIdSource,
} from "./actions/rows-by-id";
import { judgeRows, verdictReason } from "./actions/verdict";
import { AsReadableController, type TDbControlsType } from "./as-readable.controller";
import { DbEndpoint } from "./db-endpoint";
import { READABLE_DEF, resolveBoundReadable } from "./decorators";
import { FieldCapabilityIndex, writeOnlyVerdict } from "./meta/field-capabilities";
import { insightError, unknownInsight, unknownRelationError } from "./http-errors";
import {
  RelationPredicateGate,
  childrenOf,
  readRequestContext,
  relTarget,
  hiddenRelationInsight,
  overlayRelationFilter,
  overlayWithFilters,
  snapshotClientWith,
  type TClientWithSnapshot,
} from "./relation-predicates";
import { badRequest } from "./validation-interceptor";

/** Gate positions checked after the filter entries, in order; `refs[op]` are their paths. */
const PATH_OPS: readonly Exclude<TQueryPathOp, "filter">[] = [
  "sort",
  "select",
  "groupBy",
  "having",
  "aggregate",
  "bucket",
];
import {
  GEO_CONTROLS,
  ONE_CONTROLS,
  PAGES_CONTROLS,
  QUERY_CONTROLS,
} from "./permissions/crud-controls";

/** Read endpoint a {@link AsDbReadableController.decorateRows} call serves. */
export type TDbDecorateEndpoint = "query" | "pages" | "geo" | "one";

/**
 * Context passed to {@link AsDbReadableController.decorateRows}.
 *
 * @since 0.1.136
 */
export interface TDbDecorateContext {
  /** Endpoint that produced the rows. `/one` and `/one/:id` both report `"one"`. */
  endpoint: TDbDecorateEndpoint;
  /**
   * The effective `$select` the endpoint read with — after
   * `transformProjection`, the `@db.writeOnly` seal and preferred-id
   * widening (`undefined` = no projection). Columns added only to feed an
   * action's `requiredFields` are stripped again before the hook runs.
   */
  projection: UniqueryControls["$select"] | undefined;
  /** The request's parsed controls (`$select`, `$with`, `$actions`, …). Read-only by convention. */
  controls: Record<string, unknown>;
}

/**
 * One text / vector / geo index of the bound readable with the LOGICAL field
 * paths it reads — see {@link AsDbReadableController.indexFieldPaths}.
 *
 * @since 0.1.143
 */
export interface TDbIndexFieldPaths {
  /** The name a request addresses the index by (`$index` for text and geo, `$vector` for vector). */
  name: string;
  type: "text" | "vector" | "geo";
  /**
   * Logical field paths the index reads. An index whose coverage cannot be
   * derived from the model (e.g. a dynamic document-search mapping) lists
   * every field — fail-closed for visibility gating.
   */
  fields: readonly string[];
  /** `true` for the index a request of this type uses when it names none. */
  isDefault: boolean;
}

/**
 * The field visibility of a DB readable controller — see
 * {@link AsDbReadableController.fieldVisibility}.
 *
 * @since 0.1.143
 */
export interface TDbFieldVisibility {
  /** `true` when `hasField` is overridden (visibility is request-scoped); else every real path is visible. */
  readonly scoped: boolean;
  /**
   * `hasField(path)` and — when {@link scoped} — a `@db.column.derived`
   * field of the bound readable only while its source path is visible too
   * (a derived copy must not outlive a hidden source), a computed view
   * column (`@db.compute`, since 0.1.147) only while every operand and every
   * intermediate computed field it reads through is.
   */
  readonly isVisible: (path: string) => boolean;
  /**
   * The paths sealed out of `readable`'s read projection for this request:
   * its `@db.writeOnly` fields plus, when {@link scoped}, its derived fields
   * whose source `hasField` hides and its computed fields with a hidden operand. `prefix` is `readable`'s path from the
   * controller: `""` for the bound readable, `"rel."` for a `$with` target.
   */
  readonly sealedFor: (readable: AtscriptDbReadable<any>, prefix?: string) => ReadonlySet<string>;
}

/** A parsed `$with` entry; `controls` may be absent (legacy flat shape: `$select` / `$sort` / `$with` on the entry). */
type TWithEntry = {
  name: string;
  filter?: FilterExpr;
  controls?: Record<string, unknown>;
} & Record<string, unknown>;

/** The 400 of a filter / sort on a `@db.writeOnly` field. */
function writeOnlyError(path: string, op: "filter" | "sort"): HttpError {
  const verdict = writeOnlyVerdict(path, op);
  return badRequest(verdict.path, verdict.message);
}

/** Read controls with every projection level sealed — see `_sealControls`. */
type TSealedControls = Record<string, unknown> & {
  $select: UniqueryControls["$select"] | undefined;
};

/**
 * Row-level actions sharing one {@link AsDbReadableController.actionRowScope}
 * filter (by object identity, else structurally — `filterKey`); `filter` =
 * that scope AND the row overlay (the gate's).
 */
interface TActionScopeGroup {
  filter: FilterExpr;
  actions: string[];
}

/** What `$actions` augmentation of a read needs, prepared before the read runs. */
interface TAugmentationPrep {
  envelopes: readonly TDbActionEnvelope[];
  resolvedProjection: string[] | null;
  widenedSelect: string[] | null;
  /**
   * The row overlay (resolving alongside the read) when `actionRowScope` is
   * overridden — its groups need the read's rows (since 0.1.147); `null` =
   * hook not overridden.
   */
  scopeOverlay: Promise<FilterExpr | undefined> | null;
  /** `@DbActionsFrom` delegations whose verdicts join `$actions` (since 0.1.147). */
  delegations: readonly TDelegation[];
}

/** Controller classes already warned that `actionRowScope` has no row identity to match by. */
const warnedNoIdentity = new WeakSet<Function>();

/**
 * Read-only database controller for Moost that works with any `AtscriptDbReadable`
 * (tables or views). Provides query, pages, getOne, and meta endpoints.
 *
 * For write operations (insert, replace, update, delete), use {@link AsDbController}.
 * Views bind to this same class — `@ViewController(view)` (an alias of
 * `@ReadableController`) or a constructor-passed view; there is no separate
 * view controller.
 */
@Inherit()
export class AsDbReadableController<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
> extends AsReadableController<T, DataType> {
  /** Reference to the underlying readable (table or view). */
  protected readable: AtscriptDbReadable<T>;

  /**
   * The bound readable as a writable table. The canonical readable-controller
   * posture is "generic reads + named `@DbAction` mutations" — action handlers
   * write through this instead of re-importing the DbSpace module for a
   * module-scope `getTable`. Throws when the controller is bound to a view
   * (or any non-table readable).
   */
  protected get table(): AtscriptDbTable<T> {
    // `readable` may be undefined here: moost's bind-time method scan probes
    // prototype accessors with the prototype as `this`. Only a REAL non-table
    // readable is a caller error. Duck-typed (write methods present) rather
    // than instanceof — consistent with the partial-mock tolerance elsewhere.
    const readable = this.readable as AtscriptDbReadable<T> | undefined;
    if (
      readable &&
      (readable.isView || typeof (readable as { insertOne?: unknown }).insertOne !== "function")
    ) {
      throw new Error(
        `${this.constructor.name} is bound to a ${readable.isView ? "view" : "non-table readable"} ` +
          `("${readable.tableName}") — .table is only available for table-bound controllers.`,
      );
    }
    return readable as AtscriptDbTable<T>;
  }

  /**
   * Per-path capability index (since 0.1.128): the ONE input both `/meta.fields`
   * and the request gate ({@link checkCapabilities}) are computed from, so
   * metadata and runtime can never diverge.
   *
   * Built on first use and rebuilt whenever the adapter-level capabilities
   * change (`FieldCapabilityIndex.adapterSignature`: geo support, calendar
   * buckets) — PostgreSQL learns PostGIS only during schema sync, which may
   * run after this controller is constructed, so a constructor-time snapshot
   * would keep advertising (and gating) the pre-sync answer (since 0.1.132).
   */
  protected get capabilities(): FieldCapabilityIndex {
    const current = this._capabilities;
    if (current && current.signature === FieldCapabilityIndex.adapterSignature(this.readable)) {
      return current;
    }
    const index = new FieldCapabilityIndex(this.readable, this._writeOnlySet);
    this._capabilities = index;
    return index;
  }
  private _capabilities?: FieldCapabilityIndex;
  /** The client relational-predicate gate (since 0.1.147), built on first use — see {@link _relationGate}. */
  private _relGate?: RelationPredicateGate;
  /**
   * The client's `$with` tree per request, keyed by its controls object —
   * recorded in {@link validateParsed} before {@link validateControls} (see
   * `snapshotClientWith`).
   */
  private readonly _clientWith = new WeakMap<object, TClientWithSnapshot | null>();

  /** `/meta` is a projection of {@link capabilities}: a rebuilt index rebuilds the cached envelope. */
  protected override metaCacheKey(): unknown {
    return this.capabilities;
  }
  /**
   * THE field-visibility answer (since 0.1.143) every read surface consults:
   * the capability gate, the index gate and `$search` fallback, id
   * resolution, the `@db.writeOnly` / derived seals of the projection and of
   * every `$with` level, `$actions` widening and action `requiredFields`
   * (the actions module reaches it duck-typed, like {@link idSource}).
   */
  protected readonly fieldVisibility: TDbFieldVisibility;
  /** A subclass overrides {@link hasField}: visibility is request-scoped (derived rule, index gate, id options). */
  private readonly _hasFieldOverridden: boolean;
  /**
   * `@db.column.derived` path → its source's logical path, `@db.compute` path
   * → its operands' paths plus the computed fields it reads through, per
   * readable (bound + `$with` targets).
   */
  private readonly _derivedSources = new WeakMap<object, ReadonlyMap<string, readonly string[]>>();
  /** The bound readable's entry of {@link _derivedSources}. */
  private readonly _derivedSource: ReadonlyMap<string, readonly string[]>;
  /** `@db.writeOnly` paths of `$with` target readables, collected once per target. */
  private readonly _targetWriteOnly = new WeakMap<object, ReadonlySet<string>>();
  private _indexFieldPathsCache?: readonly TDbIndexFieldPaths[];
  /** {@link _nativeSearch} per request, keyed by the request's parsed controls. */
  private readonly _nativeSearchByRequest = new WeakMap<object, boolean>();
  /**
   * Id-resolution options (since 0.1.134): `{ isFieldVisible }` (the
   * {@link fieldVisibility} check) when a subclass overrides {@link hasField},
   * else `undefined` (the default accepts every real path, so resolution
   * stays unfiltered). A unique index over a hidden field is never an
   * identification.
   */
  protected readonly _idOpts: TIdResolveOptions | undefined;
  /** Narrowed id sources, one stable object per distinct visible-identification set. */
  private readonly _idSources = new Map<string, IdValidationSource>();
  private readonly _preferredIdSet: ReadonlySet<string>;
  private readonly _overlayIsNoOp: boolean;
  /** `true` when a subclass implements {@link decorateRows} (the override switches the hook on). */
  private readonly _decorates: boolean;
  /** `true` when a subclass overrides {@link transformOne} or {@link transformFilter} (a row overlay may exist). */
  private readonly _hasRowOverlay: boolean;
  /** Per-envelope gate fields, memoized while field visibility is not request-scoped. */
  private readonly _gateFieldsMemo = new WeakMap<TDbActionEnvelope, ReadonlySet<string>>();
  /** `true` when a subclass overrides {@link allowedActions}. */
  private readonly _hasAllowedActions: boolean;
  /** `true` when a subclass overrides {@link actionRowScope} (the gate, `$actions` and `/meta/actions` apply it). */
  private readonly _hasActionRowScope: boolean;
  /** `true` when the class declares `@DbActionsFrom` (since 0.1.147). */
  private readonly _hasDelegations: boolean;
  /** `transformProjection` is overridden (a delegation's id paths are checked against it). */
  private readonly _hasProjectionHook: boolean;
  /** path → sibling-ref path for `@db.amount.currency.ref` / `@db.unit.ref`. */
  private readonly _quantityRefByPath: ReadonlyMap<string, string>;
  /** `@db.column.searchable` paths — the `$search` fallback when the adapter has no native search. */
  private readonly _searchFallbackFields: readonly string[];
  /** `@db.writeOnly` paths — settable in writes, sealed out of every read surface. */
  private readonly _writeOnlySet: ReadonlySet<string>;
  /**
   * Logical paths an exclusion `$select` inverts into: every listed leaf and
   * (on nested-object adapters) object parents — never navigation descendants,
   * which the core path guard rejects.
   */
  private readonly _invertibleFields: readonly string[];

  constructor(
    app: Moost,
    @Inject(READABLE_DEF)
    @Optional()
    readable?: AtscriptDbReadable<T>,
  ) {
    // Omitted readable = a subclass with its own constructor called
    // `super(app)` — resolve from the decorator's class metadata
    // (token / lazy-factory / instance binding). `new.target` is the
    // most-derived class and is legal before super().
    const resolved = readable ?? (resolveBoundReadable(new.target) as AtscriptDbReadable<T>);
    super(resolved.type as T, resolved.tableName, app, resolved.isView ? "view" : "table");
    this.readable = resolved;
    // Own fields only: a related table's `@db.writeOnly` paths (`rel.secret`)
    // are sealed per `$with` level — listing them here put navigation paths
    // into the root `$select` seal, which the core rejects (since 0.1.147).
    this._writeOnlySet = this._writeOnlyOf(resolved);
    this._derivedSource = this._derivedSourcesOf(resolved);
    this._invertibleFields = this._collectInvertibleFields();
    this._searchFallbackFields = this._collectSearchFallbackFields();
    this._preferredIdSet = new Set(resolved.preferredId ?? []);
    this._quantityRefByPath = this._collectQuantityRefs();
    const defaultOverlay = (
      AsReadableController.prototype as unknown as { applyMetaOverlay: unknown }
    ).applyMetaOverlay;
    this._overlayIsNoOp = (this.applyMetaOverlay as unknown) === defaultOverlay;
    this._decorates = typeof this.decorateRows === "function";
    const proto = AsDbReadableController.prototype;
    this._hasRowOverlay =
      this.transformOne !== proto.transformOne || this.transformFilter !== proto.transformFilter;
    this._hasActionRowScope = this.actionRowScope !== proto.actionRowScope;
    this._hasProjectionHook = this.transformProjection !== proto.transformProjection;
    this._hasAllowedActions = this.allowedActions !== proto.allowedActions;
    this._hasDelegations = hasActionDelegations(new.target);
    const scoped = this.hasField !== proto.hasField;
    this._hasFieldOverridden = scoped;
    const isVisible = (path: string): boolean => {
      if (!this.hasField(path)) return false;
      const sources = scoped ? this._derivedSource.get(path) : undefined;
      return sources === undefined || sources.every((source) => this.hasField(source));
    };
    this.fieldVisibility = {
      scoped,
      isVisible,
      sealedFor: (readable, prefix = "") => this._sealedFor(readable, prefix),
    };
    this._idOpts = scoped ? { isFieldVisible: isVisible } : undefined;
  }

  /**
   * The identifications this request may address rows through (since
   * 0.1.134): the readable's own, minus unique indexes over fields
   * {@link hasField} hides. Used by `/one?…`, `DELETE /?…` and action `ids`.
   * Stable per distinct outcome, so per-source caches keyed on it hit.
   */
  get idSource(): IdValidationSource {
    const opts = this._idOpts;
    if (!opts) return this.readable;
    const visible = this.readable.identificationsVisibleTo(opts.isFieldVisible);
    if (visible.length === this.readable.identifications.length) return this.readable;
    const key = visible.map((ident) => ident.source).join("\x1f");
    let source = this._idSources.get(key);
    if (!source) {
      source = { identifications: visible, fieldDescriptors: this.readable.fieldDescriptors };
      this._idSources.set(key, source);
    }
    return source;
  }

  private _collectInvertibleFields(): string[] {
    const out: string[] = [];
    const nav = this.capabilities.navFields;
    for (const fd of this.readable.fieldDescriptors) {
      if (fd.ignored) continue;
      if (selfOrAncestor(fd.path, nav) !== undefined) continue;
      out.push(fd.path);
    }
    return out;
  }

  private _collectQuantityRefs(): Map<string, string> {
    const out = new Map<string, string>();
    if (!this.readable.flatMap) return out;
    for (const [path, entry] of this.readable.flatMap) {
      const meta = entry?.metadata;
      const ref =
        (meta?.get("db.amount.currency.ref") as string | undefined) ??
        (meta?.get("db.unit.ref") as string | undefined);
      if (ref) out.set(path, ref);
    }
    return out;
  }

  /**
   * `readable`'s `@db.column.derived` path → source path and `@db.compute`
   * path → operand paths map, collected once per readable.
   */
  private _derivedSourcesOf(
    readable: AtscriptDbReadable<any>,
  ): ReadonlyMap<string, readonly string[]> {
    let map = this._derivedSources.get(readable);
    if (!map) {
      const out = new Map<string, readonly string[]>();
      for (const fd of readable.fieldDescriptors ?? []) {
        if (fd.derived?.sourcePath) out.set(fd.path, [fd.derived.sourcePath]);
        // a computed field also depends on the computed fields it reads through
        if (fd.computed) out.set(fd.path, [...fd.computed.operands, ...fd.computed.via]);
      }
      map = out;
      this._derivedSources.set(readable, map);
    }
    return map;
  }

  /**
   * THE field-visibility hook: every gated path consults it before any
   * capability check (since 0.1.133) — filter keys (inside `$and` / `$or` /
   * `$not`, existence predicates included), `$sort`, `$select`,
   * `$groupBy`, `$having` keys, aggregate and calendar-bucket `$field`s,
   * `$with` relation names and sub-query paths, and the `$search` fallback
   * fields. A path it rejects is answered exactly like a nonexistent one
   * (`Unknown field "x"` / `Unknown relation "x"`), so override it to hide
   * fields per request (read scopes). Since 0.1.134 it also governs row
   * identification — a unique index over a hidden field is not an
   * identification for `/one/:id`, `/one?…`, `DELETE`, a PK-less `PATCH` or
   * an action id (primary key and `preferredId` always are) — and the
   * nested-object 400 hint lists visible leaves only. The default accepts every real path
   * (`isValidFieldPath`). `/meta` does NOT consult it — prune hidden fields
   * there with `applyMetaOverlay` ({@link indexFieldPaths} names what each
   * search / geo index reads).
   *
   * Since 0.1.143 an override also gates the engine's indexes: a native
   * text-search index (`$index`, or the default one), a vector index
   * (`$vector`) or a geo index (`/geo`, `$index`) reading a hidden path
   * answers exactly like a nonexistent index (400); a hidden DEFAULT text
   * index falls back to the `@db.column.searchable` substring search over
   * visible fields (or ignores the term when there are none). A
   * `@db.column.derived` field is visible only while its source path is,
   * and one whose source is hidden is sealed out of every read projection
   * for the request, like a `@db.writeOnly` field. The same holds for a
   * computed view column (`@db.compute`) and each of its operands, including
   * the intermediate computed fields it reads through.
   */
  protected hasField(path: string): boolean {
    // Guarded for the partial-mock readables in *.spec.ts that omit
    // isValidFieldPath. Real AtscriptDbReadable instances always have it.
    if (typeof this.readable.isValidFieldPath === "function") {
      return this.readable.isValidFieldPath(path);
    }
    return this.readable.flatMap.has(path);
  }

  /**
   * Structural capability gate (since 0.1.128): walks the PARSED query —
   * filter tree, `$sort`, `$select`, `$groupBy`, `$having`, aggregate
   * `$field`s — and checks every root path against {@link capabilities}, the
   * same index `/meta.fields` is projected from. Runs on the wire request,
   * before `transformFilter` / `transformProjection` and before the write-only
   * seal (a `@db.writeOnly` field is selectable; the seal strips it silently).
   *
   * Rejections use the structured envelope `{ message, statusCode: 400,
   * errors: [{ path, message }] }` — `path` is the offending logical path.
   *
   * Expects normalized `$select` computed entries ({@link checkComputedSelect}
   * ran first); a bucket's source is checked like any other path (op
   * `bucket`). After the per-path checks the core `$having` rule runs
   * (`checkHavingKeys`: aliases or `$groupBy` fields only), so a readable mock
   * and a real table answer alike. Last (since 0.1.143, when {@link hasField}
   * is overridden) the index gate: a text / vector / geo index the request
   * uses must read only visible paths — see {@link indexFieldPaths}.
   */
  protected checkCapabilities(parsed: {
    filter?: FilterExpr;
    controls?: object;
  }): HttpError | undefined {
    const capabilities = this.capabilities;
    const isVisible = this.fieldVisibility.isVisible;
    const refs = collectQueryPaths(parsed);
    if (refs.unsupportedOperator !== undefined) {
      return badRequest(
        refs.unsupportedOperator,
        unsupportedOperatorMessage(refs.unsupportedOperator),
      );
    }
    // Each filter entry is judged on its own predicate class — the same
    // classification the core guard applies — so an existence-only
    // `{ metrics: { $exists: true } }` never exempts `{ metrics: … }` elsewhere.
    // A relational predicate (since 0.1.147) goes through the predicate gate,
    // root filter and `$with` sub-filters sharing one request-wide count.
    const relState = { nodes: 0 };
    for (const ref of refs.filter) {
      if (ref.predicate === "relation") {
        const relError = this._relationGate().checkRef(ref, relState);
        if (relError) return relError;
        continue;
      }
      const verdict = capabilities.check(ref.path, "filter", isVisible, ref.predicate);
      if (verdict) return badRequest(verdict.path, verdict.message);
    }
    // `$with` sub-filters: the CLIENT's tree as recorded before
    // `validateControls` — row scopes a server hook conjoined there are not
    // client input (not gated, not counted). Without a record (a flow that
    // skipped `validateParsed`), the live tree is judged.
    const liveWith = (parsed.controls as { $with?: unknown } | undefined)?.$with;
    const recorded = parsed.controls ? this._clientWith.get(parsed.controls) : undefined;
    const withRelError = this._relationGate().checkWith(
      recorded === undefined ? liveWith : recorded?.tree,
      relState,
    );
    if (withRelError) return withRelError;
    for (const op of PATH_OPS) {
      for (const path of refs[op]) {
        const verdict = capabilities.check(path, op, isVisible);
        if (verdict) return badRequest(verdict.path, verdict.message);
      }
    }
    // `$having` keys exist (checked above); they must also be aliases or
    // `$groupBy` fields — the core rule, answered here with the same wording.
    const having = checkHavingKeys(refs);
    if (having) return badRequest(having.path, having.message);
    return (
      this.checkGates(parsed) ??
      this._checkIndexGate((parsed.controls ?? {}) as Record<string, unknown>)
    );
  }

  /**
   * The core's shared normalizer of `$select` computed entries
   * (`normalizeComputedSelect`) as a 400 with the core's wording and `path`
   * (`$select` / `$groupBy`): entry shapes, calendar-bucket unit / zone /
   * week start / alias, "grouped queries only", "must also appear in
   * $groupBy", alias collisions with this table's fields. Runs once per
   * request, before {@link checkCapabilities}: at the head of
   * {@link validateParsed} — ahead of the controls DTO, which would otherwise
   * answer a bucket in a non-grouped query with a generic type mismatch — or
   * explicitly on the endpoint that skips it (`geo`).
   */
  protected checkComputedSelect(controls: object | undefined): HttpError | undefined {
    const capabilities = this.capabilities;
    try {
      normalizeComputedSelect(controls, {
        flatMap: this.readable.flatMap,
        physicalNames: capabilities.physicalNames,
        navFields: capabilities.navFields,
      });
    } catch (error) {
      if (!(error instanceof DbError)) throw error;
      const [issue] = error.errors;
      return badRequest(issue.path, issue.message);
    }
    return undefined;
  }

  /**
   * Root-path existence moved into {@link checkCapabilities}; the insights map
   * only serves `$with` sub-controls here — the URL parser flattens
   * `$with=assignee($select=name)` into the insight `assignee.name`, which is
   * resolved against the target table through `isValidFieldPath`.
   */
  protected override validateInsights(insights: Map<string, unknown>): string | undefined {
    // A relational predicate's navigation key first (since 0.1.147): a hidden
    // relation answers like a nonexistent one, before its operand paths.
    const hiddenRel = hiddenRelationInsight(insights, (path) => this.hasField(path));
    if (hiddenRel !== undefined) return unknownInsight(insights, hiddenRel);
    const nav = this.capabilities.navFields;
    for (const [key] of insights) {
      if (key === "*") continue;
      const dot = key.indexOf(".");
      if (dot === -1) continue;
      if (!nav.has(key.slice(0, dot))) continue;
      if (!this.hasField(key)) {
        return unknownInsight(insights, key);
      }
    }
    return undefined;
  }

  /**
   * {@link checkComputedSelect} (before the controls DTO), the controls DTO
   * ({@link validateControls}), then the `$with` relation names at every
   * level — BEFORE the `$with` sub-query paths ({@link validateInsights}),
   * so a hidden or nonexistent nested relation answers `Unknown relation`,
   * never `Unknown field "rel.sub"` (since 0.1.143) — then the insights and
   * the joined-row write-only veto.
   */
  protected override validateParsed(
    parsed: Uniquery,
    type: TDbControlsType,
  ): HttpError | undefined {
    const computedError = this.checkComputedSelect(parsed.controls);
    if (computedError) {
      return computedError;
    }
    const controls = parsed.controls as Record<string, unknown>;
    // Record the client's `$with` tree before `validateControls` may conjoin
    // server row scopes into it (since 0.1.147 — see `snapshotClientWith`).
    if (controls && typeof controls === "object") {
      this._clientWith.set(controls, snapshotClientWith(controls.$with) ?? null);
    }
    const controlsError = this.validateControls(controls, type);
    if (controlsError) {
      return new HttpError(400, controlsError);
    }
    const withRelations = controls.$with as Array<{ name: string }> | undefined;
    const unknown = withRelations?.length
      ? this._checkWithRelations(withRelations, this.readable, "")
      : undefined;
    if (unknown) {
      return unknown;
    }
    if (parsed.insights) {
      const insights = parsed.insights as Map<string, unknown>;
      const insightsError = this.validateInsights(insights);
      if (insightsError) {
        return insightError(insights, insightsError);
      }
    }
    if (withRelations?.length) {
      // A `$with` sub-filter / sub-sort on a joined table's `@db.writeOnly`
      // field is rejected exactly like the same filter / sort on this table's
      // own write-only field (an equality probe or sort order would leak the
      // sealed value). Recursive through nested `$with`.
      const vetoed = this._walkWith(
        withRelations,
        this.readable,
        "",
        (rel, target, path, nested) => {
          const sealed = this._writeOnlyOf(target);
          if (sealed.size === 0) return undefined;
          const refs = collectQueryPaths({
            filter: rel.filter,
            controls: { $sort: nested.$sort ?? rel.$sort },
          });
          const filtered = refs.filter.find(
            (ref) => selfOrAncestor(ref.path, sealed) !== undefined,
          )?.path;
          if (filtered !== undefined) return writeOnlyError(`${path}.${filtered}`, "filter");
          const sorted = refs.sort.find((p) => selfOrAncestor(p, sealed) !== undefined);
          return sorted === undefined ? undefined : writeOnlyError(`${path}.${sorted}`, "sort");
        },
      );
      if (vetoed instanceof HttpError) return vetoed;
    }
    return undefined;
  }

  // ── $with: one visitor for the veto and the seal (since 0.1.143) ────────

  /**
   * `$with` relation names at every level (nested `$with` since 0.1.143):
   * each segment of an entry's (dotted) name must be a relation of its
   * level's readable that {@link hasField} accepts at its full path from
   * this controller (`rel`, then `rel.sub` for a nested / dotted one) —
   * hidden answers exactly like nonexistent: {@link unknownRelationError}
   * with the entry's name and the relations visible at the level it failed
   * at. A level whose target readable cannot be resolved is not descended.
   */
  private _checkWithRelations(
    withRels: unknown,
    readable: AtscriptDbReadable<any>,
    prefix: string,
  ): HttpError | undefined {
    if (!Array.isArray(withRels)) return undefined;
    for (const rel of withRels as TWithEntry[]) {
      if (typeof rel?.name !== "string") continue;
      let level: AtscriptDbReadable<any> | undefined = readable;
      let path = prefix;
      for (const segment of rel.name.split(".")) {
        if (!level) break;
        const relations: ReadonlyMap<string, unknown> = level.relations ?? new Map();
        if (!relations.has(segment) || !this.hasField(path + segment)) {
          const visible = [...relations.keys()].filter((name) => this.hasField(path + name));
          return unknownRelationError(rel.name, visible);
        }
        path += `${segment}.`;
        level =
          typeof level.relatedTable === "function"
            ? (level.relatedTable(segment) as AtscriptDbReadable<any> | undefined)
            : undefined;
      }
      if (!level) continue;
      const nested = this._checkWithRelations(childrenOf(rel), level, path);
      if (nested) return nested;
    }
    return undefined;
  }

  /**
   * `@db.writeOnly` paths of a `$with` target — its own fields only (its
   * navigation descendants are sealed one level down, by their own target).
   */
  private _writeOnlyOf(readable: AtscriptDbReadable<any>): ReadonlySet<string> {
    let set = this._targetWriteOnly.get(readable);
    if (!set) {
      const own = new Set<string>();
      const nav: ReadonlySet<string> = readable.navFields ?? new Set();
      for (const [path, entry] of readable.flatMap ?? []) {
        if (!entry?.metadata?.has?.("db.writeOnly")) continue;
        if (selfOrAncestor(path, nav) !== undefined) continue;
        own.add(path);
      }
      set = own;
      this._targetWriteOnly.set(readable, set);
    }
    return set;
  }

  /** {@link TDbFieldVisibility.sealedFor}. */
  private _sealedFor(readable: AtscriptDbReadable<any>, prefix: string): ReadonlySet<string> {
    const writeOnly = readable === this.readable ? this._writeOnlySet : this._writeOnlyOf(readable);
    if (!this._hasFieldOverridden) return writeOnly;
    let out: Set<string> | undefined;
    // Computed fields share operands — ask `hasField` once per source path
    const visible = new Map<string, boolean>();
    const sourceVisible = (source: string): boolean => {
      let v = visible.get(source);
      if (v === undefined) visible.set(source, (v = this.hasField(prefix + source)));
      return v;
    };
    for (const [path, sources] of this._derivedSourcesOf(readable)) {
      if (writeOnly.has(path) || sources.every(sourceVisible)) continue;
      (out ??= new Set(writeOnly)).add(path);
    }
    return out ?? writeOnly;
  }

  /**
   * Walks a `$with` tree pre-order: `visit(rel, target, path, controls)` for
   * every entry whose target readable resolves (`path` = the entry's dotted
   * path from this controller, `controls` = its sub-controls). The visitor
   * returns replacement sub-controls, an `HttpError` to stop the walk (it is
   * returned as-is), or `undefined` to keep the entry. Returns the rebuilt
   * tree — the same array when nothing changed.
   */
  private _walkWith(
    withRels: unknown,
    readable: AtscriptDbReadable<any>,
    prefix: string,
    visit: (
      rel: TWithEntry,
      target: AtscriptDbReadable<any>,
      path: string,
      controls: Record<string, unknown>,
    ) => Record<string, unknown> | HttpError | undefined,
  ): unknown {
    if (!Array.isArray(withRels) || withRels.length === 0) return withRels;
    let out: unknown[] | undefined;
    for (let i = 0; i < withRels.length; i++) {
      const rel = withRels[i] as TWithEntry;
      const target = relTarget(readable, rel.name);
      if (!target) continue;
      const path = `${prefix}${rel.name}`;
      const nested = rel.controls ?? {};
      const visited = visit(rel, target, path, nested);
      if (visited instanceof HttpError) return visited;
      const children = nested.$with ?? rel.$with;
      const walked = this._walkWith(children, target, `${path}.`, visit);
      if (walked instanceof HttpError) return walked;
      if (visited === undefined && walked === children) continue;
      const controls = { ...(visited ?? nested) };
      if (walked !== undefined) controls.$with = walked;
      out ??= [...withRels];
      out[i] = { ...rel, controls };
    }
    return out ?? withRels;
  }

  /**
   * The read controls with every level sealed — the root `$select` (`select`,
   * the {@link transformProjection} result) and each `$with` entry's
   * `$select` lose the paths {@link TDbFieldVisibility.sealedFor} names for
   * their readable (an exclusion is forced when there is no projection), so
   * sealed values never leave the database. Runs AFTER `transformProjection`
   * so permission overlays compose: they see the wire `$select`, this
   * guarantees the seal on whatever they return.
   */
  private _sealControls(
    controls: Record<string, unknown>,
    select: UniqueryControls["$select"] | undefined,
  ): TSealedControls {
    const vis = this.fieldVisibility;
    const $with = this._walkWith(controls.$with, this.readable, "", (rel, target, path, nested) => {
      const sealed = vis.sealedFor(target, `${path}.`);
      if (sealed.size === 0) return undefined;
      const sub = (nested.$select ?? rel.$select) as UniqueryControls["$select"] | undefined;
      return { ...nested, $select: this._sealSelect(sub, sealed) };
    });
    const out: TSealedControls = {
      ...controls,
      $select: this._sealSelect(select, vis.sealedFor(this.readable)),
    };
    if ($with !== controls.$with) out.$with = $with;
    return out;
  }

  // ── Index visibility gating (since 0.1.143) ────────────────────────────

  /**
   * The text / vector / geo indexes of the bound readable with the LOGICAL
   * field paths each reads, and which one answers when a request names none.
   * Text and vector entries are the adapter's `getSearchIndexes()` (the names
   * `$index` / `$vector` address, their `fields` and `isDefault`; an entry
   * without `fields` lists every field — fail-closed); geo entries are the
   * `@db.index.geo` indexes. The request gate checks every listed path against
   * {@link hasField} (only when `hasField` is overridden); permission
   * overlays use it to prune `/meta` (`searchIndexes`, `searchable`,
   * `vectorSearchable`, `geoSearchable`). Computed once. Override to describe
   * an index the model cannot express.
   *
   * @since 0.1.143
   */
  protected indexFieldPaths(): readonly TDbIndexFieldPaths[] {
    return (this._indexFieldPathsCache ??= [
      ...this._searchIndexFieldPaths(),
      ...this._geoIndexFieldPaths(),
    ]);
  }

  private _searchIndexFieldPaths(): TDbIndexFieldPaths[] {
    const advertised =
      typeof this.readable.getSearchIndexes === "function" ? this.readable.getSearchIndexes() : [];
    const out = advertised.map(
      (info): TDbIndexFieldPaths => ({
        name: info.name,
        type: info.type === "vector" ? "vector" : "text",
        fields: info.fields ?? this._invertibleFields,
        isDefault: info.isDefault === true,
      }),
    );
    // An adapter that flags no default: its `DEFAULT`-named index (document
    // adapters alias their default there), else the first of that type.
    for (const type of ["text", "vector"] as const) {
      const ofType = out.filter((entry) => entry.type === type);
      if (ofType.some((entry) => entry.isDefault)) continue;
      const fallback = ofType.find((entry) => entry.name === "DEFAULT") ?? ofType[0];
      if (fallback) fallback.isDefault = true;
    }
    return out;
  }

  /** `@db.index.geo` indexes — their fields carry physical names, mapped back to logical paths. */
  private _geoIndexFieldPaths(): TDbIndexFieldPaths[] {
    const readable = this.readable;
    if (!(readable.indexes instanceof Map)) return [];
    // A derived column never shadows the regular field sharing its physical
    // name (document adapters).
    const logical = new Map<string, string>();
    for (const fd of readable.fieldDescriptors) {
      if (fd.ignored) continue;
      const prev = logical.get(fd.physicalName);
      if (prev === undefined || this._derivedSource.has(prev))
        logical.set(fd.physicalName, fd.path);
    }
    const out: TDbIndexFieldPaths[] = [];
    for (const index of readable.indexes.values()) {
      if (index.type !== "geo") continue;
      out.push({
        name: index.name,
        type: "geo",
        fields: index.fields.map((field) => logical.get(field.name) ?? field.name),
        isDefault: out.length === 0,
      });
    }
    return out;
  }

  /** Every path `entry` reads is visible to this request. */
  private _indexVisible(entry: TDbIndexFieldPaths): boolean {
    return entry.fields.every(this.fieldVisibility.isVisible);
  }

  /**
   * Native text search serves this request: the adapter searches natively
   * and — under an overridden {@link hasField} — the default index (when the
   * request names none) reads only visible fields. A named index is gated by
   * {@link checkCapabilities}. Answered once per request (keyed by its
   * parsed controls).
   */
  private _nativeSearch(controls: Record<string, unknown>): boolean {
    let native = this._nativeSearchByRequest.get(controls);
    if (native === undefined) {
      native = this._resolveNativeSearch(controls);
      this._nativeSearchByRequest.set(controls, native);
    }
    return native;
  }

  private _resolveNativeSearch(controls: Record<string, unknown>): boolean {
    if (!this.readable.isSearchable()) return false;
    if (!this._hasFieldOverridden) return true;
    if (typeof controls.$index === "string" && controls.$index) return true;
    const def = this.indexFieldPaths().find((e) => e.type === "text" && e.isDefault);
    return def === undefined || this._indexVisible(def);
  }

  /**
   * Index visibility gate (only when {@link hasField} is overridden), run by
   * {@link checkCapabilities} on every read: the geo index `/geo` reads
   * (`$index`, or the default one), the vector index `$vector` names (or the
   * default one) and the text index `$index` names must read only visible
   * paths; otherwise the request is answered exactly like one naming a
   * nonexistent index (the core's wording).
   */
  private _checkIndexGate(controls: Record<string, unknown>): HttpError | undefined {
    if (!this._hasFieldOverridden) return undefined;
    const name = typeof controls.$index === "string" ? controls.$index : undefined;
    // `$center` marks a geo search (`/geo` requires it; the other endpoints'
    // controls DTOs reject it). The text / vector gate below still runs.
    if (controls.$center !== undefined) {
      const geoIndexes = this.indexFieldPaths().filter((e) => e.type === "geo");
      const entry =
        name === undefined
          ? geoIndexes.find((e) => e.isDefault)
          : geoIndexes.find((e) => e.name === name);
      // A nonexistent geo index is the core's own 400 — the same wording.
      if (entry && !this._indexVisible(entry)) {
        return badRequest(name ?? "", geoIndexNotFoundMessage(this.readable.tableName, name));
      }
    }
    if (!controls.$search) return undefined;
    if (controls.$vector !== undefined) {
      const vectorName = typeof controls.$vector === "string" ? controls.$vector : "";
      const entry = this.indexFieldPaths().find(
        (e) => e.type === "vector" && (vectorName ? e.name === vectorName : e.isDefault),
      );
      if (entry && this._indexVisible(entry)) return undefined;
      return badRequest("$vector", vectorIndexNotFoundMessage(vectorName || undefined));
    }
    if (!this.readable.isSearchable()) return undefined; // the searchable-column fallback
    if (name) {
      const entry = this.indexFieldPaths().find((e) => e.type === "text" && e.name === name);
      if (!entry || !this._indexVisible(entry)) {
        return badRequest("$index", searchIndexNotFoundMessage(name));
      }
      return undefined;
    }
    // No `$index`: the default text index answers — refused like a missing
    // index when it reads a field this request can't see (a native search
    // over it would be a value oracle). `/meta` hides it by the same rule.
    const def = this.indexFieldPaths().find((e) => e.type === "text" && e.isDefault);
    if (def && !this._indexVisible(def)) {
      return badRequest("$search", searchIndexNotFoundMessage());
    }
    return undefined;
  }

  /**
   * `/meta`'s search surface as THIS request may use it (only when
   * {@link hasField} is overridden — the rule of the index gate): indexes
   * reading a hidden field are left out of `searchIndexes`; `searchable` /
   * `vectorSearchable` / `geoSearchable` turn off when the index a request
   * naming none would use reads one (`searchable` stays on for the
   * `@db.column.searchable` fallback when any of its fields is visible).
   */
  private _applyIndexVisibility(meta: TMetaResponse): TMetaResponse {
    if (!this._hasFieldOverridden) return meta;
    const entries = this.indexFieldPaths();
    const visibleDefault = (type: "text" | "vector" | "geo") => {
      const def = entries.find((e) => e.type === type && e.isDefault);
      return def !== undefined && this._indexVisible(def);
    };
    const hidden = new Set(
      entries.filter((e) => e.type !== "geo" && !this._indexVisible(e)).map((e) => e.name),
    );
    const searchable = this.readable.isSearchable()
      ? visibleDefault("text")
      : this._searchFallbackFields.some((f) => this.fieldVisibility.isVisible(f));
    return {
      ...meta,
      searchIndexes: (meta.searchIndexes ?? []).filter((i) => !hidden.has(i.name)),
      searchable: meta.searchable && searchable,
      vectorSearchable: meta.vectorSearchable && visibleDefault("vector"),
      geoSearchable: meta.geoSearchable && visibleDefault("geo"),
    };
  }

  // ── Hooks (overridable) ────────────────────────────────────────────────

  /**
   * Compute an embedding vector from a search term.
   * Override in subclass to integrate with your embedding provider (OpenAI, etc.).
   * Called when `$vector` is present in query controls.
   */
  protected computeEmbedding(_search: string, _fieldName?: string): Promise<number[]> {
    throw new HttpError(501, "Vector search requires computeEmbedding() to be implemented");
  }

  /**
   * Transform filter before querying. Override to add tenant filtering, etc.
   * May return a Promise for async lookups (session, permissions).
   */
  protected transformFilter(filter: FilterExpr): FilterExpr | Promise<FilterExpr> {
    return filter;
  }

  /**
   * Transform filter for the `/one/:id` and `/one?...` endpoints. Defaults to
   * {@link transformFilter} so any row-level read overlay applied to `/query` /
   * `/pages` also gates id-based reads (existence is not leaked through
   * `findById`). Override to scope `/one` differently.
   */
  protected transformOne(filter: FilterExpr): FilterExpr | Promise<FilterExpr> {
    return this.transformFilter(filter);
  }

  /**
   * Rewrites the sub-filter of a CLIENT relational predicate before it runs
   * — the row overlay of the related table (since 0.1.147). `path` is the
   * dotted navigation chain from this controller's table: `"ticket"` for
   * `ticket=$some(…)`, `"ticket.team"` for a predicate nested in its
   * operand, `"tickets.issues"` for `$with=tickets(issues=$some(…))`.
   * Default identity.
   *
   * Applied to client predicates only (the URL filter and `$with`
   * sub-filters, on `/query` incl. `$groupBy` and `$count`, `/pages`, `/geo`
   * and `/one`, and a query target's filter), after the request gate and before {@link transformFilter};
   * a nested predicate's operand is rewritten before the operand holding it,
   * and the hook's output is not walked again. Server-side filters
   * ({@link transformFilter}, {@link transformOne}, {@link actionRowScope})
   * never pass through it. Return the operand conjoined with the related
   * rows the caller may see — `$some` then only matches, and `$none` only
   * excludes, on VISIBLE related rows, exactly as `$with` shows them:
   *
   * ```ts
   * protected transformRelationFilter(path: string, filter: FilterExpr) {
   *   return path === "ticket" ? { $and: [{ teamId: { $in: currentTeams() } }, filter] } : filter
   * }
   * ```
   *
   * @since 0.1.147
   */
  protected transformRelationFilter(
    _path: string,
    filter: FilterExpr,
  ): FilterExpr | Promise<FilterExpr> {
    return filter;
  }

  /** The client relational-predicate gate (since 0.1.147) — one per controller. */
  private _relationGate(): RelationPredicateGate {
    return (this._relGate ??= new RelationPredicateGate({
      readable: this.readable,
      hasField: (path) => this.hasField(path),
      scoped: this._hasFieldOverridden,
      derivedSourcesOf: (readable) => this._derivedSourcesOf(readable),
      writeOnlyOf: (readable) => this._writeOnlyOf(readable),
      capabilities: () => this.capabilities,
    }));
  }

  /**
   * The client filter with every relational predicate operand rewritten by
   * {@link transformRelationFilter} — and `parsed.controls.$with` replaced by
   * its rewritten tree (since 0.1.147). Costs nothing unless the hook is
   * overridden.
   */
  private async _relationOverlay<F extends FilterExpr | undefined>(parsed: {
    filter?: F;
    controls?: object;
  }): Promise<F> {
    if (this.transformRelationFilter === AsDbReadableController.prototype.transformRelationFilter) {
      return parsed.filter as F;
    }
    const hook = (path: string, filter: FilterExpr) => this.transformRelationFilter(path, filter);
    const controls = parsed.controls as Record<string, unknown> | undefined;
    if (controls?.$with !== undefined) {
      // Only the client's `$with` predicates are overlaid (server-added ones
      // — e.g. a row scope conjoined in `validateControls` — are the policy
      // itself). A client predicate the server hook replaced by a copy would
      // escape the overlay: fail closed instead.
      const recorded = this._clientWith.get(controls);
      // `null` / no recorded predicate: the client's `$with` held none.
      if (recorded !== null && recorded?.predicates.size !== 0) {
        const scope = recorded
          ? { predicates: recorded.predicates, seen: new Set<object>() }
          : undefined;
        controls.$with = await overlayWithFilters(controls.$with, "", hook, scope);
        if (scope && scope.seen.size !== scope.predicates.size) {
          throw new HttpError(
            500,
            "validateControls replaced a client $with relational predicate — wrap the client's $with filter (keep its object), do not copy or drop it",
          );
        }
      }
    }
    return (
      parsed.filter ? await overlayRelationFilter(parsed.filter, "", hook) : parsed.filter
    ) as F;
  }

  /**
   * The subset of the row-level action `names` the caller may run (since
   * 0.1.145) — what `$actions` and `GET /meta/actions/:id` list from. The
   * default keeps the names present in the per-request `/meta` envelope
   * (`applyMetaOverlay` over the cached one), or all of them when
   * `applyMetaOverlay` is not overridden (no call). Override it to answer
   * from per-action permission checks without building the whole `/meta`
   * overlay on every `$actions` read. Runs after {@link prepareRequest}.
   * Names it returns that are not in `names` are ignored.
   *
   * @since 0.1.145
   */
  protected allowedActions(
    names: readonly string[],
  ): readonly string[] | Promise<readonly string[]> {
    if (this._overlayIsNoOp) return names;
    return (async () => {
      // This controller's own envelope (`@DbActionsFrom` entries are judged by their source).
      const meta = await (this._hasDelegations ? super.resolveMeta() : this.resolveMeta());
      const present = new Set(meta.actions.map((a) => a.name));
      return names.filter((name) => present.has(name));
    })();
  }

  /**
   * The rows the row-level action `actionName` may run on (since 0.1.145),
   * as an extra row filter; `undefined` or `{}` = no restriction (the
   * default). Enforced by the action gate — the action's ids / rows are
   * loaded under {@link rowOverlay}, then checked against this filter, so an
   * id outside it gets the same 404 "Row not found for action identifier"
   * as a missing one — and reflected in `$actions` and
   * `GET /meta/actions`, which list the action only on rows inside it.
   *
   * Since 0.1.147 the hook receives the candidate rows (`ctx`), so a scope
   * can depend on them — e.g. derive `{ ticketKey: { $in: … } }` from a
   * related table read for exactly these rows:
   *
   * | `ctx.purpose` | asked by | `ctx.ids` |
   * | --- | --- | --- |
   * | `"execute"` | the action gate | the loaded ids / rows (≤ `maxIds`; one batch of a query target) |
   * | `"rows"` | `$actions` on a read (and a view's delegated verdicts) | the read's rows |
   * | `"available"` | `GET /meta/actions/:id` | the one row |
   *
   * - Called only with at least one candidate, at most once per action per
   *   evaluation; `ctx.ids` is the same array object for every action of
   *   one evaluation (memoize on it with a `WeakMap`).
   * - Candidates are already inside the row overlay — ids that do not exist
   *   or fall outside it never reach the hook.
   * - The result only restricts (`ids ∧ rowOverlay ∧ scope`); a throw fails
   *   the request — never a silent "allow".
   * - The filter runs straight against the bound readable: it may use
   *   fields {@link hasField} hides, and nothing of it (nor of
   *   `ctx.loadRows`) reaches the response. Equal filters — the same object,
   *   or structurally equal ones — share one id-only query.
   * - Runs after {@link prepareRequest} and, on the action route, after the
   *   request body is read (it needs the ids).
   *
   * Not overriding it costs nothing; a one-parameter override keeps working.
   * moost-db always passes `ctx` — it is optional in the signature only so
   * `super.actionRowScope(name)` calls in existing overrides keep compiling.
   *
   * ```ts
   * protected async actionRowScope(action: string, ctx: TDbActionScopeContext) {
   *   if (action !== "resolve") return undefined
   *   const issues = await ctx.loadRows(["ticketKey"])
   *   const tickets = await ticketTable.findMany({
   *     filter: { key: { $in: issues.map((i) => i.ticketKey) }, teamId: currentTeamId() },
   *     controls: { $select: ["key"] },
   *   })
   *   return { ticketKey: { $in: tickets.map((t) => t.key) } }
   * }
   * ```
   *
   * The scope may use relational predicates (since 0.1.147) — a server-side
   * filter, so no `@db.rel.filterable` opt-in and no
   * {@link transformRelationFilter} apply. On an Issue controller:
   *
   * ```ts
   * protected actionRowScope(action: string) {
   *   return action === "resolve"
   *     ? { ticket: { $some: { teamId: { $in: currentTeams() }, status: "open" } } }
   *     : undefined
   * }
   * ```
   *
   * @since 0.1.145
   */
  protected actionRowScope(
    _actionName: string,
    _ctx?: TDbActionScopeContext,
  ): FilterExpr | undefined | Promise<FilterExpr | undefined> {
    return undefined;
  }

  /**
   * The read scope a query target (an action request `{ query }`, since
   * 0.1.147) resolves under, on top of the action's row overlay — so "every
   * row matching the query" never reaches rows the caller cannot list. A
   * view resolving a delegated action's query target applies it too.
   * Default: `transformFilter({})` (the read overlay of `/query`). Throw an
   * `HttpError` to refuse query targets for the caller (e.g. no read grant).
   *
   * Runs as a READ of this controller: it is called in a child of the
   * action event — of the delegating event for a view resolving a delegated
   * target — (moost `withControllerContext`, the controller's `query`
   * handler) after `prepareRequest({ endpoint: "query", controls, filter })`
   * with the target's own filter and controls — so a permission layer's
   * per-request state is the READ request's (its read grant, the policy of
   * the relations its predicates touch), never the action's, and nothing of
   * it leaks back. The target's query (`q` filter and controls, `exclude`)
   * is validated in that read context ({@link validateControls},
   * {@link checkCapabilities}, {@link hasField}), where the client
   * predicates' {@link transformRelationFilter} also runs: a query target
   * never filters on, nor counts by, a field the caller can't read.
   *
   * @since 0.1.147
   */
  protected queryTargetScope(
    _action: string,
  ): FilterExpr | undefined | Promise<FilterExpr | undefined> {
    return this.transformFilter({} as FilterExpr);
  }

  /**
   * Transform projection before querying.
   * May return a Promise for async lookups.
   */
  protected transformProjection(
    projection?: UniqueryControls["$select"],
  ): UniqueryControls["$select"] | undefined | Promise<UniqueryControls["$select"] | undefined> {
    return projection;
  }

  private widenPreferredIdProjection(
    projection?: UniqueryControls["$select"],
  ): UniqueryControls["$select"] | undefined | HttpError {
    // Quantity-ref widening runs first so the preferred-id pass sees the already-widened projection.
    const widened = this.widenQuantityRefProjection(projection);
    if (widened instanceof HttpError) return widened;
    const preferredIdSet = this._preferredIdSet;
    if (preferredIdSet.size === 0 || widened === undefined) {
      return widened;
    }
    if (Array.isArray(widened)) {
      return this._widenArrayProjection(widened);
    }
    return this._widenMapProjection(widened as Record<string, unknown>);
  }

  private _widenArrayProjection(
    projection: readonly unknown[],
  ): UniqueryControls["$select"] | undefined {
    const stringItems = new Set<string>();
    for (const item of projection) {
      if (typeof item === "string") stringItems.add(item);
    }
    let allPresent = true;
    for (const field of this._preferredIdSet) {
      if (!stringItems.has(field)) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) return projection as UniqueryControls["$select"];
    const out = [...projection] as unknown[];
    for (const field of this._preferredIdSet) {
      if (!stringItems.has(field)) out.push(field);
    }
    return out as UniqueryControls["$select"];
  }

  private _widenMapProjection(
    projection: Record<string, unknown>,
  ): UniqueryControls["$select"] | undefined | HttpError {
    const entries = Object.entries(projection);
    if (entries.length === 0) return projection as UniqueryControls["$select"];

    const included = new Set<string>();
    const excluded = new Set<string>();
    for (const [k, v] of entries) {
      if (v === 1 || v === true) included.add(k);
      else if (v === 0 || v === false) excluded.add(k);
    }
    if (included.size > 0 && excluded.size > 0) {
      return new HttpError(400, "Mixed inclusion/exclusion $select maps are not supported");
    }

    if (excluded.size === 0) {
      let allPresent = true;
      for (const field of this._preferredIdSet) {
        if (!included.has(field)) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) return projection as UniqueryControls["$select"];
      const widened: Record<string, 1> = {};
      for (const k of included) widened[k] = 1;
      for (const field of this._preferredIdSet) widened[field] = 1;
      return widened as UniqueryControls["$select"];
    }

    const widened: Record<string, 1> = {};
    for (const path of this._invertExclusion(excluded)) widened[path] = 1;
    for (const field of this._preferredIdSet) widened[field] = 1;
    return widened as UniqueryControls["$select"];
  }

  /**
   * The logical paths an exclusion keeps. A path goes when it, an ancestor
   * or a descendant is excluded: excluding an object parent excludes its
   * whole subtree, and a kept parent would carry an excluded child back
   * (its other leaves stay listed on their own). Before 0.1.134 only the
   * exact paths were dropped, so `$select=-a` still returned `a`'s leaves.
   */
  private _invertExclusion(excluded: ReadonlySet<string>): string[] {
    return this._invertibleFields.filter((path) => {
      if (selfOrAncestor(path, excluded) !== undefined) return false;
      const prefix = `${path}.`;
      for (const key of excluded) {
        if (key.startsWith(prefix)) return false;
      }
      return true;
    });
  }

  /**
   * Auto-includes the sibling-ref field whenever its `@db.amount.currency.ref`
   * / `@db.unit.ref` quantity is selected — UI must never get a value without
   * its dimension. No-op when `$select` is undefined (full row covers it).
   */
  private widenQuantityRefProjection(
    projection?: UniqueryControls["$select"],
  ): UniqueryControls["$select"] | undefined | HttpError {
    if (this._quantityRefByPath.size === 0 || projection === undefined) {
      return projection;
    }
    if (Array.isArray(projection)) {
      return this._widenQuantityArrayProjection(projection);
    }
    return this._widenQuantityMapProjection(projection as Record<string, unknown>);
  }

  private _widenQuantityArrayProjection(
    projection: readonly unknown[],
  ): UniqueryControls["$select"] | undefined {
    const stringItems = new Set<string>();
    for (const item of projection) {
      if (typeof item === "string") stringItems.add(item);
    }
    const toAdd: string[] = [];
    for (const [valuePath, refPath] of this._quantityRefByPath) {
      if (stringItems.has(valuePath) && !stringItems.has(refPath)) {
        toAdd.push(refPath);
        stringItems.add(refPath);
      }
    }
    if (toAdd.length === 0) return projection as UniqueryControls["$select"];
    return [...projection, ...toAdd] as UniqueryControls["$select"];
  }

  private _widenQuantityMapProjection(
    projection: Record<string, unknown>,
  ): UniqueryControls["$select"] | undefined | HttpError {
    const entries = Object.entries(projection);
    if (entries.length === 0) return projection as UniqueryControls["$select"];

    const included = new Set<string>();
    const excluded = new Set<string>();
    for (const [k, v] of entries) {
      if (v === 1 || v === true) included.add(k);
      else if (v === 0 || v === false) excluded.add(k);
    }
    if (included.size > 0 && excluded.size > 0) {
      return new HttpError(400, "Mixed inclusion/exclusion $select maps are not supported");
    }

    if (excluded.size === 0) {
      const toAdd: string[] = [];
      for (const [valuePath, refPath] of this._quantityRefByPath) {
        if (included.has(valuePath) && !included.has(refPath)) {
          toAdd.push(refPath);
        }
      }
      if (toAdd.length === 0) return projection as UniqueryControls["$select"];
      const widened: Record<string, 1> = {};
      for (const k of included) widened[k] = 1;
      for (const k of toAdd) widened[k] = 1;
      return widened as UniqueryControls["$select"];
    }

    // Exclusion form: don't silently override an explicit exclusion of a ref dimension.
    return projection as UniqueryControls["$select"];
  }

  /** Normalize a post-`widenPreferredIdProjection` $select into `string[] | null` (`null` = all fields). */
  private _resolveProjectionForAugmenter(
    select: UniqueryControls["$select"] | undefined,
  ): string[] | null {
    if (select === undefined) return null;
    if (Array.isArray(select)) {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const item of select) {
        if (typeof item === "string" && !seen.has(item)) {
          seen.add(item);
          out.push(item);
        }
      }
      return out;
    }
    const obj = select as Record<string, unknown>;
    const included: string[] = [];
    const excluded: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === 1 || v === true) included.push(k);
      else if (v === 0 || v === false) excluded.push(k);
    }
    if (included.length > 0 && excluded.length === 0) return included;
    if (excluded.length > 0 && included.length === 0) {
      return this._invertExclusion(new Set(excluded));
    }
    throw new HttpError(
      500,
      "[moost-db] mixed inclusion/exclusion projection reached augmenter; widenPreferredIdProjection should have rejected it",
    );
  }

  /** Row/rows envelopes narrowed to {@link allowedActions}; no hook call when neither it nor `applyMetaOverlay` is overridden. */
  private async _resolveAugmentEnvelopes(): Promise<readonly TDbActionEnvelope[] | null> {
    const rowLevelEnvelopes = discoverRowLevelActions(
      this.constructor as Function,
      this.app,
      this.logger,
    );
    if (rowLevelEnvelopes.length === 0) return null;
    this._warnScopeWithoutIdentity();
    if (this._overlayIsNoOp && !this._hasAllowedActions) return rowLevelEnvelopes;
    const allowed = new Set(await this.allowedActions(rowLevelEnvelopes.map((e) => e.info.name)));
    const filtered = rowLevelEnvelopes.filter((e) => allowed.has(e.info.name));
    return filtered.length === 0 ? null : filtered;
  }

  /**
   * Once per class: `actionRowScope` is overridden (a permission layer always
   * does) while the controller's OWN row-level actions can't be scoped — the
   * readable has no identity, so `$actions` withholds every action with a
   * non-empty row scope. Silent for controllers without own row actions.
   */
  private _warnScopeWithoutIdentity(): void {
    const ctor = this.constructor as Function;
    if (
      !this._hasActionRowScope ||
      this.readable.preferredId.length > 0 ||
      warnedNoIdentity.has(ctor)
    ) {
      return;
    }
    warnedNoIdentity.add(ctor);
    this.logger.warn(
      `actionRowScope() is overridden but "${this.readable.tableName}" has no primary key — ` +
        `\`$actions\` withholds every action with a non-empty row scope`,
    );
  }

  /**
   * Returns a widened `$select` only when at least one `requiredFields` entry
   * is missing; `null` means "no widening needed". A field the request may
   * not see (`hasField`, derived source) is never added (since 0.1.143) —
   * the action predicate sees it as `undefined`.
   */
  private _widenSelectForActions(
    envelopes: readonly TDbActionEnvelope[],
    baseSelect: readonly string[],
  ): string[] | null {
    let resultSet: Set<string> | null = null;
    let result: string[] | null = null;
    for (const e of envelopes) {
      for (const f of requiredFieldsOf(e.raw)) {
        const present = resultSet ? resultSet.has(f) : baseSelect.includes(f);
        if (present || !this.fieldVisibility.isVisible(f)) continue;
        if (resultSet === null) {
          resultSet = new Set(baseSelect);
          result = [...baseSelect];
        }
        resultSet.add(f);
        result!.push(f);
      }
    }
    return result;
  }

  private async _prepareAugmentation(
    controls: Record<string, unknown>,
    select: UniqueryControls["$select"] | undefined,
  ): Promise<TAugmentationPrep | null> {
    if (!controls.$actions) return null;
    const [own, delegations] = await Promise.all([
      this._resolveAugmentEnvelopes(),
      this._activeDelegations(),
    ]);
    if (own === null && delegations.length === 0) return null;
    const envelopes = own ?? [];
    let scopeOverlay: Promise<FilterExpr | undefined> | null = null;
    if (this._hasActionRowScope && envelopes.length > 0) {
      // Candidate-free, so it overlaps the read; the scope groups need the
      // read's rows (awaited in `_finishRows`).
      scopeOverlay = this.rowOverlay();
      scopeOverlay.catch(() => {});
    }
    let resolvedProjection = this._resolveProjectionForAugmenter(select);
    let widenedSelect =
      resolvedProjection === null
        ? null
        : this._widenSelectForActions(envelopes, resolvedProjection);
    if (resolvedProjection !== null && delegations.length > 0) {
      // A delegation's id paths are selected and KEPT: the client addresses
      // the source through them.
      const base = widenedSelect ?? resolvedProjection;
      const present = new Set(base);
      const extra = [...new Set(delegations.flatMap((d) => d.paths))].filter(
        (p) => !present.has(p),
      );
      if (extra.length > 0) {
        widenedSelect = [...base, ...extra];
        resolvedProjection = [...resolvedProjection, ...extra];
      }
    }
    return { envelopes, resolvedProjection, widenedSelect, scopeOverlay, delegations };
  }

  /**
   * {@link actionRowScope} of every action in `names` for one evaluation
   * (`ctx`, in parallel, alongside `overlay`), grouped by filter — object
   * identity first, then structural equality (`filterKey`), so equal filters
   * share one query; each group's filter is composed with the row overlay
   * exactly as the gate composes it.
   */
  private async _resolveActionScopeGroups(
    names: readonly string[],
    ctx: TDbActionScopeContext,
    overlay: FilterExpr | undefined | Promise<FilterExpr | undefined>,
  ): Promise<TActionScopeGroup[]> {
    const [rowOverlay, scopes] = await Promise.all([
      overlay,
      Promise.all(names.map(async (name) => this._actionScope(name, ctx))),
    ]);
    // Keyed structurally; a filter `filterKey` can't key groups by identity
    const groups = new Map<unknown, TActionScopeGroup>();
    for (let i = 0; i < names.length; i++) {
      const scope = scopes[i];
      if (!scope) continue;
      const key = filterKey(scope) ?? scope;
      let group = groups.get(key);
      if (!group) {
        group = { filter: withOverlay(scope, rowOverlay), actions: [] };
        groups.set(key, group);
      }
      group.actions.push(names[i]);
    }
    return [...groups.values()];
  }

  /**
   * Per action of `names`, a per-row mask (parallel to `rows`) of rows
   * outside its {@link actionRowScope} — one id-only read per distinct
   * filter. The hook sees the rows' identities (`purpose`); a row lacking
   * its identity is in no scope. No candidate → no hook call, every row
   * masked for every action (fail closed). `undefined` when the hook is not
   * overridden or `rows` is empty.
   */
  private async _scopeMasks(
    rows: readonly (Record<string, unknown> | undefined)[],
    names: readonly string[],
    purpose: TDbActionScopePurpose,
    overlay: FilterExpr | undefined | Promise<FilterExpr | undefined>,
  ): Promise<Map<string, readonly boolean[]> | undefined> {
    if (!this._hasActionRowScope || rows.length === 0 || names.length === 0) return undefined;
    const { ids, index } = candidateIds(rows, this.readable.preferredId);
    const masks = new Map<string, readonly boolean[]>();
    if (ids.length === 0) {
      const all = rows.map(() => true);
      for (const name of names) masks.set(name, all);
      return masks;
    }
    const source = this.readable as unknown as TRowsByIdSource;
    const groups = await this._resolveActionScopeGroups(
      names,
      createScopeContext(purpose, ids, source),
      overlay,
    );
    const found = await Promise.all(
      groups.map((group) => findRowsByIds(source, ids, group.filter, [])),
    );
    for (let g = 0; g < groups.length; g++) {
      const mask = index.map((i) => i < 0 || found[g][i] === undefined);
      for (const name of groups[g].actions) masks.set(name, mask);
    }
    return masks;
  }

  /**
   * The row filter {@link actionRowScope} returns for `action` and the
   * candidates of `ctx` — `undefined` when empty or when the hook is not
   * overridden (no call). THE per-action scope rule: the action gate,
   * `$actions` and `/meta/actions` all read it here.
   */
  private async _actionScope(
    action: string,
    ctx: TDbActionScopeContext,
  ): Promise<FilterExpr | undefined> {
    if (!this._hasActionRowScope) return undefined;
    return nonEmptyFilter(await this.actionRowScope(action, ctx));
  }

  /**
   * The fields `envelope`'s gate loads ({@link actionRowFields} under this
   * request's field visibility) — memoized unless visibility is request-scoped.
   */
  private _gateFields(envelope: TDbActionEnvelope): ReadonlySet<string> {
    const visibility = this.fieldVisibility;
    const required = requiredFieldsOf(envelope.raw);
    if (visibility.scoped) return actionRowFields(this.readable, required, visibility.isVisible);
    let fields = this._gateFieldsMemo.get(envelope);
    if (!fields) {
      fields = actionRowFields(this.readable, required, undefined);
      this._gateFieldsMemo.set(envelope, fields);
    }
    return fields;
  }

  /**
   * @internal The action gate's row overlay (reached by the `@DbAction`
   * interceptor through {@link ACTION_OVERLAY}): {@link rowOverlay}. Since
   * 0.1.147 the action's {@link actionRowScope} is applied separately to the
   * loaded candidates ({@link ACTION_SCOPE}).
   */
  [ACTION_OVERLAY](): Promise<FilterExpr | undefined> {
    return this.rowOverlay();
  }

  /** @internal {@link actionRowScope} for the gate's loaded candidates (since 0.1.147). */
  [ACTION_SCOPE](action: string, ctx: TDbActionScopeContext): Promise<FilterExpr | undefined> {
    return this._actionScope(action, ctx);
  }

  /** @internal `true` when {@link actionRowScope} is overridden (since 0.1.147). */
  get [ACTION_SCOPED](): boolean {
    return this._hasActionRowScope;
  }

  /**
   * @internal Resolves a query target (phase 1, since 0.1.147): the `query`
   * body validated (shape, `$search` / `$index` only, the read's capability
   * and index gate), then ONE read of `select` ordered by identity —
   * `filter (+ $search) ∧ overlay ∧ queryTargetScope ∧ ¬exclude`, at most
   * `cap + 1` rows. More than the cap → 400 `TARGET_TOO_LARGE`; a count
   * other than `expectCount` → 409 `TARGET_CHANGED`. `load` re-reads rows
   * of the snapshot that still match the same target (phase 2) — except for
   * the first batch, which directly follows the snapshot.
   */
  async [RESOLVE_TARGET](req: TTargetRequest): Promise<TResolvedTarget> {
    const { action } = req;
    const body = parseQueryTargetBody(action, req.query);
    const parsed = this.parseUrlOr400(body.q.startsWith("?") ? body.q.slice(1) : body.q);
    const controls: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((parsed.controls ?? {}) as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (k !== "$search" && k !== "$index") {
        throw targetInvalid(
          action,
          `A query target takes a filter, $search and $index only — "${k}" is not accepted`,
        );
      }
      if (k === "$search" && typeof v !== "string" && typeof v !== "number") {
        throw targetInvalid(action, "$search must be a search term");
      }
      controls[k] = k === "$search" ? `${v as string | number}` : v;
    }
    if (controls.$index !== undefined && typeof controls.$index !== "string") {
      throw targetInvalid(action, "$index must be an index name");
    }
    const exclude = body.exclude ?? [];
    const shapes = req.excludeShapes ?? [];
    // The query (filter, controls, exclusions) as THIS request may run it:
    // `validateControls` (per-control authorization), the capability / index
    // gate and the identifications under `hasField`.
    const check = (): void => {
      const controlsError = this.validateControls(controls, "query");
      if (controlsError) throw new HttpError(400, controlsError);
      const gateError = this.checkCapabilities({ filter: parsed.filter, controls });
      if (gateError) throw gateError;
      if (exclude.length > 0) {
        const source =
          shapes.length === 0
            ? this.idSource
            : {
                identifications: [
                  ...this.idSource.identifications,
                  ...shapes.map((fields) => ({ fields, source: "target" })),
                ],
                fieldDescriptors: this.readable.fieldDescriptors,
              };
        validateMultiId(exclude, source, req.maxExclude);
      }
    };

    // The query is checked, and its read hooks run, as a READ of this
    // controller (see `queryTargetScope`) — after `prepareRequest({ endpoint:
    // "query", controls, filter })` with the target's own filter, so a
    // permission layer resolves the policy of its relational predicates as
    // on `/query`: the client predicates' `transformRelationFilter`,
    // `queryTargetScope` and, for a view resolving a delegated target, its
    // read overlay `transformFilter`.
    const [[base, scope], overlay] = await Promise.all([
      this._asRead(controls, parsed.filter as FilterExpr | undefined, async () => {
        check();
        const [clientFilter, readScope] = await Promise.all([
          this._relationOverlay(parsed),
          this.queryTargetScope(action),
        ]);
        const read =
          req.overlay === "read"
            ? await this.transformFilter(clientFilter ?? ({} as FilterExpr))
            : clientFilter;
        return [read, readScope] as const;
      }),
      req.overlay === "action" ? this.rowOverlay() : undefined,
    ]);
    const filter = andFilters(
      this.applySearchFallback(base, controls),
      overlay,
      scope,
      exclude.length > 0 ? ({ $not: { $or: exclude } } as FilterExpr) : undefined,
    );
    const strategy = await this._resolveReadStrategy(controls);
    const findMany = (q: unknown): Promise<Record<string, unknown>[]> =>
      (strategy.kind === "search"
        ? this.readable.search(strategy.term, q as Uniquery<any, any>, strategy.index)
        : this.readable.findMany(q as Uniquery<any, any>)) as Promise<Record<string, unknown>[]>;

    const cap = Math.min(req.cap, body.maxRows ?? Infinity);
    const sort: Record<string, 1> = {};
    for (const f of req.select) sort[f] = 1;
    const rows = await findMany({
      filter,
      controls: { $select: [...new Set(req.select)], $sort: sort, $limit: cap + 1 },
    });
    if (rows.length > cap) {
      throw new ActionTargetError(
        "TARGET_TOO_LARGE",
        action,
        `The query matches more than ${cap} rows`,
        { cap },
      );
    }
    if (body.expectCount !== undefined && body.expectCount !== rows.length) {
      throw new ActionTargetError(
        "TARGET_CHANGED",
        action,
        `The query now matches ${rows.length} rows (expected ${body.expectCount})`,
        { matched: rows.length },
      );
    }
    // A `$limit` of its own: a search pipeline defaults to 1000 rows, which
    // would turn every later row of a large batch "stale".
    const byIds = (
      read: (q: unknown) => Promise<Record<string, unknown>[]>,
      ids: readonly Record<string, unknown>[],
      scope: FilterExpr | undefined,
      select: Iterable<string>,
    ) =>
      findRowsByIds(
        {
          findMany: (q) =>
            read({
              ...q,
              controls: { ...(q.controls as object), $limit: Math.max(ids.length, cap + 1) },
            }),
        },
        ids,
        scope,
        select,
      );
    const snapshotFields = new Set(req.select);
    let first = true;
    return {
      matched: rows.length,
      rows,
      dryRun: body.dryRun === true,
      exclude,
      load: (ids, select) => {
        if (!first) return byIds(findMany, ids, filter, select);
        // The first batch directly follows the snapshot in this request —
        // its rows matched moments ago, so it is not re-checked: served from
        // the snapshot, or (needing more fields) read by identity alone.
        // Later batches run after the handler worked on earlier ones.
        first = false;
        const fields = [...select];
        if (!fields.every((f) => snapshotFields.has(f))) {
          const plain = (q: unknown) =>
            this.readable.findMany(q as Uniquery<any, any>) as Promise<Record<string, unknown>[]>;
          return byIds(plain, ids, undefined, fields);
        }
        return Promise.resolve(
          alignRowsToIds(rows, ids).map((row, i) =>
            row ? projectRow(row, new Set([...fields, ...Object.keys(ids[i]!)])) : undefined,
          ),
        );
      },
    };
  }

  /**
   * Runs `fn` as a READ of this controller (since 0.1.147): in a child of
   * the current event whose controller context is this controller's `query`
   * handler, after `prepareRequest({ endpoint: "query", controls, filter })` — the
   * request-scoped state a permission layer builds there (read grant, field
   * visibility) is the read's and stays in the child.
   */
  private _asRead<R>(
    controls: Record<string, unknown>,
    filter: FilterExpr | undefined,
    fn: () => R | Promise<R>,
  ): Promise<R> {
    return runAsController(this, "query", async () => {
      if (typeof this.prepareRequest === "function") {
        await this.prepareRequest(readRequestContext("query", controls, filter));
      }
      return fn();
    });
  }

  /**
   * `@db.column.searchable` paths, minus anything the adapter can't filter
   * (JSON storage, encrypted), `@db.writeOnly` fields and navigation
   * descendants — physical capability only (manual-mode policy does not
   * apply to `$search`).
   */
  private _collectSearchFallbackFields(): string[] {
    const out: string[] = [];
    for (const fd of this.readable.fieldDescriptors) {
      if (fd.ignored) continue;
      if (!fd.type?.metadata?.has?.("db.column.searchable")) continue;
      if (!this.capabilities.isPhysicallyFilterable(fd.path)) continue;
      out.push(fd.path);
    }
    return out;
  }

  /**
   * `select` without the `sealed` paths (see {@link _sealControls}); an
   * exclusion of them is forced when there is no projection, or when every
   * requested path was sealed.
   */
  private _sealSelect(
    select: UniqueryControls["$select"] | undefined,
    writeOnly: ReadonlySet<string>,
  ): UniqueryControls["$select"] | undefined {
    if (writeOnly.size === 0) return select;
    const exclusion = (): UniqueryControls["$select"] => {
      const out: Record<string, 0> = {};
      for (const f of writeOnly) out[f] = 0;
      return out as UniqueryControls["$select"];
    };
    if (select === undefined) return exclusion();
    if (Array.isArray(select)) {
      const kept = (select as unknown[]).filter((item) =>
        typeof item === "string"
          ? !writeOnly.has(item)
          : !writeOnly.has((item as { $field?: string }).$field ?? ""),
      );
      // Everything requested was sealed — an empty inclusion means "all
      // fields", so fall back to the exclusion form instead.
      return kept.length > 0 ? (kept as UniqueryControls["$select"]) : exclusion();
    }
    const entries = Object.entries(select as Record<string, 0 | 1>);
    if (entries.length > 0 && (entries[0][1] === 1 || (entries[0][1] as unknown) === true)) {
      const out: Record<string, 0 | 1> = {};
      for (const [k, v] of entries) if (!writeOnly.has(k)) out[k] = v;
      return Object.keys(out).length > 0 ? (out as UniqueryControls["$select"]) : exclusion();
    }
    const out: Record<string, 0 | 1> = { ...(select as Record<string, 0 | 1>) };
    for (const f of writeOnly) out[f] = 0;
    return out as UniqueryControls["$select"];
  }

  /** First `@db.writeOnly` field referenced by `$groupBy` / aggregate `$select`, or undefined. */
  private _findWriteOnlyInAggregate(
    groupBy: readonly string[],
    select: unknown,
  ): string | undefined {
    if (this._writeOnlySet.size === 0) return undefined;
    // A field hidden by `hasField` falls through to the gate's `Unknown field`.
    const sealed = (f: string) => this._writeOnlySet.has(f) && this.fieldVisibility.isVisible(f);
    for (const f of groupBy) {
      if (sealed(f)) return f;
    }
    if (Array.isArray(select)) {
      for (const item of select as unknown[]) {
        const field = typeof item === "string" ? item : (item as { $field?: string }).$field;
        if (field && sealed(field)) return field;
      }
    }
    return undefined;
  }

  /**
   * Merges the `$search` fallback into the filter: a case-insensitive literal
   * substring match OR'd across the `@db.column.searchable` fields, `$and`-combined
   * with the existing filter. Applies only when native search does not serve
   * the request (no native search, or — since 0.1.143 — its default index
   * reads a field {@link hasField} hides) and the request isn't a vector
   * search (`$vector` consumes the term).
   */
  protected applySearchFallback(
    filter: FilterExpr | undefined,
    controls: Record<string, unknown>,
  ): FilterExpr | undefined {
    const term = controls.$search as string | undefined;
    if (!term || controls.$vector !== undefined) return filter;
    if (this._nativeSearch(controls)) return filter;
    // Only fields visible to this request — a hidden field would turn the
    // term into a substring oracle over its values.
    const fields = this._searchFallbackFields.filter((f) => this.fieldVisibility.isVisible(f));
    if (fields.length === 0) return filter;
    const rx = `/${term.replace(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`)}/i`;
    const fragment = {
      $or: fields.map((f) => ({ [f]: { $regex: rx } })),
    } as FilterExpr;
    const base = nonEmptyFilter(filter);
    return base ? ({ $and: [base, fragment] } as FilterExpr) : fragment;
  }

  /**
   * The controls a grouped query hands to the adapter. `$search` has two
   * implementations and exactly one layer may consume it:
   *
   * - **native text search** — the adapter applies the term before grouping, so
   *   `$search` / `$index` ride through untouched.
   * - **no native search** — the term is this layer's to deal with, so the
   *   controls are dropped before dispatch; leaving them would make the core
   *   reject a query it has no way to run.
   *
   * Note the second case is deliberately broader than `applySearchFallback`:
   * that method only rewrites the term when `@db.column.searchable` fields
   * exist, whereas this drops the controls whenever the source is not natively
   * searchable. On a table with neither, the term is ignored — which is exactly
   * what the LEAF path already does for the same table (`_resolveReadStrategy`
   * falls through to `plain`). Rejecting here instead would make a grouped
   * query 400 where the leaf list happily returns rows: a new divergence, in
   * the same shape as the one this whole path exists to remove.
   */
  private _aggregateControls(controls: Record<string, unknown>): Record<string, unknown> {
    if (controls.$search === undefined || this._nativeSearch(controls)) {
      return controls;
    }
    const rest = { ...controls };
    delete rest.$search;
    delete rest.$index;
    return rest;
  }

  private async _resolveReadStrategy(
    controls: Record<string, unknown>,
  ): Promise<
    | { kind: "vector"; vector: number[]; vectorField: string }
    | { kind: "search"; term: string; index?: string }
    | { kind: "plain" }
  > {
    const searchTerm = controls.$search as string | undefined;
    const indexName = controls.$index as string | undefined;
    const vectorField = controls.$vector as string | undefined;
    if (vectorField !== undefined && searchTerm) {
      const vector = await this.computeEmbedding(searchTerm, vectorField || undefined);
      return { kind: "vector", vector, vectorField };
    }
    if (searchTerm && this._nativeSearch(controls)) {
      return { kind: "search", term: searchTerm, index: indexName };
    }
    return { kind: "plain" };
  }

  /**
   * Post-read row decoration hook. Not implemented by
   * default — defining it in a subclass switches it on. Runs once per
   * response on `/query`, `/pages`, `/geo` and `/one` (`/one/:id` and the
   * composite form), after `$actions` augmentation, with the final top-level
   * rows. Mutate the rows in place; the return value is ignored. May be async.
   *
   * Not called for `$count`, `$groupBy` aggregates, nested `$with` rows
   * (reach them through the parent row), a `/one` 404, or value-help
   * controllers.
   *
   * Convention (not enforced): name decoration keys with a `$` prefix, like
   * `$actions` and `$distance`, so they can never collide with a field name.
   * Do not overwrite `$actions` or `$disabledReasons`. Columns the
   * hook needs but the client did not select must be added in
   * {@link transformProjection} — they are then part of the response.
   *
   * ```ts
   * protected async decorateRows(rows: Record<string, unknown>[], ctx: TDbDecorateContext) {
   *   const unread = await countUnread(rows.map((r) => r.id))
   *   for (const row of rows) row.$unread = unread.get(row.id) ?? 0
   * }
   * ```
   *
   * @since 0.1.136
   */
  protected decorateRows?(
    rows: Record<string, unknown>[],
    ctx: TDbDecorateContext,
  ): void | Promise<void>;

  /**
   * Finishes a read's top-level rows in place: `$actions` augmentation (when
   * the request asked for it — `prep`; minus actions whose
   * {@link actionRowScope} a row misses), then {@link decorateRows} when a
   * subclass implements it. Returns the hook's result — `undefined`, with no
   * promise or microtask, when there is no hook or it is synchronous.
   */
  private _finishRows(
    rows: Record<string, unknown>[],
    prep: TAugmentationPrep | null,
    ctx: TDbDecorateContext,
  ): void | Promise<void> {
    const overlay = prep?.scopeOverlay;
    if (!prep || (!overlay && prep.delegations.length === 0)) {
      return this._augmentAndDecorate(rows, prep, ctx);
    }
    return (async () => {
      const names = prep.envelopes.map((e) => e.info.name);
      const [masks, delegated] = await Promise.all([
        overlay ? this._scopeMasks(rows, names, "rows", overlay) : undefined,
        Promise.all(prep.delegations.map((d) => this._delegatedRowVerdicts(rows, d))),
      ]);
      await this._augmentAndDecorate(rows, prep, ctx, masks, delegated);
    })();
  }

  /**
   * `$actions` augmentation (when `prep`) — own actions, then the delegated
   * ones (`delegated`: per delegation, per row) — then {@link decorateRows}
   * when implemented.
   */
  private _augmentAndDecorate(
    rows: Record<string, unknown>[],
    prep: TAugmentationPrep | null,
    ctx: TDbDecorateContext,
    outOfScope?: ReadonlyMap<string, readonly boolean[]>,
    delegated?: ReadonlyArray<ReadonlyArray<TDbAvailableActions | undefined>>,
  ): void | Promise<void> {
    if (prep) {
      augmentRowsWithActions({
        envelopes: prep.envelopes,
        rows,
        resolvedProjection: prep.resolvedProjection,
        gateFields: (e) => this._gateFields(e),
        outOfScope,
      });
      if (prep.delegations.length > 0) mergeDelegatedActions(rows, delegated ?? []);
    }
    return this._decorates ? this.decorateRows!(rows, ctx) : undefined;
  }

  // ── @DbActionsFrom (since 0.1.147) ─────────────────────────────────────

  /**
   * The app of the current event, through DI — never the one this
   * (singleton) instance was constructed in, which may be gone (a re-booted
   * app, a hot reload).
   */
  private _currentApp(): Promise<Moost> {
    return useControllerContext().instantiate(Moost) as Promise<Moost>;
  }

  /** The class's `@DbActionsFrom` delegations, validated on first use (per app). */
  private async _delegations(): Promise<readonly TDelegation[]> {
    if (!this._hasDelegations) return [];
    return discoverDelegations({
      ctor: this.constructor as Function,
      readable: this.readable,
      app: await this._currentApp(),
      logger: this.logger,
      instantiate: (ctor) => useControllerContext().instantiate(ctor as never),
    });
  }

  /**
   * The delegations this request may use: every id path visible
   * ({@link hasField}) and kept by {@link transformProjection} — a
   * delegation whose ids the request can't read is dropped.
   */
  private async _activeDelegations(): Promise<readonly TDelegation[]> {
    if (!this._hasDelegations) return [];
    const all = await this._delegations();
    const visible = all.filter((d) => d.paths.every((p) => this.fieldVisibility.isVisible(p)));
    if (visible.length === 0 || !this._hasProjectionHook) return visible;
    const paths = [...new Set(visible.flatMap((d) => d.paths))];
    const kept = this._resolveProjectionForAugmenter(await this.transformProjection(paths));
    if (kept === null) return visible;
    const keptSet = new Set(kept);
    return visible.filter((d) => d.paths.every((p) => keptSet.has(p)));
  }

  /**
   * Runs `fn` on the delegation's source controller (this event's instance)
   * evaluated as itself ({@link runAsController}); a 401 / 403 from its
   * `prepareRequest` (the caller holds no grant there) yields `refused`.
   */
  private async _onSource<R>(
    d: TDelegation,
    fn: (source: TDelegateSource) => Promise<R>,
    refused: R,
  ): Promise<R> {
    const source = (await useControllerContext().instantiate(d.source as never)) as TDelegateSource;
    try {
      return await runAsController(source, "availableActionsById", () => fn(source));
    } catch (error) {
      if (!isAuthRefusal(error)) throw error;
      this.logger.debug?.(`delegated actions of ${d.source.name} refused for this caller`);
      return refused;
    }
  }

  /** Per row, the source's verdict for the row it maps to (`undefined`: no source id). */
  private async _delegatedRowVerdicts(
    rows: readonly Record<string, unknown>[],
    d: TDelegation,
  ): Promise<Array<TDbAvailableActions | undefined>> {
    const { ids, index } = mapToSourceIds(rows, d.idMap);
    if (ids.length === 0) return rows.map(() => undefined);
    const verdicts = await this._onSource(
      d,
      (source) => source[ACTION_VERDICTS](ids, d.names),
      [] as Array<TDbAvailableActions | undefined>,
    );
    return index.map((i) => (i < 0 ? undefined : verdicts[i]));
  }

  /** The `/meta.actions` entries of the delegations the caller may run (per its source). */
  private async _delegatedInfos(): Promise<TDbActionInfo[]> {
    const delegations = await this._activeDelegations();
    const lists = await Promise.all(
      delegations.map(async (d) => {
        const allowed = new Set(
          await this._onSource(d, (source) => source[ALLOWED_ACTIONS](d.names), []),
        );
        return d.infos.filter((info) => allowed.has(info.name));
      }),
    );
    return lists.flat();
  }

  /**
   * The cached `/meta` envelope through {@link applyMetaOverlay}, plus —
   * since 0.1.147 — the `@DbActionsFrom` actions the caller may run as their
   * source decides (`allowedActions` of the source, evaluated as itself) and,
   * under an overridden {@link hasField}, the search surface narrowed to the
   * indexes the request may use (the index gate's rule). Delegated entries
   * never pass this controller's own `applyMetaOverlay`.
   */
  protected override resolveMeta(): TMetaResponse | Promise<TMetaResponse> {
    const own = super.resolveMeta();
    if (!this._hasDelegations && !this._hasFieldOverridden) return own;
    return (async () => {
      const [meta, delegated] = await Promise.all([
        own,
        this._hasDelegations ? this._delegatedInfos() : [],
      ]);
      const visible = this._applyIndexVisibility(meta);
      return delegated.length > 0
        ? { ...visible, actions: [...visible.actions, ...delegated] }
        : visible;
    })();
  }

  /**
   * The delegated part of `GET /meta/actions…` for the source ids `sourceIdOf`
   * derives from the request (`undefined`: not derivable by key renaming —
   * the delegation is left out).
   */
  private async _delegatedAvailable(
    own: TDbAvailableActions,
    sourceIdOf: (d: TDelegation) => Record<string, unknown> | undefined,
  ): Promise<TDbAvailableActions> {
    const delegations = await this._activeDelegations();
    const parts = await Promise.all(
      delegations.map(async (d) => {
        const id = sourceIdOf(d);
        if (id === undefined) return undefined;
        return this._onSource(d, (source) => source[AVAILABLE_ACTIONS](id, d.names), undefined);
      }),
    );
    let out = own;
    for (const part of parts) {
      if (!part || part.actions.length + Object.keys(part.disabledReasons ?? {}).length === 0) {
        continue;
      }
      const reasons = { ...out.disabledReasons, ...part.disabledReasons };
      out = { actions: [...out.actions, ...part.actions] };
      if (Object.keys(reasons).length > 0) out.disabledReasons = reasons;
    }
    return out;
  }

  /**
   * @internal Source side of a delegation: the `$actions` verdicts of `names`
   * for `ids` (aligned; `undefined` = not found under the row overlay), as
   * this controller's own `$actions` / `GET /meta/actions` compute them —
   * its `prepareRequest("availableActions")`, `allowedActions`, row overlay,
   * `actionRowScope` (`purpose: "rows"`) and `disabled`.
   */
  async [ACTION_VERDICTS](
    ids: Record<string, unknown>[],
    names: readonly string[],
  ): Promise<Array<TDbAvailableActions | undefined>> {
    await this.parseRequest("availableActions");
    const [envelopes, overlay] = await Promise.all([
      this._envelopesNamed(names),
      this.rowOverlay(),
    ]);
    if (envelopes.length === 0) return ids.map(() => ({ actions: [] }));
    const fieldsOf = envelopes.map((e) => this._gateFields(e));
    const select = new Set<string>(this.readable.preferredId);
    for (const fields of fieldsOf) for (const f of fields) select.add(f);
    const source = this.readable as unknown as TRowsByIdSource;
    const rows = await findRowsByIds(source, ids, overlay, select);
    const masks = await this._scopeMasks(
      rows,
      envelopes.map((e) => e.info.name),
      "rows",
      overlay,
    );
    return this._verdicts(envelopes, rows, masks, fieldsOf);
  }

  /** @internal Source side of a delegation: `GET /meta/actions` for one id, `names` only. */
  async [AVAILABLE_ACTIONS](
    id: Record<string, unknown>,
    names: readonly string[],
  ): Promise<TDbAvailableActions> {
    await this.parseRequest("availableActions");
    return this._availableActions(id, names);
  }

  /** @internal Source side of a delegation: the `names` the caller may run (`allowedActions`). */
  async [ALLOWED_ACTIONS](names: readonly string[]): Promise<readonly string[]> {
    await this.parseRequest("availableActions");
    const envelopes = await this._envelopesNamed(names);
    return envelopes.map((e) => e.info.name);
  }

  /** {@link _resolveAugmentEnvelopes} restricted to `names`. */
  private async _envelopesNamed(names: readonly string[]): Promise<TDbActionEnvelope[]> {
    const wanted = new Set(names);
    const all = await this._resolveAugmentEnvelopes();
    return (all ?? []).filter((e) => wanted.has(e.info.name));
  }

  /**
   * Shared `query` / `pages` / `geo` pipeline: prepare actions augmentation + read
   * strategy in parallel, pre-widen $select for `requiredFields`, run
   * `exec`, and augment `result.data` with `$actions` when the request set
   * `$actions=true`, then run {@link decorateRows}. Caller dispatches the
   * strategy to its read-method family (count vs no-count).
   */
  private async _runReadWithActions<R extends { data: unknown[] }>(
    endpoint: Exclude<TDbDecorateEndpoint, "one">,
    queryObj: Uniquery<any, any>,
    controls: Record<string, unknown>,
    select: UniqueryControls["$select"] | undefined,
    exec: (
      q: Uniquery<any, any>,
      strategy: Awaited<ReturnType<AsDbReadableController["_resolveReadStrategy"]>>,
    ) => Promise<R>,
  ): Promise<R> {
    const [prep, strategy] = await Promise.all([
      this._prepareAugmentation(controls, select),
      this._resolveReadStrategy(controls),
    ]);

    const initialQuery = prep?.widenedSelect
      ? ({
          ...queryObj,
          controls: { ...queryObj.controls, $select: prep.widenedSelect },
        } as Uniquery<any, any>)
      : queryObj;

    const result = await exec(initialQuery, strategy);
    const pending = this._finishRows(result.data as Record<string, unknown>[], prep, {
      endpoint,
      projection: select,
      controls,
    });
    if (pending) await pending;
    return result;
  }

  /**
   * The filter addressing exactly the ONE row `id` means — the readable's
   * PK-first `resolveRowFilter` (since 0.1.143) under this request's
   * identifications (`_idOpts`). `scope` (the row overlay) restricts which
   * rows count while the id is pinned, so a row outside it never shadows one
   * inside it. Readables without it (partial mocks) fall back to
   * `resolveIdFilter`.
   */
  protected resolveRowFilter(id: unknown, scope?: FilterExpr): Promise<FilterExpr | null> {
    const readable = this.readable;
    if (typeof (readable as Partial<typeof readable>).resolveRowFilter === "function") {
      return readable.resolveRowFilter(id, scope ? { ...this._idOpts, scope } : this._idOpts);
    }
    return Promise.resolve(readable.resolveIdFilter(id, this._idOpts));
  }

  /**
   * The ONE row `id` addresses, read with `controls`. A hidden unique key is
   * not an identification (since 0.1.134): the id resolves as if that index
   * did not exist. Since 0.1.143 it resolves primary key first, counting
   * only rows inside the overlay — an out-of-scope row never shadows an
   * in-scope one, so the answer is the same as if it did not exist — in one
   * step (`findOneByRow`). Readables without it (partial mocks) pin the row
   * with {@link resolveRowFilter}, then read it.
   */
  private async _findRow(
    id: unknown,
    overlay: FilterExpr | undefined,
    controls: Record<string, unknown>,
  ): Promise<DataType | null> {
    const readable = this.readable;
    if (typeof (readable as Partial<typeof readable>).findOneByRow === "function") {
      return (await readable.findOneByRow(id, {
        ...this._idOpts,
        scope: overlay,
        controls: controls as never,
      })) as DataType | null;
    }
    const idFilter = await this.resolveRowFilter(id, overlay);
    if (!idFilter) return null;
    return (await readable.findOne({
      filter: withOverlay(idFilter, overlay),
      controls,
    } as Uniquery<any, any>)) as DataType | null;
  }

  /**
   * The row overlay id-addressed endpoints (`/one`, `DELETE`) apply:
   * `transformOne({})` when non-empty, and only when a subclass overrides
   * {@link transformOne} / {@link transformFilter} — `undefined` otherwise,
   * at no cost (since 0.1.143).
   */
  protected async rowOverlay(): Promise<FilterExpr | undefined> {
    if (!this._hasRowOverlay) return undefined;
    return nonEmptyFilter(await this.transformOne({} as FilterExpr));
  }

  /**
   * Pick the first identification (PK or unique index) whose fields are all
   * present in the query. A unique index over a field {@link hasField} hides
   * is not a candidate (since 0.1.134) — `?hidden=x` answers exactly like
   * `?nope=x`, so it cannot probe whether a row with that value exists.
   */
  protected extractIdShape(query: Record<string, string>): Record<string, unknown> | HttpError {
    for (const id of this.idSource.identifications) {
      const idObj: Record<string, unknown> = {};
      let allPresent = true;
      for (const field of id.fields) {
        if (query[field] === undefined) {
          allPresent = false;
          break;
        }
        idObj[field] = query[field];
      }
      if (allPresent) return idObj;
    }

    return new HttpError(400, "Query params do not match any primary key or unique index");
  }

  // ── REST Endpoints (read-only) ──────────────────────────────────────────

  /**
   * **GET /query** — returns an array of records or a count.
   */
  @Get("query")
  async query(@Url() url: string): Promise<DataType[] | number | HttpError> {
    const { parsed, controls } = await this.parseRequest("query", url);

    const groupBy = controls.$groupBy as string[] | undefined;
    if (groupBy?.length && (controls.$with as unknown[])?.length) {
      return new HttpError(400, "Cannot combine $with and $groupBy in the same query");
    }
    // `$vector` consumes `$search` as an embedding and no adapter can group by
    // similarity. Rejecting beats the silent alternative, where the term falls
    // through to `$search` and is matched as ordinary text instead.
    if (groupBy?.length && controls.$vector !== undefined) {
      return new HttpError(400, "Cannot combine $vector and $groupBy in the same query");
    }

    // Aggregate and regular paths share validation: subclass `validateControls`
    // overrides (per-control auth) and `checkCapabilities` (field-level gate) must
    // apply to both. The base `validateControls` bypasses the DTO check when
    // `$groupBy` is present (aggregate `$select` shape doesn't fit the DTO).
    const error = this.validateParsed(parsed, "query");
    if (error) {
      return error;
    }

    if (groupBy?.length) {
      const sealed = this._findWriteOnlyInAggregate(groupBy, controls.$select);
      if (sealed) {
        return new HttpError(400, `Field "${sealed}" is @db.writeOnly and cannot be aggregated`);
      }
    }

    const gateError = this.checkCapabilities(parsed);
    if (gateError) {
      return gateError;
    }
    const clientFilter = await this._relationOverlay(parsed);

    // ── Aggregate path ──────────────────────────────────────────────
    if (groupBy?.length) {
      const filter = this.applySearchFallback(await this.transformFilter(clientFilter), controls);
      return this.readable.aggregate({
        filter,
        controls: this._aggregateControls(controls) as any,
        insights: parsed.insights,
      }) as Promise<any>;
    }

    // ── Regular query path ──────────────────────────────────────────

    const [transformedFilter, transformedSelect] = await Promise.all([
      this.transformFilter(clientFilter),
      this.transformProjection(controls.$select as UniqueryControls["$select"]),
    ]);
    const filter = this.applySearchFallback(transformedFilter, controls);
    const sealed = this._sealControls(controls, transformedSelect);

    if (controls.$count) {
      return this.readable.count({
        filter,
        controls: { ...controls, $select: sealed.$select },
      } as Uniquery<any, any>);
    }

    const select = this.widenPreferredIdProjection(sealed.$select);
    if (select instanceof HttpError) {
      return select;
    }

    const threshold = controls.$threshold ? Number(controls.$threshold) : undefined;

    const queryObj = {
      filter,
      controls: {
        ...sealed,
        $select: select,
        $limit: (controls.$limit as number | undefined) || 1000,
        $threshold: threshold,
      },
    } as Uniquery<any, any>;

    const wrapped = await this._runReadWithActions(
      "query",
      queryObj,
      controls,
      select,
      async (q, strategy): Promise<{ data: DataType[] }> => {
        switch (strategy.kind) {
          case "vector":
            return {
              data: (await (strategy.vectorField
                ? this.readable.vectorSearch(strategy.vectorField, strategy.vector, q)
                : this.readable.vectorSearch(strategy.vector, q))) as DataType[],
            };
          case "search":
            return {
              data: (await this.readable.search(strategy.term, q, strategy.index)) as DataType[],
            };
          case "plain":
            return { data: (await this.readable.findMany(q)) as DataType[] };
        }
      },
    );
    return wrapped.data;
  }

  /**
   * **GET /pages** — returns paginated records with metadata.
   */
  @Get("pages")
  async pages(@Url() url: string): Promise<
    | {
        data: DataType[];
        page: number;
        itemsPerPage: number;
        pages: number;
        count: number;
      }
    | HttpError
  > {
    const { parsed, controls } = await this.parseRequest("pages", url);

    const error = this.validateParsed(parsed, "pages");
    if (error) {
      return error;
    }

    const gateError = this.checkCapabilities(parsed);
    if (gateError) {
      return gateError;
    }
    const clientFilter = await this._relationOverlay(parsed);
    const page = Math.max(Number(controls.$page || 1), 1);
    const size = Math.max(Number(controls.$size || 10), 1);
    const skip = (page - 1) * size;

    const [transformedFilter, transformedSelect] = await Promise.all([
      this.transformFilter(clientFilter),
      this.transformProjection(controls.$select as UniqueryControls["$select"]),
    ]);
    const filter = this.applySearchFallback(transformedFilter, controls);
    const sealed = this._sealControls(controls, transformedSelect);
    const select = this.widenPreferredIdProjection(sealed.$select);
    if (select instanceof HttpError) {
      return select;
    }

    const threshold = controls.$threshold ? Number(controls.$threshold) : undefined;

    const query = {
      filter,
      controls: {
        ...sealed,
        $select: select,
        $skip: skip,
        $limit: size,
        $threshold: threshold,
      },
    };

    const result = await this._runReadWithActions(
      "pages",
      query as Uniquery<any, any>,
      controls,
      select,
      async (q, strategy): Promise<{ data: DataType[]; count: number }> => {
        switch (strategy.kind) {
          case "vector":
            return (
              strategy.vectorField
                ? this.readable.vectorSearchWithCount(strategy.vectorField, strategy.vector, q)
                : this.readable.vectorSearchWithCount(strategy.vector, q)
            ) as Promise<{ data: DataType[]; count: number }>;
          case "search":
            return this.readable.searchWithCount(strategy.term, q, strategy.index) as Promise<{
              data: DataType[];
              count: number;
            }>;
          case "plain":
            return this.readable.findManyWithCount(q) as Promise<{
              data: DataType[];
              count: number;
            }>;
        }
      },
    );

    return {
      data: result.data,
      page,
      itemsPerPage: size,
      pages: Math.ceil(result.count / size),
      count: result.count,
    };
  }

  /**
   * **GET /geo** — distance-ranked geospatial search (mirrors the search /
   * vector read endpoints; geo-index spec §7).
   *
   * URL controls: `$center=lng,lat` (required), `$maxDistance` / `$minDistance`
   * (meters), `$index` (geo index name), plus the standard filter / `$select` /
   * `$with` / pagination syntax. Each row carries a computed `$distance`
   * (meters). With `$page` / `$size` the response is the `/pages` envelope;
   * otherwise a plain row array (`$skip` / `$limit` compose). Since 0.1.143
   * the controls pass {@link validateParsed} (type `"geo"`) like `/query`'s,
   * and the geo index must read only fields {@link hasField} shows.
   */
  @Get("geo")
  async geo(
    @Url() url: string,
  ): Promise<
    | DataType[]
    | { data: DataType[]; page: number; itemsPerPage: number; pages: number; count: number }
    | HttpError
  > {
    const { parsed, controls } = await this.parseRequest("geo", url);

    const point = this._parseGeoCenter(controls.$center);
    if (point instanceof HttpError) {
      return point;
    }
    for (const key of ["$maxDistance", "$minDistance"] as const) {
      if (controls[key] !== undefined) {
        const num = Number(controls[key]);
        if (!Number.isFinite(num) || num < 0) {
          return new HttpError(400, `${key} must be a non-negative number of meters`);
        }
        controls[key] = num;
      }
    }
    const indexName = typeof controls.$index === "string" ? controls.$index : undefined;

    // Same pipeline as `/query` (since 0.1.143 — `/geo` used to skip the
    // controls DTO / `validateControls` and the `$with` relation check).
    const error = this.validateParsed(parsed, "geo");
    if (error) {
      return error;
    }
    const gateError = this.checkCapabilities(parsed);
    if (gateError) {
      return gateError;
    }
    const clientFilter = await this._relationOverlay(parsed);

    const [filter, transformedSelect] = await Promise.all([
      this.transformFilter(clientFilter),
      this.transformProjection(controls.$select as UniqueryControls["$select"]),
    ]);
    const sealed = this._sealControls(controls, transformedSelect);
    const select = this.widenPreferredIdProjection(sealed.$select);
    if (select instanceof HttpError) {
      return select;
    }

    const paginated = controls.$page !== undefined || controls.$size !== undefined;
    const page = Math.max(Number(controls.$page || 1), 1);
    const size = Math.max(Number(controls.$size || 10), 1);

    const queryObj = {
      filter,
      controls: {
        ...sealed,
        $center: undefined,
        $index: undefined,
        $select: select,
        ...(paginated
          ? { $skip: (page - 1) * size, $limit: size }
          : { $limit: (controls.$limit as number | undefined) || 1000 }),
      },
    } as Uniquery<any, any>;

    if (paginated) {
      const result = await this._runReadWithActions(
        "geo",
        queryObj,
        controls,
        select,
        async (q): Promise<{ data: DataType[]; count: number }> =>
          (indexName
            ? this.readable.geoSearchWithCount(indexName, point, q)
            : this.readable.geoSearchWithCount(point, q)) as Promise<{
            data: DataType[];
            count: number;
          }>,
      );
      return {
        data: result.data,
        page,
        itemsPerPage: size,
        pages: Math.ceil(result.count / size),
        count: result.count,
      };
    }

    const wrapped = await this._runReadWithActions(
      "geo",
      queryObj,
      controls,
      select,
      async (q): Promise<{ data: DataType[] }> => ({
        data: (await (indexName
          ? this.readable.geoSearch(indexName, point, q)
          : this.readable.geoSearch(point, q))) as DataType[],
      }),
    );
    return wrapped.data;
  }

  /** Parses the `$center` control: `"lng,lat"` string (or tuple) → `[number, number]`. */
  private _parseGeoCenter(raw: unknown): [number, number] | HttpError {
    let lng: number | undefined;
    let lat: number | undefined;
    if (typeof raw === "string") {
      const parts = raw.split(",");
      if (parts.length === 2) {
        lng = Number(parts[0]);
        lat = Number(parts[1]);
      }
    } else if (Array.isArray(raw) && raw.length === 2) {
      lng = Number(raw[0]);
      lat = Number(raw[1]);
    }
    if (lng === undefined || lat === undefined || !Number.isFinite(lng) || !Number.isFinite(lat)) {
      return new HttpError(400, "$center is required: $center=lng,lat (GeoJSON order)");
    }
    return [lng, lat];
  }

  /**
   * **GET /one/:id** — retrieves a single record by ID or unique property.
   * The id-filter is AND-combined with {@link transformOne} so row-level
   * read overlays gate `/one` symmetrically with `/query` / `/pages`.
   */
  @Get("one/:id")
  async getOne(@Param("id") id: string, @Url() url: string): Promise<DataType | HttpError> {
    const { parsed, controls, hasNonControl } = await this.parseRequest("one", url);
    if (hasNonControl) {
      return new HttpError(400, 'Filtering is not allowed for "one" endpoint');
    }
    return this._readOne(id, parsed, controls);
  }

  /**
   * **GET /one?field1=val1&field2=val2** — retrieves a single record by composite key
   * (composite primary key or compound unique index). Same `transformOne`
   * gating as {@link getOne}.
   */
  @Get("one")
  async getOneComposite(
    @Query() query: Record<string, string>,
    @Url() url: string,
  ): Promise<DataType | HttpError> {
    const { parsed, controls } = await this.parseRequest("one", url);
    // After `prepareRequest`: the identifications consult `hasField`.
    const idObj = this.extractIdShape(query);
    if (idObj instanceof HttpError) {
      return idObj;
    }
    return this._readOne(idObj, parsed, controls);
  }

  /**
   * The shared `/one` pipeline: validation + capability gate (since 0.1.128
   * on the composite form too — an unknown `$select` path used to reach the
   * driver there), the sealed projection, the row read and its augmentation.
   */
  private async _readOne(
    id: string | Record<string, unknown>,
    parsed: Uniquery,
    controls: Record<string, unknown>,
  ): Promise<DataType | HttpError> {
    const error = this.validateParsed(parsed, "getOne") ?? this.checkCapabilities(parsed);
    if (error) {
      return error;
    }
    // `/one` takes no filter; its `$with` sub-filters may carry predicates.
    await this._relationOverlay(parsed);
    const sealed = this._sealControls(
      controls,
      await this.transformProjection(controls.$select as UniqueryControls["$select"]),
    );
    const select = this.widenPreferredIdProjection(sealed.$select);
    if (select instanceof HttpError) {
      return select;
    }

    const [prep, overlay] = await Promise.all([
      this._prepareAugmentation(controls, select),
      this.rowOverlay(),
    ]);
    const readControls = { ...sealed, $select: prep?.widenedSelect ?? select };

    const item = await this.returnOne(this._findRow(id, overlay, readControls));
    if (item instanceof HttpError) return item;
    const pending = this._finishRows([item as unknown as Record<string, unknown>], prep, {
      endpoint: "one",
      projection: select,
      controls,
    });
    if (pending) await pending;
    return item;
  }

  /**
   * **GET /meta/actions/:id** — the row-level actions the caller may run on
   * the row `id` addresses (the `/one/:id` id forms), as
   * `{ actions, disabledReasons? }` — no row data (since 0.1.145). Exactly
   * what calling each action would do: the action survives
   * {@link applyMetaOverlay}, the row resolves under its gate overlay
   * ({@link actionOverlay}) and its `disabled` rule passes on the fields the
   * gate loads. Needs no read grant; an unknown or out-of-scope id answers
   * `{ actions: [] }`. {@link prepareRequest} runs first with
   * `endpoint: "availableActions"`.
   */
  @Get("meta/actions/:id")
  @DbEndpoint("availableActions")
  async availableActionsById(@Param("id") id: string): Promise<TDbAvailableActions> {
    await this.parseRequest("availableActions");
    const own = await this._availableActions(id);
    if (!this._hasDelegations) return own;
    // `@DbActionsFrom`: the source id is this id renamed — only when the
    // delegation maps every source field from the single-field preferredId.
    const preferred = this.readable.preferredId;
    return this._delegatedAvailable(own, (d) =>
      preferred.length === 1 && d.paths.every((p) => p === preferred[0])
        ? Object.fromEntries(Object.keys(d.idMap).map((f) => [f, id]))
        : undefined,
    );
  }

  /**
   * **GET /meta/actions?field1=val1&…** — {@link availableActionsById} by
   * composite key (composite primary key or compound unique index), the
   * `/one?…` rules.
   */
  @Get("meta/actions")
  @DbEndpoint("availableActions")
  async availableActions(
    @Query() query: Record<string, string>,
  ): Promise<TDbAvailableActions | HttpError> {
    await this.parseRequest("availableActions");
    const idObj = this.extractIdShape(query);
    const sourceIdOf = (d: TDelegation): Record<string, unknown> | undefined =>
      d.paths.every((p) => query[p] !== undefined)
        ? Object.fromEntries(Object.entries(d.idMap).map(([f, p]) => [f, query[p]]))
        : undefined;
    if (idObj instanceof HttpError) {
      // `@DbActionsFrom`: the query may still name a source id by renaming.
      const delegations = await this._activeDelegations();
      if (!delegations.some((d) => sourceIdOf(d) !== undefined)) return idObj;
      return this._delegatedAvailable({ actions: [] }, sourceIdOf);
    }
    const own = await this._availableActions(idObj);
    return this._hasDelegations ? this._delegatedAvailable(own, sourceIdOf) : own;
  }

  /**
   * **POST /delegated-actions/:name** — a query target for a `@DbActionsFrom`
   * action whose source action declares `queryTarget` (since 0.1.147); the
   * action's `/meta` entry points here (`queryTarget.url`). Body
   * `{ query: { q, exclude?, expectCount?, maxRows?, dryRun? }, input? }`.
   *
   * The source must list the action for the caller (its `allowedActions`,
   * as `$actions` does) — else 403, dry runs included. This controller then
   * resolves the rows matching `q` under its own read scope (`transformFilter`
   * ∧ {@link queryTargetScope} ∧ ¬`exclude` — `exclude` entries use this
   * controller's identifications or the delegation's id paths, and the
   * source rows they map to are left out even when other view rows map to
   * them too), maps them to source ids (a row without one is skipped as
   * `"unmapped"`), then runs the SOURCE's action route on them in batches
   * inside this request (`MoostHttp.invoke`) — its guards, `prepareRequest`,
   * row overlay, `actionRowScope` and `disabled` re-check every batch, and
   * every body reader of the source sees the batch's `{ ids, input }`. Before
   * each batch the view rows are re-checked against the target: a source id
   * none of whose view rows still matches is skipped as `"stale"`; ids the
   * source's gate refuses are skipped with their reasons. A batch failing
   * once a source handler started (in it or an earlier batch) stops the run:
   * the answer is the partial summary with `aborted` and every id not run
   * listed in `failed`. A failure before any source handler started (a 403,
   * the source's `@InputForm` 400, …) is the request's error — nothing ran,
   * and every batch carries the same `input`. The
   * `message` (string) each batch's handler returned is passed on:
   * `messages` per batch, `message` the distinct ones joined by newlines. A
   * dry run answers `{ matched }`; otherwise the answer is the run's
   * {@link TDbActionTargetSummary}. An action of the delegation that takes no
   * query target answers 400 `TARGET_INVALID`. `prepareRequest` runs first
   * with `endpoint: "delegatedAction"`. Registered only on controllers
   * declaring `@DbActionsFrom`.
   */
  async runDelegatedOnQuery(): Promise<TDbActionTargetSummary | { matched: number }> {
    const name = useRouteParams<{ name: string }>().get("name");
    if (!this._hasDelegations) throw new HttpError(404, `Unknown action "${name}"`);
    if (typeof this.prepareRequest === "function") {
      await this.prepareRequest({ endpoint: "delegatedAction", action: name });
    }
    const active = await this._activeDelegations();
    const delegation = active.find((d) => d.queryTargets.has(name));
    if (!delegation) {
      if (active.some((d) => d.names.includes(name))) {
        throw targetInvalid(name, `Action "${name}" does not accept a query target`);
      }
      throw new HttpError(404, `Unknown action "${name}"`);
    }
    const limits = delegation.queryTargets.get(name)!;
    const raw = await useBody(current()).parseBody<unknown>();
    const env = (raw ?? {}) as { ids?: unknown; input?: unknown; query?: unknown };
    if (typeof env !== "object" || Array.isArray(env)) {
      throw targetInvalid(name, "Action body must be an object of shape { query, input? }");
    }
    if (env.ids !== undefined) {
      throw targetInvalid(
        name,
        "This route takes a `query` — post `ids` to the action's own route",
      );
    }
    if (env.query === undefined) throw targetInvalid(name, "`query` is required");

    // The source decides first whether the caller may run the action at all.
    const allowed = await this._onSource(
      delegation,
      (source) => source[ALLOWED_ACTIONS]([name]),
      [] as readonly string[],
    );
    if (!allowed.includes(name)) {
      throw new HttpError(403, `Action "${name}" is not allowed`);
    }

    const viewIds = this.readable.preferredId;
    const identity = viewIds.length > 0 ? viewIds : delegation.paths;
    const resolved = await this[RESOLVE_TARGET]({
      action: name,
      query: env.query,
      cap: limits.maxRows,
      maxExclude: limits.maxIds,
      overlay: "read",
      select: [...new Set([...identity, ...delegation.paths])],
      excludeShapes: [delegation.paths],
    });
    if (resolved.dryRun) return { matched: resolved.matched };

    const summary: TDbActionTargetSummary = {
      matched: resolved.matched,
      processed: 0,
      skipped: [],
      failed: [],
    };
    const { ids, index } = mapToSourceIds(resolved.rows, delegation.idMap);
    const visibleIdentity = identity.filter((f) => this.fieldVisibility.isVisible(f));
    for (let i = 0; i < index.length; i++) {
      if (index[i] >= 0) continue;
      const row = resolved.rows[i];
      summary.skipped.push({
        id: Object.fromEntries(visibleIdentity.map((f) => [f, row[f]])),
        reason: "unmapped",
      });
    }
    const excluded = await this._excludedSourceKeys(resolved.exclude, delegation);
    const fields = Object.keys(delegation.idMap).toSorted();
    const queue = ids.filter((id) => !excluded.has(idKey(id, fields)!));

    const http = (await useControllerContext().instantiate(MoostHttp)) as MoostHttp;
    const batchSize = Math.max(1, Math.min(limits.batchSize, limits.maxIds));
    let ran = false;
    const messages: string[] = [];
    for (let start = 0; start < queue.length; start += batchSize) {
      const batch = await this._stillTargeted(
        resolved,
        delegation,
        queue.slice(start, start + batchSize),
        summary,
      );
      if (batch.length === 0) continue;
      const outcome = await runSourceActionBatch(http, limits.route, batch, env.input);
      if (outcome.message !== undefined) messages.push(outcome.message);
      summary.processed += outcome.processed;
      summary.skipped.push(...outcome.skipped);
      summary.failed.push(...outcome.failed);
      if (outcome.error === undefined && outcome.aborted === undefined) {
        ran ||= outcome.ran;
        continue;
      }
      if (outcome.error === undefined) {
        // The source answered its own partial summary (merged above).
        summary.aborted = outcome.aborted;
      } else {
        // No source handler started yet: the request fails as the source failed it.
        if (!ran && !outcome.ran) throw outcome.error;
        const reason = errorMessage(outcome.error);
        for (const id of outcome.pending ?? []) summary.failed.push({ id, reason });
        summary.aborted = { status: errorStatus(outcome.error), message: reason };
      }
      for (const id of queue.slice(start + batchSize)) {
        summary.failed.push({ id, reason: "not run" });
      }
      break;
    }
    if (messages.length > 0) {
      summary.messages = messages;
      summary.message = [...new Set(messages)].join("\n");
    }
    return summary;
  }

  /**
   * The id keys (`idMap` fields) of the source rows `exclude` leaves out of a
   * delegated target — an entry by the id paths names its source row
   * directly; one by a view identification names the source row of that view
   * row (read without overlay: excluding can only narrow the run).
   */
  private async _excludedSourceKeys(
    exclude: readonly Record<string, unknown>[],
    d: TDelegation,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    if (exclude.length === 0) return out;
    const fields = Object.keys(d.idMap).toSorted();
    const paths = new Set(d.paths);
    const byView: Record<string, unknown>[] = [];
    const add = (rows: readonly Record<string, unknown>[]) => {
      for (const id of mapToSourceIds(rows, d.idMap).ids) out.add(idKey(id, fields)!);
    };
    const direct: Record<string, unknown>[] = [];
    for (const entry of exclude) {
      const keys = Object.keys(entry);
      if (keys.length === paths.size && keys.every((k) => paths.has(k))) direct.push(entry);
      else byView.push(entry);
    }
    add(direct);
    if (byView.length > 0) {
      const rows = await findRowsByIds(
        this.readable as unknown as TRowsByIdSource,
        byView,
        undefined,
        d.paths,
      );
      add(rows.filter((r): r is Record<string, unknown> => r !== undefined));
    }
    return out;
  }

  /**
   * The source ids of `batch` that some view row still maps to under the
   * target's query (phase-2 re-check); the others are recorded in
   * `summary.skipped` as `"stale"`.
   */
  private async _stillTargeted(
    resolved: TResolvedTarget,
    d: TDelegation,
    batch: Record<string, unknown>[],
    summary: TDbActionTargetSummary,
  ): Promise<Record<string, unknown>[]> {
    const keys = batch.map((id) =>
      Object.fromEntries(Object.entries(d.idMap).map(([field, path]) => [path, id[field]])),
    );
    const still = await resolved.load(keys, d.paths);
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < batch.length; i++) {
      if (still[i]) out.push(batch[i]);
      else summary.skipped.push({ id: batch[i], reason: "stale" });
    }
    return out;
  }

  /**
   * The row resolves ONCE, like `/one/:id` under {@link rowOverlay}; scoped
   * actions are then checked on it (`purpose: "available"`) exactly like
   * `$actions` rows.
   */
  private async _availableActions(
    id: unknown,
    names?: readonly string[],
  ): Promise<TDbAvailableActions> {
    const [envelopes, overlay] = await Promise.all([
      names ? this._envelopesNamed(names) : this._resolveAugmentEnvelopes(),
      this.rowOverlay(),
    ]);
    if (!envelopes?.length) return { actions: [] };
    const idKeys = id !== null && typeof id === "object" ? Object.keys(id) : [];
    const fieldsOf = envelopes.map((e) => {
      const fields = this._gateFields(e);
      return idKeys.every((k) => fields.has(k)) ? fields : new Set([...fields, ...idKeys]);
    });
    const select = new Set<string>(this.readable.preferredId);
    for (const fields of fieldsOf) for (const f of fields) select.add(f);
    const row = (await this._findRow(id, overlay, { $select: [...select] })) as Record<
      string,
      unknown
    > | null;
    if (!row) return { actions: [] };
    const masks = await this._scopeMasks(
      [row],
      envelopes.map((e) => e.info.name),
      "available",
      overlay,
    );
    return this._verdicts(envelopes, [row], masks, fieldsOf)[0]!;
  }

  /**
   * Per row (`undefined` = not found → no verdict): the actions of
   * `envelopes` it lists — minus those `masks` put it outside of, and those
   * whose `disabled` rule refuses it on the fields its gate loads
   * (`fieldsOf`, parallel to `envelopes`) — with the refusal reasons.
   */
  private _verdicts(
    envelopes: readonly TDbActionEnvelope[],
    rows: readonly (Record<string, unknown> | undefined)[],
    masks: ReadonlyMap<string, readonly boolean[]> | undefined,
    fieldsOf: readonly ReadonlySet<string>[],
  ): Array<TDbAvailableActions | undefined> {
    const present: Record<string, unknown>[] = [];
    for (const row of rows) if (row) present.push(row);
    // One predicate call per action over every present row (batch shape).
    const verdicts = envelopes.map((e, i) => {
      const disabled = getCandidate(e)?.disabledFn;
      return disabled && present.length > 0
        ? judgeRows(
            e.info.name,
            disabled,
            present.map((row) => projectRow(row, fieldsOf[i])),
          )
        : undefined;
    });
    let p = 0;
    return rows.map((row, r) => {
      if (!row) return undefined;
      const at = p++;
      const actions: string[] = [];
      let disabledReasons: Record<string, string> | undefined;
      for (let i = 0; i < envelopes.length; i++) {
        const name = envelopes[i].info.name;
        if (masks?.get(name)?.[r]) continue;
        const verdict = verdicts[i]?.[at];
        if (!verdict) {
          actions.push(name);
          continue;
        }
        const reason = verdictReason(verdict);
        if (reason !== undefined) (disabledReasons ??= {})[name] = reason;
      }
      return disabledReasons ? { actions, disabledReasons } : { actions };
    });
  }

  /**
   * **GET /meta** — returns table/view metadata for UI.
   *
   * Overrides the base's minimal envelope to add relations, searchable flags,
   * vector-searchable flags, field-descriptor-derived filter/sort hints, and
   * the configured primary keys.
   */
  protected override buildMetaResponse(): TMetaResponse {
    const relations: TMetaResponse["relations"] = [];
    for (const [name, rel] of this.readable.relations) {
      relations.push({
        name,
        direction: rel.direction,
        isArray: rel.isArray,
        // Clients may filter by related rows (`nav=$some(…)`) — since 0.1.147.
        ...(rel.filterable === true && { filterable: true as const }),
      });
    }

    // Physical column names carrying a @db.index.geo index → `geo: true` flag.
    const geoIndexedPhysical = new Set<string>();
    if (this.readable.indexes instanceof Map) {
      for (const index of this.readable.indexes.values()) {
        if (index.type === "geo") {
          for (const f of index.fields) geoIndexedPhysical.add(f.name);
        }
      }
    }

    // `/meta.fields` is a projection of the capability index — the same
    // object the request gate reads — so `sortable: true` ⇔ `$sort` accepted
    // and `filterable: true` ⇔ filter accepted, per adapter, mode and field
    // kind. Nested-object parents and navigation paths are never listed.
    const capabilities = this.capabilities;
    const fields: TMetaResponse["fields"] = {};
    for (const [path, cap, fd] of capabilities.entries()) {
      const entry: TFieldMeta = { sortable: cap.sortable, filterable: cap.filterable };
      if (cap.filterOps) {
        // `filterable: false`, yet these narrower predicates pass the gate
        // (e.g. `$exists` on a relational adapter's JSON column).
        entry.filterOps = [...cap.filterOps];
      }
      if (cap.indexed) {
        // Advisory hint (prefer cheap sort keys) — never affects acceptance.
        entry.indexed = true;
      }
      if (fd.encrypted) {
        // At-rest protection marker: filterable/sortable are already vetoed
        // in the index; UIs use this to render a lock indicator.
        entry.encrypted = true;
      }
      if (geoIndexedPhysical.has(fd.physicalName)) {
        entry.geo = true;
      }
      if (this._writeOnlySet.has(path)) {
        // Settable in writes, never present in reads — UIs render a set-only
        // input; filter/sort are vetoed in the index regardless of annotations.
        entry.writeOnly = true;
      }
      if (cap.bucketable) {
        // Exactly when the gate accepts a calendar bucket over this field.
        entry.bucketable = true;
      }
      if (fd.derived) {
        // Computed from a @db.json leaf of the row; a write payload value is
        // dropped — UIs render it read-only.
        entry.derived = true;
      }
      if (fd.computed) {
        // A computed view column (@db.compute) — advisory; sort / filter
        // follow the column's normal capability.
        entry.computed = true;
      }
      fields[path] = entry;
    }

    return {
      // Native search OR the @db.column.searchable fallback — either way the
      // UI's search box works, so /meta reports it uniformly.
      searchable: this.readable.isSearchable() || this._searchFallbackFields.length > 0,
      vectorSearchable: this.readable.isVectorSearchable(),
      geoSearchable: this._isGeoSearchable(),
      // `fields` is server-side gating data (index gate, permission overlays) —
      // never on the wire, where it would name columns the caller cannot see.
      searchIndexes: this.readable.getSearchIndexes().map(({ fields: _fields, ...index }) => index),
      primaryKeys: [...this.readable.primaryKeys],
      preferredId: [...this.readable.preferredId],
      relations,
      fields,
      type: this.getSerializedType(),
      actions: this.buildActions(),
      crud: this.buildCrud(),
      // OCC pointer (§6.1 of VERSION_PROPOSAL.md). `undefined` for tables
      // without `@db.column.version` — clients use this to decide whether
      // to round-trip the version field and how to render it.
      versionColumn: this.readable.versionColumn,
      // Calendar-bucket units (`bucket(field,unit,…)` in an aggregate `$select`); omitted when none.
      ...(capabilities.bucketUnits.length > 0 && { bucketUnits: [...capabilities.bucketUnits] }),
      // Aggregate functions the adapter renders.
      aggregateFns: [...capabilities.aggregateFns],
    };
  }

  protected override buildCrud(): TCrudPermissions {
    return {
      ...super.buildCrud(),
      query: [...QUERY_CONTROLS],
      pages: [...PAGES_CONTROLS],
      one: [...ONE_CONTROLS],
      ...(this._isGeoSearchable() ? { geo: [...GEO_CONTROLS] } : {}),
    };
  }

  /** Adapter supports geo search AND the table declares at least one geo index. */
  private _isGeoSearchable(): boolean {
    if (typeof this.readable.isGeoSearchable !== "function" || !this.readable.isGeoSearchable()) {
      return false;
    }
    if (!(this.readable.indexes instanceof Map)) {
      return false;
    }
    for (const index of this.readable.indexes.values()) {
      if (index.type === "geo") return true;
    }
    return false;
  }
}

/**
 * Appends each row's delegated verdicts (`delegated`: per delegation, per
 * row) to its `$actions` / `$disabledReasons`; every row gets `$actions`.
 */
function mergeDelegatedActions(
  rows: Record<string, unknown>[],
  delegated: ReadonlyArray<ReadonlyArray<TDbAvailableActions | undefined>>,
): void {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const actions = [...((row.$actions as string[] | undefined) ?? [])];
    let reasons = row.$disabledReasons as Record<string, string> | undefined;
    for (const verdicts of delegated) {
      const verdict = verdicts[i];
      if (!verdict) continue;
      actions.push(...verdict.actions);
      if (verdict.disabledReasons) reasons = Object.assign(reasons ?? {}, verdict.disabledReasons);
    }
    row.$actions = actions;
    if (reasons) row.$disabledReasons = reasons;
  }
}

// Self-register so action discovery's static check
// (`isAsDbReadableControllerSubclass`) and the gate interceptor's runtime
// `instanceof` probe can find this class without forming an import cycle
// through the actions module.
registerAsDbReadableController(AsDbReadableController);
