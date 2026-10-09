import type {
  TAtscriptAnnotatedType,
  TAtscriptDataType,
  TAtscriptTypeObject,
} from "@atscript/typescript/utils";
import type { FilterExpr, NullsPlacement, TCrudPermissions, TMetaResponse } from "@atscript/db";
import { isEmptyObject, isPlainObject } from "@atscript/db";
import { buildMemoryPredicate, projectRow } from "@atscript/db-memory";
import { Get, HttpError, Query, Url } from "@moostjs/event-http";
import { Inherit, Moost, Param } from "moost";

import {
  assertNoValueHelpActions,
  registerAsValueHelpController,
} from "./actions/controller-registry";
import { AsReadableController } from "./as-readable.controller";
import { ONE_CONTROLS, PAGES_CONTROLS, QUERY_CONTROLS } from "./permissions/crud-controls";

/**
 * A value-help projection: the parsed `$select` (inclusion list, or a
 * `{ path: 0 | 1 }` map for the `-field` exclusion form).
 *
 * @since 0.1.143
 */
export type ValueHelpSelect<T> = (keyof T | string)[] | Record<string, 0 | 1>;

/**
 * Parsed Uniquery controls with the `$search` field carved out for value-help
 * use (the core DTO includes it but we narrow the type here so implementations
 * can rely on the concrete shape).
 */
export interface ValueHelpQuery<T> {
  filter: FilterExpr;
  controls: {
    $skip?: number;
    $limit?: number;
    $search?: string;
    $select?: (keyof T | string)[];
    $sort?: unknown;
    /** NULL placement per `$sort` key (URL `$sort=-name:last`; since 0.1.153). */
    $nulls?: Partial<Record<string, NullsPlacement>>;
    [key: string]: unknown;
  };
}

/**
 * Abstract base class for read-only HTTP controllers serving a **value-help**
 * source — an interface bound to a simple `/query` / `/pages` / `/one(/:id)` /
 * `/meta` surface, not a full DB table. Value-help controllers drive the
 * client-side picker UI on fields annotated `@db.rel.FK`.
 *
 * Subclass responsibilities:
 * - Pass the bound interface + rows/backing-source through super().
 * - Implement the abstract {@link query} and {@link getOne} methods.
 *
 * The bound interface's `@ui.dict.*` annotations are **client-side hints**
 * consumed by the picker UI; the server does not gate filter / sort / search
 * requests against them. Subclasses that need a backend gate should compose
 * one of their own (see {@link AsDbReadableController} for the
 * `@db.column.filterable` / `@db.column.sortable` pattern).
 *
 * **Per-request scoping** (since 0.1.143) — the same three seams as the DB
 * controllers, applied by the base routes to every value-help source:
 * {@link transformFilter} (row overlay: `/query` / `/pages` filter, `/one`
 * rows), {@link transformProjection} (returned columns) and {@link hasField}
 * (a hidden field answers like an unknown one in filter / sort / select and
 * never matches `$search`).
 *
 * **Actions are NOT supported on value-help controllers.** The `/meta`
 * payload still includes `actions: []` for shape uniformity; since 0.1.143
 * any `@DbAction` / `@DbActions*` on a value-help controller is a hard error
 * (at decoration, or at construction for actions inherited from a base) —
 * previously it was dropped from `/meta` while its `@Post` route still ran
 * without any gate. Value-help is for FK pickers and dictionary surfaces.
 */
@Inherit()
export abstract class AsValueHelpController<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
> extends AsReadableController<T, DataType> {
  /** Per-prop metadata map of the bound interface; eagerly built once. */
  protected readonly fieldMeta: Map<string, Map<string, unknown>>;

  /**
   * Fields that participate in `$search` by default. Populated from
   * `@ui.dict.searchable`:
   * - If any prop carries `@ui.dict.searchable`, only those props are here.
   * - Else if the interface carries `@ui.dict.searchable`, every `string`-typed prop is here.
   * - Else every `string`-typed prop is here (hint is absent — default to all strings).
   */
  protected readonly searchableFields: readonly string[];

  /** The `@meta.id` field name on the bound interface, if any. */
  protected readonly primaryKey: string | undefined;

  constructor(boundType: T, controllerName: string, app: Moost, opts?: { canonical?: boolean }) {
    super(boundType, controllerName, app, "value-help", opts);
    assertNoValueHelpActions(this.constructor);

    const fieldMeta = new Map<string, Map<string, unknown>>();
    const explicitlySearchable: string[] = [];
    const stringProps: string[] = [];
    let primaryKey: string | undefined;
    const interfaceSearchable = boundType.metadata.has("ui.dict.searchable");
    const asObj = boundType.type as TAtscriptTypeObject;
    if (asObj?.props) {
      for (const [name, prop] of asObj.props) {
        const meta = prop.metadata as Map<string, unknown>;
        fieldMeta.set(name, meta);
        if (!primaryKey && meta.has("meta.id")) primaryKey = name;
        const designType = (prop.type as { designType?: string }).designType;
        if (designType === "string") stringProps.push(name);
        if (meta.has("ui.dict.searchable")) explicitlySearchable.push(name);
      }
    }
    this.fieldMeta = fieldMeta;
    this.primaryKey = primaryKey;
    this.searchableFields =
      explicitlySearchable.length > 0
        ? explicitlySearchable
        : interfaceSearchable
          ? stringProps
          : stringProps;
  }

  // ── Abstract data-source contract ──────────────────────────────────────

  /** Executes a value-help query against the backing source. */
  protected abstract query(controls: ValueHelpQuery<DataType>): Promise<{
    data: DataType[];
    count: number;
  }>;

  /**
   * Returns the row whose primary key matches `id`, or `null` on miss. The
   * `/one` routes then apply {@link transformFilter} (a row outside the
   * overlay is a 404) and {@link transformProjection} to it in memory.
   */
  protected abstract getOne(id: string | number): Promise<DataType | null>;

  // ── Hooks (overridable) ────────────────────────────────────────────────

  /**
   * THE field-visibility hook: `true` when `path` is a field of the bound
   * interface visible to this request. A path it rejects in the request's
   * filter / `$sort` / `$select` gets the same `Unknown field "x"` 400 as a
   * nonexistent one, and a hidden field never takes part in `$search`
   * (`AsJsonValueHelpController`). Override to hide fields per request — it
   * gates the request only; strip the column from responses with
   * {@link transformProjection}.
   */
  protected hasField(path: string): boolean {
    return this.fieldMeta.has(path);
  }

  /**
   * Row overlay — the value-help counterpart of the DB controllers'
   * `transformFilter`. Receives the request filter of `/query` / `/pages`
   * and returns the one to run (AND your scope in: `{ $and: [filter, scope] }`).
   * `/one` evaluates `transformFilter({})` against the found row in memory: a
   * row outside it answers 404, exactly like a missing one. Default: identity.
   * May be async.
   *
   * @since 0.1.143
   */
  protected transformFilter(filter: FilterExpr): FilterExpr | Promise<FilterExpr> {
    return filter;
  }

  /**
   * Projection hook — receives the request `$select` (`undefined` when
   * absent; `/one` always passes `undefined`) and returns the projection to
   * apply: an inclusion list / `{ path: 1 }` map, or an exclusion
   * `{ path: 0 }` map. Default: identity. May be async.
   *
   * @since 0.1.143
   */
  protected transformProjection(
    select: ValueHelpSelect<DataType> | undefined,
  ): ValueHelpSelect<DataType> | undefined | Promise<ValueHelpSelect<DataType> | undefined> {
    return select;
  }

  /**
   * Normalizes a value-help `$select` (the raw `parseUrl` form or a
   * {@link transformProjection} result) to the `@atscript/db-memory`
   * `{ path: 0 | 1 }` projection map:
   * - `string[]` (e.g. from `?$select=a,b`) → inclusion map `{ a: 1, b: 1 }`,
   * - a plain `{ path: 0 | 1 }` object → passed through (0 / falsy → exclude),
   * - anything else / empty → `undefined` (no projection; whole rows returned).
   */
  protected normalizeSelect(select: unknown): Record<string, 0 | 1> | undefined {
    const out: Record<string, 0 | 1> = {};
    if (Array.isArray(select)) {
      for (const field of select) {
        if (typeof field === "string" && field) out[field] = 1;
      }
    } else if (select && typeof select === "object") {
      for (const [path, v] of Object.entries(select as Record<string, unknown>)) {
        out[path] = v === 0 || v === false ? 0 : 1;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** `filter` through {@link transformFilter} and `controls.$select` through {@link transformProjection}. */
  private async _scopedQuery(
    filter: FilterExpr,
    controls: ValueHelpQuery<DataType>["controls"],
  ): Promise<ValueHelpQuery<DataType>> {
    const [scopedFilter, select] = await Promise.all([
      this.transformFilter(filter),
      this.transformProjection(controls.$select),
    ]);
    const out = { ...controls };
    if (select === undefined) delete out.$select;
    else out.$select = select as ValueHelpQuery<DataType>["controls"]["$select"];
    return { filter: scopedFilter, controls: out };
  }

  /**
   * `getOne` + the row overlay (miss → 404) + the projection, applied in
   * memory — `getOne` is the subclass's own lookup (id coercion included),
   * so it is not re-expressed as a {@link query} filter.
   */
  private async _scopedOne(id: string | number): Promise<DataType | HttpError> {
    const [item, overlay, select] = await Promise.all([
      this.returnOne(this.getOne(id)),
      this.transformFilter({} as FilterExpr),
      this.transformProjection(undefined),
    ]);
    if (item instanceof HttpError) return item;
    if (overlay && !isEmptyObject(overlay)) {
      if (!buildMemoryPredicate(overlay)(item as Record<string, unknown>)) {
        return new HttpError(404);
      }
    }
    const projection = this.normalizeSelect(select);
    return projection
      ? (projectRow(item as Record<string, unknown>, projection, { clone: false }) as DataType)
      : item;
  }

  // ── Routes ─────────────────────────────────────────────────────────────

  /**
   * **GET /query** — returns an array of matched rows (up to `$limit`).
   */
  @Get("query")
  async runQuery(@Url() url: string): Promise<DataType[] | HttpError> {
    const { parsed, controls } = await this.parseRequest("query", url);
    const validateError = this.validateParsed(parsed, "query");
    if (validateError) {
      return validateError;
    }
    const result = await this.query(
      await this._scopedQuery(parsed.filter, controls as ValueHelpQuery<DataType>["controls"]),
    );
    return result.data;
  }

  /**
   * `/pages` controls without a `$sort` (since 0.1.153): ordered by the
   * primary key, ascending, so consecutive pages neither overlap nor skip
   * rows — like the DB controllers' `/pages`. A request with `$sort` or
   * `$search` keeps its order; a source without a primary key stays as is.
   */
  private _pagesOrder(
    controls: ValueHelpQuery<DataType>["controls"],
  ): ValueHelpQuery<DataType>["controls"] {
    const sort = controls.$sort;
    const sorted = Array.isArray(sort)
      ? sort.length > 0
      : isPlainObject(sort)
        ? !isEmptyObject(sort)
        : !!sort;
    if (sorted || controls.$search || !this.primaryKey) return controls;
    return { ...controls, $sort: { [this.primaryKey]: 1 } };
  }

  /**
   * **GET /pages** — paginated row window plus total count. Without a
   * `$sort` the rows come in primary-key order (since 0.1.153).
   */
  @Get("pages")
  async runPages(@Url() url: string): Promise<
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
    const validateError = this.validateParsed(parsed, "pages");
    if (validateError) {
      return validateError;
    }
    const page = Math.max(Number(controls.$page || 1), 1);
    const size = Math.max(Number(controls.$size || 10), 1);
    const skip = (page - 1) * size;
    const result = await this.query(
      await this._scopedQuery(
        parsed.filter,
        this._pagesOrder({
          ...controls,
          $skip: skip,
          $limit: size,
        } as ValueHelpQuery<DataType>["controls"]),
      ),
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
   * **GET /one/:id** — retrieves a single row by primary key.
   */
  @Get("one/:id")
  async runGetOne(@Param("id") id: string): Promise<DataType | HttpError> {
    // No URL controls on value-help `/one` — `prepareRequest` sees `{}`.
    await this.parseRequest("one", "");
    return this._scopedOne(id);
  }

  /**
   * **GET /one?<pk>=<val>** — retrieves a single row by PK query param (fallback).
   */
  @Get("one")
  async runGetOneComposite(@Query() query: Record<string, string>): Promise<DataType | HttpError> {
    await this.parseRequest("one", "");
    const pk = this.primaryKey;
    if (!pk) {
      return new HttpError(400, "No primary key (@meta.id) on value-help interface");
    }
    const id = query[pk];
    if (id === undefined) {
      return new HttpError(400, `Missing PK field "${pk}"`);
    }
    return this._scopedOne(id);
  }

  /**
   * Meta response surfaces `@ui.dict.*` annotations as **hints** for the
   * client picker UI (which controls to render); the server does not enforce
   * these flags at request time.
   */
  protected override buildMetaResponse(): TMetaResponse {
    const fields: TMetaResponse["fields"] = {};
    for (const [path, meta] of this.fieldMeta) {
      fields[path] = {
        sortable: meta.has("ui.dict.sortable"),
        filterable: meta.has("ui.dict.filterable"),
      };
    }
    return {
      searchable: this.searchableFields.length > 0,
      vectorSearchable: false,
      searchIndexes: [],
      primaryKeys: this.primaryKey ? [this.primaryKey] : [],
      preferredId: this.primaryKey ? [this.primaryKey] : [],
      relations: [],
      fields,
      type: this.getSerializedType(),
      actions: [],
      crud: this.buildCrud(),
    };
  }

  protected override buildActions() {
    return [];
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

// Self-register so the @DbAction decorator factory can reject actions on
// value-help controllers without forming an import cycle through the actions
// module.
registerAsValueHelpController(AsValueHelpController);
