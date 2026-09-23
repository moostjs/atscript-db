import { type TAtscriptAnnotatedType, type TAtscriptDataType } from "@atscript/typescript/utils";
import type {
  AtscriptDbReadable,
  FilterExpr,
  TCrudPermissions,
  TFieldMeta,
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
  findAncestorInSet,
  resolveCalendarBuckets,
  unsupportedOperatorMessage,
} from "@atscript/db";
import { Get, HttpError, Query, Url } from "@moostjs/event-http";
import { Inherit, Inject, Moost, Optional, Param } from "moost";

import { registerAsDbReadableController } from "./actions/controller-registry";
import { discoverRowLevelActions, type TDbActionEnvelope } from "./actions/discover";
import { augmentRowsWithActions } from "./actions/list-augmenter";
import { AsReadableController } from "./as-readable.controller";
import { READABLE_DEF, resolveBoundReadable } from "./decorators";
import { FieldCapabilityIndex } from "./meta/field-capabilities";
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

/**
 * Read-only database controller for Moost that works with any `AtscriptDbReadable`
 * (tables or views). Provides query, pages, getOne, and meta endpoints.
 *
 * For write operations (insert, replace, update, delete), use {@link AsDbController}.
 * For views, use {@link AsDbViewController}.
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
  /** Bound once: the field-existence check the gate hands to `capabilities.check`. */
  private readonly _exists = (path: string): boolean => this.hasField(path);
  private readonly _preferredIdSet: ReadonlySet<string>;
  private readonly _overlayIsNoOp: boolean;
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
    this._invertibleFields = this._collectInvertibleFields();
    this._searchFallbackFields = this._collectSearchFallbackFields();
    this._preferredIdSet = new Set(resolved.preferredId ?? []);
    this._quantityRefByPath = this._collectQuantityRefs();
    const defaultOverlay = (
      AsReadableController.prototype as unknown as { applyMetaOverlay: unknown }
    ).applyMetaOverlay;
    this._overlayIsNoOp = (this.applyMetaOverlay as unknown) === defaultOverlay;
  }

  private _collectInvertibleFields(): string[] {
    const out: string[] = [];
    const nav = this.capabilities.navFields;
    for (const fd of this.readable.fieldDescriptors) {
      if (fd.ignored) continue;
      if (nav.has(fd.path) || findAncestorInSet(fd.path, nav) !== undefined) continue;
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

  private _collectAnnotated(annotation: string): Set<string> {
    const out = new Set<string>();
    for (const [path, entry] of this.readable.flatMap) {
      if (entry?.metadata?.has?.(annotation)) out.add(path);
    }
    return out;
  }

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
   * and a real table answer alike.
   */
  protected checkCapabilities(parsed: {
    filter?: FilterExpr;
    controls?: object;
  }): HttpError | undefined {
    const capabilities = this.capabilities;
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
      const verdict = capabilities.check(path, "filter", this._exists, predicate);
      if (verdict) return badRequest(verdict.path, verdict.message);
    }
    for (const op of PATH_OPS) {
      for (const path of refs[op]) {
        const verdict = capabilities.check(path, op, this._exists);
        if (verdict) return badRequest(verdict.path, verdict.message);
      }
    }
    // `$having` keys exist (checked above); they must also be aliases or
    // `$groupBy` fields — the core rule, answered here with the same wording.
    const having = checkHavingKeys(refs);
    if (having) return badRequest(having.path, having.message);
    return this.checkGates(parsed);
  }

  /**
   * The core's shared normalizer of `$select` computed entries
   * (`resolveCalendarBuckets`) as a 400 with the core's wording and `path`
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
      resolveCalendarBuckets(controls, {
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

  /** {@link checkComputedSelect} (before the controls DTO), then $with relations against the readable. */
  protected override validateParsed(
    parsed: Uniquery,
    type: "query" | "pages" | "getOne",
  ): HttpError | undefined {
    const computedError = this.checkComputedSelect(parsed.controls);
    if (computedError) {
      return computedError;
    }
    const baseError = super.validateParsed(parsed, type);
    if (baseError) {
      return baseError;
    }
    const withRelations = (parsed.controls as Record<string, unknown>).$with as
      | Array<{ name: string }>
      | undefined;
    if (withRelations?.length) {
      const relations = this.readable.relations;
      for (const rel of withRelations) {
        if (!rel.name.includes(".") && !relations.has(rel.name)) {
          return badRequest(
            "$with",
            `Unknown relation "${rel.name}"`,
            `Unknown relation "${rel.name}" in $with. Available relations: ${[...relations.keys()].join(", ") || "(none)"}`,
          );
        }
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
    for (const path of this._invertibleFields) {
      if (!excluded.has(path)) widened[path] = 1;
    }
    for (const field of this._preferredIdSet) widened[field] = 1;
    return widened as UniqueryControls["$select"];
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

  /** WHY: the URL parser only auto-coerces `$count`; every other boolean control reaches us as `"true"`/`"1"` and would fail DTO validation. */
  private _coerceActionsControl(controls: Record<string, unknown>): void {
    const v = controls.$actions;
    if (typeof v === "string") {
      controls.$actions = v === "true" || v === "1" || v === "";
    }
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
      const excludedSet = new Set(excluded);
      return this._invertibleFields.filter((path) => !excludedSet.has(path));
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
    const overlayMeta = await this.meta();
    const allowedNames = new Set(overlayMeta.actions.map((a) => a.name));
    const filtered = rowLevelEnvelopes.filter((e) => allowedNames.has(e.info.name));
    return filtered.length === 0 ? null : filtered;
  }

  /** Returns a widened `$select` only when at least one `requiredFields` entry is missing; `null` means "no widening needed". */
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
        if (present) continue;
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
  ): Promise<{
    envelopes: readonly TDbActionEnvelope[];
    resolvedProjection: string[] | null;
    widenedSelect: string[] | null;
  } | null> {
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
   * Removes `@db.writeOnly` fields from any `$select` shape — and forces an
   * exclusion when no projection was requested — so sealed values never leave
   * the database on a read. Runs AFTER `transformProjection` so permission
   * overlays compose (they see the wire `$select`; this guarantees the seal on
   * whatever they return).
   */
  private _sealProjection(
    select: UniqueryControls["$select"] | undefined,
  ): UniqueryControls["$select"] | undefined {
    const writeOnly = this._writeOnlySet;
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
    for (const f of groupBy) {
      if (this._writeOnlySet.has(f)) return f;
    }
    if (Array.isArray(select)) {
      for (const item of select as unknown[]) {
        const field = typeof item === "string" ? item : (item as { $field?: string }).$field;
        if (field && this._writeOnlySet.has(field)) return field;
      }
    }
    return undefined;
  }

  /**
   * Merges the `$search` fallback into the filter: a case-insensitive literal
   * substring match OR'd across the `@db.column.searchable` fields, `$and`-combined
   * with the existing filter. Applies only when the adapter has no native search
   * (native wins) and the request isn't a vector search (`$vector` consumes the term).
   */
  protected applySearchFallback(
    filter: FilterExpr | undefined,
    controls: Record<string, unknown>,
  ): FilterExpr | undefined {
    const term = controls.$search as string | undefined;
    if (!term || controls.$vector !== undefined) return filter;
    if (this.readable.isSearchable() || this._searchFallbackFields.length === 0) return filter;
    const rx = `/${term.replace(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`)}/i`;
    const fragment = {
      $or: this._searchFallbackFields.map((f) => ({ [f]: { $regex: rx } })),
    } as FilterExpr;
    return filter && Object.keys(filter).length > 0
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
    if (controls.$search === undefined || this.readable.isSearchable()) {
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
    if (searchTerm && this.readable.isSearchable()) {
      return { kind: "search", term: searchTerm, index: indexName };
    }
    return { kind: "plain" };
  }

  /**
   * Shared `query` / `pages` pipeline: prepare actions augmentation + read
   * strategy in parallel, pre-widen $select for `requiredFields`, run
   * `exec`, and augment `result.data` with `$actions` when the request set
   * `$actions=true`. Caller dispatches the strategy to its read-method
   * family (count vs no-count).
   */
  private async _runReadWithActions<R extends { data: unknown[] }>(
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
    if (!prep) return result;
    result.data = augmentRowsWithActions({
      envelopes: prep.envelopes,
      rows: result.data as Record<string, unknown>[],
      resolvedProjection: prep.resolvedProjection,
    }) as R["data"];
    return result;
  }

  /** Pick the first identification (PK or unique index) whose fields are all present in the query. */
  protected extractIdShape(query: Record<string, string>): Record<string, unknown> | HttpError {
    for (const id of this.readable.identifications) {
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
    const parsed = this.parseQueryString(url);
    const controls = parsed.controls;
    this._coerceActionsControl(controls as Record<string, unknown>);

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
      const filter = this.applySearchFallback(
        await this.transformFilter(parsed.filter),
        controls as Record<string, unknown>,
      );
      return this.readable.aggregate({
        filter,
        controls: this._aggregateControls(controls as Record<string, unknown>) as any,
        insights: parsed.insights,
      }) as Promise<any>;
    }

    // ── Regular query path ──────────────────────────────────────────

    const [transformedFilter, transformedSelect] = await Promise.all([
      this.transformFilter(parsed.filter),
      this.transformProjection(controls.$select),
    ]);
    const filter = this.applySearchFallback(transformedFilter, controls as Record<string, unknown>);
    const rawSelect = this._sealProjection(transformedSelect);

    if (controls.$count) {
      return this.readable.count({
        filter,
        controls: { ...controls, $select: rawSelect },
      } as Uniquery<any, any>);
    }

    const select = this.widenPreferredIdProjection(rawSelect);
    if (select instanceof HttpError) {
      return select;
    }

    const threshold = controls.$threshold ? Number(controls.$threshold) : undefined;

    const queryObj = {
      filter,
      controls: {
        ...controls,
        $select: select,
        $limit: controls.$limit || 1000,
        $threshold: threshold,
      },
    } as Uniquery<any, any>;

    const wrapped = await this._runReadWithActions(
      queryObj,
      controls as Record<string, unknown>,
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
    const parsed = this.parseQueryString(url);

    this._coerceActionsControl(parsed.controls as Record<string, unknown>);

    const error = this.validateParsed(parsed, "pages");
    if (error) {
      return error;
    }

    const controls = parsed.controls as Record<string, unknown>;

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
    const rawSelect = this._sealProjection(transformedSelect);
    const select = this.widenPreferredIdProjection(rawSelect);
    if (select instanceof HttpError) {
      return select;
    }

    const threshold = controls.$threshold ? Number(controls.$threshold) : undefined;

    const query = {
      filter,
      controls: {
        ...controls,
        $select: select,
        $skip: skip,
        $limit: size,
        $threshold: threshold,
      },
    };

    const result = await this._runReadWithActions(
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
   * otherwise a plain row array (`$skip` / `$limit` compose).
   */
  @Get("geo")
  async geo(
    @Url() url: string,
  ): Promise<
    | DataType[]
    | { data: DataType[]; page: number; itemsPerPage: number; pages: number; count: number }
    | HttpError
  > {
    const parsed = this.parseQueryString(url);
    const controls = parsed.controls as Record<string, unknown>;
    this._coerceActionsControl(controls);

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

    if (parsed.insights) {
      const insightsError = this.validateInsights(parsed.insights as Map<string, unknown>);
      if (insightsError) {
        return new HttpError(400, insightsError);
      }
    }
    // The one endpoint that skips `validateParsed` — normalize `$select` here.
    const computedError = this.checkComputedSelect(controls);
    if (computedError) {
      return computedError;
    }
    const gateError = this.checkCapabilities(parsed);
    if (gateError) {
      return gateError;
    }

    const [filter, transformedSelect] = await Promise.all([
      this.transformFilter(parsed.filter),
      this.transformProjection(controls.$select as UniqueryControls["$select"]),
    ]);
    const select = this.widenPreferredIdProjection(this._sealProjection(transformedSelect));
    if (select instanceof HttpError) {
      return select;
    }

    const paginated = controls.$page !== undefined || controls.$size !== undefined;
    const page = Math.max(Number(controls.$page || 1), 1);
    const size = Math.max(Number(controls.$size || 10), 1);

    const queryObj = {
      filter,
      controls: {
        ...controls,
        $center: undefined,
        $index: undefined,
        $select: select,
        ...(paginated
          ? { $skip: (page - 1) * size, $limit: size }
          : { $limit: controls.$limit || 1000 }),
      },
    } as Uniquery<any, any>;

    if (paginated) {
      const result = await this._runReadWithActions(
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
    const { parsed, hasNonControl } = this.parseControlsOnlyFromUrl(url);
    if (hasNonControl) {
      return new HttpError(400, 'Filtering is not allowed for "one" endpoint');
    }
    this._coerceActionsControl(parsed.controls as Record<string, unknown>);

    const error = this.validateParsed(parsed, "getOne");
    if (error) {
      return error;
    }
    const gateError = this.checkCapabilities(parsed);
    if (gateError) {
      return gateError;
    }

    const rawSelect = await this.transformProjection(parsed.controls.$select);
    const select = this.widenPreferredIdProjection(this._sealProjection(rawSelect));
    if (select instanceof HttpError) {
      return select;
    }
    return this._findByIdAndAugment(id, parsed.controls, select);
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
    const idObj = this.extractIdShape(query);
    if (idObj instanceof HttpError) {
      return idObj;
    }

    const { parsed } = this.parseControlsOnlyFromUrl(url);
    this._coerceActionsControl(parsed.controls as Record<string, unknown>);
    // Same validation + capability gate as `/one/:id` (since 0.1.128) — an
    // unknown `$select` path used to reach the driver here.
    const error = this.validateParsed(parsed, "getOne");
    if (error) {
      return error;
    }
    const gateError = this.checkCapabilities(parsed);
    if (gateError) {
      return gateError;
    }
    const rawSelect = await this.transformProjection(parsed.controls.$select);
    const select = this.widenPreferredIdProjection(this._sealProjection(rawSelect));
    if (select instanceof HttpError) {
      return select;
    }
    return this._findByIdAndAugment(idObj, parsed.controls, select);
  }

  private async _findByIdAndAugment(
    id: string | Record<string, unknown>,
    parsedControls: UniqueryControls,
    select: UniqueryControls["$select"] | undefined,
  ): Promise<DataType | HttpError> {
    const prep = await this._prepareAugmentation(parsedControls as Record<string, unknown>, select);
    const initialSelect = prep?.widenedSelect ?? select;
    const controls = { ...parsedControls, $select: initialSelect };

    const idFilter = this.readable.resolveIdFilter(id);
    let row: DataType | null = null;
    if (idFilter) {
      const overlay = await this.transformOne({} as FilterExpr);
      const hasOverlay = overlay && Object.keys(overlay).length > 0;
      const filter = hasOverlay ? ({ $and: [idFilter, overlay] } as FilterExpr) : idFilter;
      row = (await this.readable.findOne({ filter, controls } as any)) as DataType | null;
    }

    const item = await this.returnOne(Promise.resolve(row));
    if (item instanceof HttpError) return item;
    if (!prep) return item;
    const [augmented] = augmentRowsWithActions({
      envelopes: prep.envelopes,
      rows: [item as unknown as Record<string, unknown>],
      resolvedProjection: prep.resolvedProjection,
    });
    return augmented as DataType;
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
      fields[path] = entry;
    }

    return {
      // Native search OR the @db.column.searchable fallback — either way the
      // UI's search box works, so /meta reports it uniformly.
      searchable: this.readable.isSearchable() || this._searchFallbackFields.length > 0,
      vectorSearchable: this.readable.isVectorSearchable(),
      geoSearchable: this._isGeoSearchable(),
      searchIndexes: this.readable.getSearchIndexes(),
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
