import { type TAtscriptAnnotatedType, type TAtscriptDataType } from "@atscript/typescript/utils";
import type {
  AtscriptDbReadable,
  FilterExpr,
  TCrudPermissions,
  TMetaResponse,
  UniqueryControls,
  Uniquery,
} from "@atscript/db";
import { Get, HttpError, Query, Url } from "@moostjs/event-http";
import { Inherit, Inject, Moost, Param } from "moost";

import { registerAsDbReadableController } from "./actions/controller-registry";
import { discoverRowLevelActions, type TDbActionEnvelope } from "./actions/discover";
import { augmentRowsWithActions } from "./actions/list-augmenter";
import { AsReadableController, type ReadableGates } from "./as-readable.controller";
import { READABLE_DEF } from "./decorators";
import { ONE_CONTROLS, PAGES_CONTROLS, QUERY_CONTROLS } from "./permissions/crud-controls";

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

  private readonly _gates: ReadableGates;
  private readonly _preferredIdSet: ReadonlySet<string>;
  private readonly _overlayIsNoOp: boolean;
  /** path → sibling-ref path for `@db.amount.currency.ref` / `@db.unit.ref`. */
  private readonly _quantityRefByPath: ReadonlyMap<string, string>;

  constructor(
    @Inject(READABLE_DEF)
    readable: AtscriptDbReadable<T>,
    app: Moost,
  ) {
    super(readable.type as T, readable.tableName, app, readable.isView ? "view" : "table");
    this.readable = readable;
    this._gates = this._buildGates();
    this._preferredIdSet = new Set(readable.preferredId ?? []);
    this._quantityRefByPath = this._collectQuantityRefs();
    const defaultOverlay = (
      AsReadableController.prototype as unknown as { applyMetaOverlay: unknown }
    ).applyMetaOverlay;
    this._overlayIsNoOp = (this.applyMetaOverlay as unknown) === defaultOverlay;
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

  private _buildGates(): ReadableGates {
    const meta = this.readable.type.metadata;
    const gates: ReadableGates = {};
    if (meta.get("db.table.filterable") === "manual") {
      const allowed = this._collectAnnotated("db.column.filterable");
      gates.filter = { predicate: (f) => allowed.has(f), annotation: "@db.column.filterable" };
    }
    if (meta.get("db.table.sortable") === "manual") {
      const allowed = this._collectAnnotated("db.column.sortable");
      gates.sort = { predicate: (f) => allowed.has(f), annotation: "@db.column.sortable" };
    }
    return gates;
  }

  private _collectAnnotated(annotation: string): Set<string> {
    const out = new Set<string>();
    for (const [path, entry] of this.readable.flatMap) {
      if (entry.metadata.has(annotation)) out.add(path);
    }
    return out;
  }

  protected hasField(path: string): boolean {
    return this.readable.flatMap.has(path);
  }

  /** Validates $with relations against the readable. */
  protected override validateParsed(
    parsed: Uniquery,
    type: "query" | "pages" | "getOne",
  ): HttpError | undefined {
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
          return new HttpError(400, {
            message: `Unknown relation "${rel.name}" in $with. Available relations: ${[...relations.keys()].join(", ") || "(none)"}`,
            statusCode: 400,
            errors: [{ path: "$with", message: `Unknown relation "${rel.name}"` }],
          });
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
    for (const fd of this.readable.fieldDescriptors) {
      if (!fd.ignored && !excluded.has(fd.path)) widened[fd.path] = 1;
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
      const out: string[] = [];
      for (const fd of this.readable.fieldDescriptors) {
        if (!fd.ignored && !excludedSet.has(fd.path)) out.push(fd.path);
      }
      return out;
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

    // ── Aggregate path (before DTO validation — $groupBy is not in QueryControlsDto) ──
    const groupBy = controls.$groupBy as string[] | undefined;
    if (groupBy?.length) {
      if ((controls.$with as unknown[])?.length) {
        return new HttpError(400, "Cannot combine $with and $groupBy in the same query");
      }
      if (parsed.insights) {
        const insightsError = this.validateInsights(parsed.insights as Map<string, unknown>);
        if (insightsError) {
          return new HttpError(400, insightsError);
        }
      }
      const filter = await this.transformFilter(parsed.filter);
      return this.readable.aggregate({
        filter,
        controls: controls as any,
        insights: parsed.insights,
      }) as Promise<any>;
    }

    // ── Regular query path ──────────────────────────────────────────
    const error = this.validateParsed(parsed, "query");
    if (error) {
      return error;
    }

    const gateError = this.checkGates(
      parsed.filter,
      controls as Record<string, unknown>,
      this._gates,
    );
    if (gateError) {
      return gateError;
    }

    const [filter, rawSelect] = await Promise.all([
      this.transformFilter(parsed.filter),
      this.transformProjection(controls.$select),
    ]);

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

    const gateError = this.checkGates(parsed.filter, controls, this._gates);
    if (gateError) {
      return gateError;
    }
    const page = Math.max(Number(controls.$page || 1), 1);
    const size = Math.max(Number(controls.$size || 10), 1);
    const skip = (page - 1) * size;

    const [filter, rawSelect] = await Promise.all([
      this.transformFilter(parsed.filter),
      this.transformProjection(controls.$select as UniqueryControls["$select"]),
    ]);
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

    const rawSelect = await this.transformProjection(parsed.controls.$select);
    const select = this.widenPreferredIdProjection(rawSelect);
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
    const rawSelect = await this.transformProjection(parsed.controls.$select);
    const select = this.widenPreferredIdProjection(rawSelect);
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

    const filterableMode = this.readable.type.metadata.get("db.table.filterable") === "manual";
    const sortableMode = this.readable.type.metadata.get("db.table.sortable") === "manual";

    const fields: TMetaResponse["fields"] = {};
    for (const fd of this.readable.fieldDescriptors) {
      if (fd.ignored) continue;
      const annotations = fd.type?.metadata;
      const annotatedFilterable = annotations?.has("db.column.filterable") ?? false;
      const annotatedSortable = annotations?.has("db.column.sortable") ?? false;
      // Adapter capability is a hard gate — JSON-stored fields on SQL adapters
      // can't be filtered/sorted no matter what the user annotates.
      const adapterCanFilter = this.readable.canFilterField(fd);
      const adapterCanSort = this.readable.canSortField(fd);
      fields[fd.path] = {
        sortable: adapterCanSort && (sortableMode ? annotatedSortable : !!fd.isIndexed),
        filterable: adapterCanFilter && (filterableMode ? annotatedFilterable : true),
      };
    }

    return {
      searchable: this.readable.isSearchable(),
      vectorSearchable: this.readable.isVectorSearchable(),
      searchIndexes: this.readable.getSearchIndexes(),
      primaryKeys: [...this.readable.primaryKeys],
      preferredId: [...this.readable.preferredId],
      relations,
      fields,
      type: this.getSerializedType(),
      actions: this.buildActions(),
      crud: this.buildCrud(),
    };
  }

  protected override buildCrud(): TCrudPermissions {
    return {
      ...super.buildCrud(),
      query: [...QUERY_CONTROLS],
      pages: [...PAGES_CONTROLS],
      one: [...ONE_CONTROLS],
    };
  }
}

// Self-register so action discovery's static check
// (`isAsDbReadableControllerSubclass`) and the gate interceptor's runtime
// `instanceof` probe can find this class without forming an import cycle
// through the actions module.
registerAsDbReadableController(AsDbReadableController);
