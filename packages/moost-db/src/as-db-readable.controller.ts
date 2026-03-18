import {
  serializeAnnotatedType,
  type TSerializeOptions,
  type Validator,
  type TAtscriptAnnotatedType,
  type TAtscriptDataType,
} from "@atscript/typescript/utils";
import type { AtscriptDbReadable, FilterExpr, UniqueryControls, Uniquery } from "@atscript/db";
import { Get, HttpError, Query, Url } from "@moostjs/event-http";
import { Inject, Moost, Param, type TConsoleBase } from "moost";
import { parseUrl } from "@uniqu/url";

import { READABLE_DEF } from "./decorators";
import { UseValidationErrorTransform } from "./validation-interceptor";
import { GetOneControlsDto, PagesControlsDto, QueryControlsDto } from "./dto/controls.dto.as";

/**
 * Read-only database controller for Moost that works with any `AtscriptDbReadable`
 * (tables or views). Provides query, pages, getOne, and meta endpoints.
 *
 * For write operations (insert, replace, update, delete), use {@link AsDbController}.
 * For views, use {@link AsDbViewController}.
 */
@UseValidationErrorTransform()
export class AsDbReadableController<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
> {
  /** Reference to the underlying readable (table or view). */
  protected readable: AtscriptDbReadable<T>;

  /** Application-scoped logger. */
  protected logger: TConsoleBase;

  /** Cached serialized type definition (static, computed once). */
  private _serializedType: ReturnType<typeof serializeAnnotatedType>;

  /** Cached search index list (static, computed once). */
  private _searchIndexes: ReturnType<AtscriptDbReadable<T>["getSearchIndexes"]>;

  /** Cached full meta response (computed lazily on first meta() call). */
  private _metaResponse?: {
    searchable: boolean;
    vectorSearchable: boolean;
    searchIndexes: ReturnType<AtscriptDbReadable<T>["getSearchIndexes"]>;
    primaryKeys: string[];
    readOnly: boolean;
    relations: Array<{ name: string; direction: string; isArray: boolean }>;
    fields: Record<string, { sortable: boolean; filterable: boolean }>;
    type: ReturnType<typeof serializeAnnotatedType>;
  };

  constructor(
    @Inject(READABLE_DEF)
    readable: AtscriptDbReadable<T>,
    app: Moost,
  ) {
    this.readable = readable;
    this._serializedType = serializeAnnotatedType(readable.type, this.getSerializeOptions());
    this._searchIndexes = readable.getSearchIndexes();
    this.logger = app.getLogger(`db [${readable.tableName}]`);
    this.logger.info(`Initializing ${readable.isView ? "view" : "table"} controller`);
    try {
      const p = this.init();
      if (p instanceof Promise) {
        p.catch((error) => {
          this.logger.error(error);
        });
      }
    } catch (error) {
      this.logger.error(error);
      throw error;
    }
  }

  /**
   * One-time initialization hook. Override to seed data, register watchers, etc.
   */
  protected init(): void | Promise<void> {
    // no-op by default
  }

  /**
   * Returns serialization options for the `/meta` endpoint's type field.
   * Default: whitelist — keeps `meta.*`, `expect.*`, and `db.rel.*` annotations,
   * strips all other `db.*` annotations (table, column, index, default, etc.).
   * Override in subclass to customise what annotations are exposed to clients.
   */
  protected getSerializeOptions(): TSerializeOptions {
    return {
      processAnnotation: ({ key, value }) => {
        if (key.startsWith("meta.") || key.startsWith("expect.") || key.startsWith("db.rel.")) {
          return { key, value };
        }
        if (key.startsWith("db.")) {
          return undefined;
        }
        return { key, value };
      },
    };
  }

  /**
   * Whether this controller is read-only (no write endpoints).
   * Returns `true` for readable/view controllers, overridden to `false` in AsDbController.
   */
  protected _isReadOnly(): boolean {
    return true;
  }

  // ── Lazily built validators ────────────────────────────────────────────

  private _queryControlsValidator?: Validator<any>;
  private _pagesControlsValidator?: Validator<any>;
  private _getOneControlsValidator?: Validator<any>;

  protected get queryControlsValidator() {
    if (!this._queryControlsValidator) {
      this._queryControlsValidator = QueryControlsDto.validator();
    }
    return this._queryControlsValidator;
  }

  protected get pagesControlsValidator() {
    if (!this._pagesControlsValidator) {
      this._pagesControlsValidator = PagesControlsDto.validator();
    }
    return this._pagesControlsValidator;
  }

  protected get getOneControlsValidator() {
    if (!this._getOneControlsValidator) {
      this._getOneControlsValidator = GetOneControlsDto.validator();
    }
    return this._getOneControlsValidator;
  }

  // ── Validation ─────────────────────────────────────────────────────────

  protected validateControls(
    controls: Record<string, unknown>,
    type: "query" | "pages" | "getOne",
  ): string | undefined {
    const v =
      type === "query"
        ? this.queryControlsValidator
        : type === "pages"
          ? this.pagesControlsValidator
          : this.getOneControlsValidator;
    if (!v.validate(controls, true)) {
      return v.errors[0]?.message || "Invalid controls";
    }
    return undefined;
  }

  protected validateInsights(insights: Map<string, unknown>): string | undefined {
    for (const [key] of insights) {
      if (key === "*") {
        continue;
      }
      if (!this.readable.flatMap.has(key)) {
        return `Unknown field "${key}"`;
      }
    }
    return undefined;
  }

  protected validateParsed(
    parsed: Uniquery,
    type: "query" | "pages" | "getOne",
  ): HttpError | undefined {
    const controlsError = this.validateControls(
      parsed.controls as unknown as Record<string, unknown>,
      type,
    );
    if (controlsError) {
      return new HttpError(400, controlsError);
    }
    if (parsed.insights) {
      const insightsError = this.validateInsights(parsed.insights as Map<string, unknown>);
      if (insightsError) {
        return new HttpError(400, insightsError);
      }
    }
    // Validate $with relation names
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
   */
  protected transformFilter(filter: FilterExpr): FilterExpr {
    return filter;
  }

  /**
   * Transform projection before querying.
   */
  protected transformProjection(
    projection?: UniqueryControls["$select"],
  ): UniqueryControls["$select"] | undefined {
    return projection;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  protected parseQueryString(url: string) {
    const idx = url.indexOf("?");
    return parseUrl(idx >= 0 ? url.slice(idx + 1) : "");
  }

  protected async returnOne(result: Promise<DataType | null>): Promise<DataType | HttpError> {
    const item = await result;
    if (!item) {
      return new HttpError(404);
    }
    return item;
  }

  /**
   * Extracts a composite identifier object from query params.
   * Tries composite primary key first, then compound unique indexes.
   */
  protected extractCompositeId(query: Record<string, string>): Record<string, unknown> | HttpError {
    // Try composite primary key
    const pkFields = this.readable.primaryKeys;
    if (pkFields.length > 1) {
      const idObj: Record<string, unknown> = {};
      let allPresent = true;
      for (const field of pkFields) {
        if (query[field] === undefined) {
          allPresent = false;
          break;
        }
        idObj[field] = query[field];
      }
      if (allPresent) {
        return idObj;
      }
    }

    // Try compound unique indexes
    for (const index of this.readable.indexes.values()) {
      if (index.type !== "unique" || index.fields.length < 2) {
        continue;
      }
      const idObj: Record<string, unknown> = {};
      let allPresent = true;
      for (const indexField of index.fields) {
        if (query[indexField.name] === undefined) {
          allPresent = false;
          break;
        }
        idObj[indexField.name] = query[indexField.name];
      }
      if (allPresent) {
        return idObj;
      }
    }

    return new HttpError(
      400,
      "Query params do not match any composite primary key or compound unique index",
    );
  }

  // ── REST Endpoints (read-only) ──────────────────────────────────────────

  /**
   * **GET /query** — returns an array of records or a count.
   */
  @Get("query")
  async query(@Url() url: string): Promise<DataType[] | number | HttpError> {
    const parsed = this.parseQueryString(url);
    const controls = parsed.controls;

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
      const filter = this.transformFilter(parsed.filter);
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

    const filter = this.transformFilter(parsed.filter);
    const select = this.transformProjection(controls.$select);

    if (controls.$count) {
      return this.readable.count({ filter, controls: { ...controls, $select: select } } as Uniquery<
        any,
        any
      >);
    }

    const searchTerm = controls.$search as string | undefined;
    const indexName = controls.$index as string | undefined;
    const vectorField = controls.$vector as string | undefined;
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

    if (vectorField !== undefined && searchTerm) {
      const vector = await this.computeEmbedding(searchTerm, vectorField || undefined);
      if (vectorField) {
        return this.readable.vectorSearch(vectorField, vector, queryObj) as Promise<DataType[]>;
      }
      return this.readable.vectorSearch(vector, queryObj) as Promise<DataType[]>;
    }

    if (searchTerm && this.readable.isSearchable()) {
      return this.readable.search(searchTerm, queryObj, indexName) as Promise<DataType[]>;
    }

    return this.readable.findMany(queryObj) as Promise<DataType[]>;
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

    const error = this.validateParsed(parsed, "pages");
    if (error) {
      return error;
    }

    const controls = parsed.controls as PagesControlsDto & Record<string, unknown>;
    const page = Math.max(Number(controls.$page || 1), 1);
    const size = Math.max(Number(controls.$size || 10), 1);
    const skip = (page - 1) * size;

    const filter = this.transformFilter(parsed.filter);
    const select = this.transformProjection(controls.$select);

    const searchTerm = controls.$search as string | undefined;
    const indexName = controls.$index as string | undefined;
    const vectorField = controls.$vector as string | undefined;
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

    let result: { data: DataType[]; count: number };
    if (vectorField !== undefined && searchTerm) {
      const vector = await this.computeEmbedding(searchTerm, vectorField || undefined);
      if (vectorField) {
        result = (await this.readable.vectorSearchWithCount(
          vectorField,
          vector,
          query as Uniquery<any, any>,
        )) as { data: DataType[]; count: number };
      } else {
        result = (await this.readable.vectorSearchWithCount(
          vector,
          query as Uniquery<any, any>,
        )) as { data: DataType[]; count: number };
      }
    } else if (searchTerm && this.readable.isSearchable()) {
      result = (await this.readable.searchWithCount(
        searchTerm,
        query as Uniquery<any, any>,
        indexName,
      )) as { data: DataType[]; count: number };
    } else {
      result = (await this.readable.findManyWithCount(query as Uniquery<any, any>)) as {
        data: DataType[];
        count: number;
      };
    }

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
   */
  @Get("one/:id")
  async getOne(@Param("id") id: string, @Url() url: string): Promise<DataType | HttpError> {
    const parsed = this.parseQueryString(url);

    if (Object.keys(parsed.filter).length > 0) {
      return new HttpError(400, 'Filtering is not allowed for "one" endpoint');
    }

    const error = this.validateParsed(parsed, "getOne");
    if (error) {
      return error;
    }

    const select = this.transformProjection(parsed.controls.$select);
    const controls = { ...parsed.controls, $select: select };

    return this.returnOne(
      this.readable.findById(id as any, { controls } as any) as Promise<DataType | null>,
    );
  }

  /**
   * **GET /one?field1=val1&field2=val2** — retrieves a single record by composite key
   * (composite primary key or compound unique index).
   */
  @Get("one")
  async getOneComposite(
    @Query() query: Record<string, string>,
    @Url() url: string,
  ): Promise<DataType | HttpError> {
    const idObj = this.extractCompositeId(query);
    if (idObj instanceof HttpError) {
      return idObj;
    }

    const parsed = this.parseQueryString(url);
    const select = this.transformProjection(parsed.controls.$select);
    const controls = { ...parsed.controls, $select: select };

    return this.returnOne(
      this.readable.findById(idObj as any, { controls } as any) as Promise<DataType | null>,
    );
  }

  /**
   * **GET /meta** — returns table/view metadata for UI.
   */
  @Get("meta")
  meta() {
    if (this._metaResponse) {
      return this._metaResponse;
    }

    const relations: Array<{ name: string; direction: string; isArray: boolean }> = [];
    for (const [name, rel] of this.readable.relations) {
      relations.push({ name, direction: rel.direction, isArray: rel.isArray });
    }

    const fields: Record<string, { sortable: boolean; filterable: boolean }> = {};
    for (const fd of this.readable.fieldDescriptors) {
      if (fd.ignored) continue;
      fields[fd.path] = {
        sortable: !!fd.isIndexed,
        filterable: true,
      };
    }

    this._metaResponse = {
      searchable: this.readable.isSearchable(),
      vectorSearchable: this.readable.isVectorSearchable(),
      searchIndexes: this._searchIndexes,
      primaryKeys: [...this.readable.primaryKeys],
      readOnly: this._isReadOnly(),
      relations,
      fields,
      type: this._serializedType,
    };
    return this._metaResponse;
  }
}
