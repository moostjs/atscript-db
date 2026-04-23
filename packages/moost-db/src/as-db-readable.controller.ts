import { type TAtscriptAnnotatedType, type TAtscriptDataType } from "@atscript/typescript/utils";
import type {
  AtscriptDbReadable,
  FilterExpr,
  TMetaResponse,
  UniqueryControls,
  Uniquery,
} from "@atscript/db";
import { Get, HttpError, Query, Url } from "@moostjs/event-http";
import { Inherit, Inject, Moost, Param } from "moost";

import { AsReadableController, type ReadableGates } from "./as-readable.controller";
import { READABLE_DEF } from "./decorators";

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

  constructor(
    @Inject(READABLE_DEF)
    readable: AtscriptDbReadable<T>,
    app: Moost,
  ) {
    super(readable.type as T, readable.tableName, app, readable.isView ? "view" : "table");
    this.readable = readable;
    this._gates = this._buildGates();
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
   * Transform projection before querying.
   * May return a Promise for async lookups.
   */
  protected transformProjection(
    projection?: UniqueryControls["$select"],
  ): UniqueryControls["$select"] | undefined | Promise<UniqueryControls["$select"] | undefined> {
    return projection;
  }

  /**
   * Extracts a composite identifier object from query params.
   * Tries composite primary key first, then compound unique indexes.
   */
  protected extractCompositeId(query: Record<string, string>): Record<string, unknown> | HttpError {
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

    const [filter, select] = await Promise.all([
      this.transformFilter(parsed.filter),
      this.transformProjection(controls.$select),
    ]);

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

    const controls = parsed.controls as Record<string, unknown>;

    const gateError = this.checkGates(parsed.filter, controls, this._gates);
    if (gateError) {
      return gateError;
    }
    const page = Math.max(Number(controls.$page || 1), 1);
    const size = Math.max(Number(controls.$size || 10), 1);
    const skip = (page - 1) * size;

    const [filter, select] = await Promise.all([
      this.transformFilter(parsed.filter),
      this.transformProjection(controls.$select as UniqueryControls["$select"]),
    ]);

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

    const select = await this.transformProjection(parsed.controls.$select);
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
    const select = await this.transformProjection(parsed.controls.$select);
    const controls = { ...parsed.controls, $select: select };

    return this.returnOne(
      this.readable.findById(idObj as any, { controls } as any) as Promise<DataType | null>,
    );
  }

  /**
   * **GET /meta** — returns table/view metadata for UI.
   *
   * Overrides the base's minimal envelope to add relations, searchable flags,
   * vector-searchable flags, field-descriptor-derived filter/sort hints, and
   * the configured primary keys.
   */
  protected override async buildMetaResponse(): Promise<TMetaResponse> {
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
      fields[fd.path] = {
        sortable: sortableMode ? annotatedSortable : !!fd.isIndexed,
        filterable: filterableMode ? annotatedFilterable : true,
      };
    }

    return {
      searchable: this.readable.isSearchable(),
      vectorSearchable: this.readable.isVectorSearchable(),
      searchIndexes: this.readable.getSearchIndexes(),
      primaryKeys: [...this.readable.primaryKeys],
      readOnly: this._isReadOnly(),
      relations,
      fields,
      type: this.getSerializedType(),
    };
  }
}
