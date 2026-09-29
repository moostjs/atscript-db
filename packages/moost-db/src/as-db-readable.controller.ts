import { type TAtscriptAnnotatedType, type TAtscriptDataType } from "@atscript/typescript/utils";
import type {
  AtscriptDbReadable,
  FilterExpr,
  TCrudPermissions,
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
  checkHavingKeys,
  collectQueryPaths,
  geoIndexNotFoundMessage,
  isEmptyObject,
  normalizeComputedSelect,
  searchIndexNotFoundMessage,
  selfOrAncestor,
  unsupportedOperatorMessage,
  vectorIndexNotFoundMessage,
} from "@atscript/db";
import { Get, HttpError, Query, Url } from "@moostjs/event-http";
import { Inherit, Inject, Moost, Optional, Param } from "moost";

import { registerAsDbReadableController } from "./actions/controller-registry";
import type { IdValidationSource } from "./actions/id-validation";
import { discoverRowLevelActions, type TDbActionEnvelope } from "./actions/discover";
import { augmentRowsWithActions } from "./actions/list-augmenter";
import { withOverlay } from "./actions/row-scope";
import { AsReadableController, type TDbControlsType } from "./as-readable.controller";
import { READABLE_DEF, resolveBoundReadable } from "./decorators";
import { FieldCapabilityIndex, writeOnlyVerdict } from "./meta/field-capabilities";
import { unknownRelationError } from "./http-errors";
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
   * (a derived copy must not outlive a hidden source).
   */
  readonly isVisible: (path: string) => boolean;
  /**
   * The paths sealed out of `readable`'s read projection for this request:
   * its `@db.writeOnly` fields plus, when {@link scoped}, its derived fields
   * whose source `hasField` hides. `prefix` is `readable`'s path from the
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

/** What `$actions` augmentation of a read needs, prepared before the read runs. */
interface TAugmentationPrep {
  envelopes: readonly TDbActionEnvelope[];
  resolvedProjection: string[] | null;
  widenedSelect: string[] | null;
}

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
  /** `@db.column.derived` path → its source's logical path, per readable (bound + `$with` targets). */
  private readonly _derivedSources = new WeakMap<object, ReadonlyMap<string, string>>();
  /** The bound readable's entry of {@link _derivedSources}. */
  private readonly _derivedSource: ReadonlyMap<string, string>;
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
    this._writeOnlySet = this._collectAnnotated("db.writeOnly");
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
    const scoped = this.hasField !== proto.hasField;
    this._hasFieldOverridden = scoped;
    const isVisible = (path: string): boolean => {
      if (!this.hasField(path)) return false;
      const source = scoped ? this._derivedSource.get(path) : undefined;
      return source === undefined || this.hasField(source);
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

  /** `readable`'s `@db.column.derived` path → source path map, collected once per readable. */
  private _derivedSourcesOf(readable: AtscriptDbReadable<any>): ReadonlyMap<string, string> {
    let map = this._derivedSources.get(readable);
    if (!map) {
      const out = new Map<string, string>();
      for (const fd of readable.fieldDescriptors ?? []) {
        if (fd.derived?.sourcePath) out.set(fd.path, fd.derived.sourcePath);
      }
      map = out;
      this._derivedSources.set(readable, map);
    }
    return map;
  }

  private _collectAnnotated(annotation: string): Set<string> {
    const out = new Set<string>();
    for (const [path, entry] of this.readable.flatMap) {
      if (entry?.metadata?.has?.(annotation)) out.add(path);
    }
    return out;
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
   * for the request, like a `@db.writeOnly` field.
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
    for (const { path, predicate } of refs.filter) {
      const verdict = capabilities.check(path, "filter", isVisible, predicate);
      if (verdict) return badRequest(verdict.path, verdict.message);
    }
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
    const nav = this.capabilities.navFields;
    for (const [key] of insights) {
      if (key === "*") continue;
      const dot = key.indexOf(".");
      if (dot === -1) continue;
      if (!nav.has(key.slice(0, dot))) continue;
      if (!this.hasField(key)) {
        return `Unknown field "${key}"`;
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
      const insightsError = this.validateInsights(parsed.insights as Map<string, unknown>);
      if (insightsError) {
        return new HttpError(400, insightsError);
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
      const nested = this._checkWithRelations(rel.controls?.$with ?? rel.$with, level, path);
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
    for (const [path, source] of this._derivedSourcesOf(readable)) {
      if (writeOnly.has(path) || this.hasField(prefix + source)) continue;
      (out ??= new Set(writeOnly)).add(path);
    }
    return out ?? writeOnly;
  }

  /** The readable a `$with` entry name (`rel` or dotted `rel.sub`) loads from, if resolvable. */
  private _relTarget(
    readable: AtscriptDbReadable<any>,
    name: string,
  ): AtscriptDbReadable<any> | undefined {
    let current: AtscriptDbReadable<any> | undefined = readable;
    for (const segment of name.split(".")) {
      if (typeof current?.relatedTable !== "function") return undefined;
      current = current.relatedTable(segment) as AtscriptDbReadable<any> | undefined;
    }
    return current;
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
      const target = this._relTarget(readable, rel.name);
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
    if (name && this.readable.isSearchable()) {
      const entry = this.indexFieldPaths().find((e) => e.type === "text" && e.name === name);
      if (!entry || !this._indexVisible(entry)) {
        return badRequest("$index", searchIndexNotFoundMessage(name));
      }
    }
    return undefined;
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

  /** WHY: filter row/rows envelopes by the per-request `applyMetaOverlay` action set; skip `meta()` when overlay is identity. */
  private async _resolveAugmentEnvelopes(): Promise<readonly TDbActionEnvelope[] | null> {
    const rowLevelEnvelopes = discoverRowLevelActions(
      this.constructor as Function,
      this.app,
      this.logger,
    );
    if (rowLevelEnvelopes.length === 0) return null;
    if (this._overlayIsNoOp) return rowLevelEnvelopes;
    const overlayMeta = await this.resolveMeta();
    const allowedNames = new Set(overlayMeta.actions.map((a) => a.name));
    const filtered = rowLevelEnvelopes.filter((e) => allowedNames.has(e.info.name));
    return filtered.length === 0 ? null : filtered;
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
      const raw = e.raw as { requiredFields?: unknown };
      if (!Array.isArray(raw.requiredFields)) continue;
      for (const f of raw.requiredFields as string[]) {
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
    const envelopes = await this._resolveAugmentEnvelopes();
    if (envelopes === null) return null;
    const resolvedProjection = this._resolveProjectionForAugmenter(select);
    const widenedSelect =
      resolvedProjection === null
        ? null
        : this._widenSelectForActions(envelopes, resolvedProjection);
    return { envelopes, resolvedProjection, widenedSelect };
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
    return filter && !isEmptyObject(filter)
      ? ({ $and: [filter, fragment] } as FilterExpr)
      : fragment;
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
   * the request asked for it — `prep`), then {@link decorateRows} when a
   * subclass implements it. Returns the hook's result — `undefined`, with no
   * promise or microtask, when there is no hook or it is synchronous.
   */
  private _finishRows(
    rows: Record<string, unknown>[],
    prep: TAugmentationPrep | null,
    ctx: TDbDecorateContext,
  ): void | Promise<void> {
    if (prep) {
      augmentRowsWithActions({
        envelopes: prep.envelopes,
        rows,
        resolvedProjection: prep.resolvedProjection,
      });
    }
    return this._decorates ? this.decorateRows!(rows, ctx) : undefined;
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
    const overlay = await this.transformOne({} as FilterExpr);
    return overlay && !isEmptyObject(overlay) ? overlay : undefined;
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

    // ── Aggregate path ──────────────────────────────────────────────
    if (groupBy?.length) {
      const filter = this.applySearchFallback(await this.transformFilter(parsed.filter), controls);
      return this.readable.aggregate({
        filter,
        controls: this._aggregateControls(controls) as any,
        insights: parsed.insights,
      }) as Promise<any>;
    }

    // ── Regular query path ──────────────────────────────────────────

    const [transformedFilter, transformedSelect] = await Promise.all([
      this.transformFilter(parsed.filter),
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
    const page = Math.max(Number(controls.$page || 1), 1);
    const size = Math.max(Number(controls.$size || 10), 1);
    const skip = (page - 1) * size;

    const [transformedFilter, transformedSelect] = await Promise.all([
      this.transformFilter(parsed.filter),
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

    const [filter, transformedSelect] = await Promise.all([
      this.transformFilter(parsed.filter),
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
   * **GET /meta** — returns table/view metadata for UI.
   *
   * Overrides the base's minimal envelope to add relations, searchable flags,
   * vector-searchable flags, field-descriptor-derived filter/sort hints, and
   * the configured primary keys.
   */
  protected override buildMetaResponse(): TMetaResponse {
    const relations: TMetaResponse["relations"] = [];
    for (const [name, rel] of this.readable.relations) {
      relations.push({ name, direction: rel.direction, isArray: rel.isArray });
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

// Self-register so action discovery's static check
// (`isAsDbReadableControllerSubclass`) and the gate interceptor's runtime
// `instanceof` probe can find this class without forming an import cycle
// through the actions module.
registerAsDbReadableController(AsDbReadableController);
