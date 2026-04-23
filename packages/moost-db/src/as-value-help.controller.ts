import type {
  TAtscriptAnnotatedType,
  TAtscriptDataType,
  TAtscriptTypeObject,
} from "@atscript/typescript/utils";
import type { FilterExpr, TMetaResponse } from "@atscript/db";
import { Get, HttpError, Query, Url } from "@moostjs/event-http";
import { Inherit, Moost, Param } from "moost";

import { AsReadableController } from "./as-readable.controller";

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

  constructor(boundType: T, controllerName: string, app: Moost) {
    super(boundType, controllerName, app, "value-help");

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

  /** Returns the row whose primary key matches `id`, or `null` on miss. */
  protected abstract getOne(id: string | number): Promise<DataType | null>;

  protected hasField(path: string): boolean {
    return this.fieldMeta.has(path);
  }

  // ── Routes ─────────────────────────────────────────────────────────────

  /**
   * **GET /query** — returns an array of matched rows (up to `$limit`).
   */
  @Get("query")
  async runQuery(@Url() url: string): Promise<DataType[] | HttpError> {
    const parsed = this.parseQueryString(url);
    const validateError = this.validateParsed(parsed, "query");
    if (validateError) {
      return validateError;
    }
    const result = await this.query({
      filter: parsed.filter,
      controls: parsed.controls as ValueHelpQuery<DataType>["controls"],
    });
    return result.data;
  }

  /**
   * **GET /pages** — paginated row window plus total count.
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
    const parsed = this.parseQueryString(url);
    const validateError = this.validateParsed(parsed, "pages");
    if (validateError) {
      return validateError;
    }
    const controls = parsed.controls as Record<string, unknown>;
    const page = Math.max(Number(controls.$page || 1), 1);
    const size = Math.max(Number(controls.$size || 10), 1);
    const skip = (page - 1) * size;
    const result = await this.query({
      filter: parsed.filter,
      controls: { ...controls, $skip: skip, $limit: size } as ValueHelpQuery<DataType>["controls"],
    });
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
    return this.returnOne(this.getOne(id));
  }

  /**
   * **GET /one?<pk>=<val>** — retrieves a single row by PK query param (fallback).
   */
  @Get("one")
  async runGetOneComposite(@Query() query: Record<string, string>): Promise<DataType | HttpError> {
    const pk = this.primaryKey;
    if (!pk) {
      return new HttpError(400, "No primary key (@meta.id) on value-help interface");
    }
    const id = query[pk];
    if (id === undefined) {
      return new HttpError(400, `Missing PK field "${pk}"`);
    }
    return this.returnOne(this.getOne(id));
  }

  /**
   * Meta response surfaces `@ui.dict.*` annotations as **hints** for the
   * client picker UI (which controls to render); the server does not enforce
   * these flags at request time.
   */
  protected override async buildMetaResponse(): Promise<TMetaResponse> {
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
      readOnly: this._isReadOnly(),
      relations: [],
      fields,
      type: this.getSerializedType(),
    };
  }
}
