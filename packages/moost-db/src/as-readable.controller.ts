import {
  serializeAnnotatedType,
  type TSerializeOptions,
  type Validator,
  type TAtscriptAnnotatedType,
  type TAtscriptDataType,
} from "@atscript/typescript/utils";
import type { FilterExpr, TMetaResponse, Uniquery } from "@atscript/db";
import { Get, HttpError } from "@moostjs/event-http";
import { Moost, useControllerContext, type TConsoleBase } from "moost";
import { parseUrl } from "@uniqu/url";

import { UseValidationErrorTransform } from "./validation-interceptor";
import { GetOneControlsDto, PagesControlsDto, QueryControlsDto } from "./dto/controls.dto.as";
import { findFilterOffender, findSortOffender } from "./gate-utils";

/**
 * Optional gate configuration for a single request. Each present entry enables
 * the corresponding check; omitted entries skip that gate entirely.
 */
export interface ReadableGates {
  filter?: { predicate: (field: string) => boolean; annotation: string };
  sort?: { predicate: (field: string) => boolean; annotation: string };
  search?: { allowed: boolean; rejectionMessage: string };
}

/**
 * Abstract base class for read-only HTTP controllers over an Atscript interface.
 *
 * Shared responsibilities (implemented here):
 * - Stamps `@db.http.path` on the bound interface's metadata at registration
 *   with the final public path (leading slash + Moost `globalPrefix`).
 * - Lazily serializes the bound interface for the `/meta` endpoint
 *   (see {@link getSerializeOptions}).
 * - Provides DTO-backed validators for the Uniquery controls DTOs and the
 *   helpers (`parseQueryString`, `returnOne`, `validateParsed`, etc.) that
 *   subclasses share.
 * - Registers the `/meta` route. Subclasses override {@link buildMetaResponse}
 *   to shape the payload; DB-backed readables add relations/searchable flags,
 *   value-help controllers add their capability hints.
 *
 * Subclass responsibilities:
 * - Pass the bound interface + logical name + (optional) kind tag through super().
 * - Implement {@link hasField} so insights validation can reject unknown keys.
 * - Register the `/query`, `/pages`, `/one(/:id)` routes with the concrete
 *   handlers that match the data source's contract (DB readables route into
 *   aggregate/vector/search; value-help controllers just filter/sort/paginate).
 */
@UseValidationErrorTransform()
export abstract class AsReadableController<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
> {
  /** The Atscript interface this controller serves. */
  protected readonly boundType: T;

  /** Short human-readable name for logging (usually the table/source name). */
  protected readonly controllerName: string;

  /** Application-scoped logger. */
  protected logger: TConsoleBase;

  /** Moost application instance. */
  protected app: Moost;

  /** Cached serialized type definition (lazy, computed on first access). */
  private _serializedType?: ReturnType<typeof serializeAnnotatedType>;

  /** Cached full meta response (computed lazily on first meta() call). */
  private _metaResponse?: TMetaResponse;

  constructor(boundType: T, controllerName: string, app: Moost, kindTag = "readable") {
    this.boundType = boundType;
    this.controllerName = controllerName;
    this.app = app;
    this.logger = app.getLogger(`db [${controllerName}]`);
    this.logger.info(`Initializing ${kindTag} controller`);
    this._resolveHttpPath();
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

  /** Subclass contract: return `true` if `path` addresses a valid field on the bound source. */
  protected abstract hasField(path: string): boolean;

  /** Sets @db.http.path on the type metadata from the controller's computed prefix. */
  private _resolveHttpPath() {
    let prefix: string | undefined;
    try {
      prefix = useControllerContext().getPrefix();
    } catch {
      // No active event context (e.g. direct instantiation in tests).
    }
    if (!prefix) {
      const overview = this.app
        .getControllersOverview?.()
        ?.find((o) => o.type === this.constructor);
      prefix = overview?.computedPrefix;
    }
    if (prefix) {
      if (!prefix.startsWith("/")) {
        prefix = `/${prefix}`;
      }
      this.boundType.metadata.set("db.http.path", prefix);
    }
  }

  /** Lazily serializes the bound type (after all controllers have set @db.http.path). */
  protected getSerializedType() {
    if (!this._serializedType) {
      this._serializedType = serializeAnnotatedType(this.boundType, this.getSerializeOptions());
    }
    return this._serializedType;
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
    const declared = (this.boundType.metadata.get("db.deep.insert") as number | undefined) ?? 0;
    return {
      refDepth: declared + 0.5,
      processAnnotation: ({ key, value }) => {
        if (key.startsWith("meta.") || key.startsWith("expect.") || key.startsWith("db.rel.")) {
          return { key, value };
        }
        if (
          key === "db.json" ||
          key === "db.patch.strategy" ||
          key.startsWith("db.default") ||
          key === "db.http.path"
        ) {
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
   * Returns `true` by default; {@link AsDbController} overrides to `false`.
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
      if (!this.hasField(key)) {
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
    return undefined;
  }

  /**
   * Shared filter/sort/search gate check. Subclasses assemble a {@link ReadableGates}
   * config per request (or once in the constructor when static) and call this to
   * get a uniform HTTP 400 response for any offending field/control.
   */
  protected checkGates(
    filter: FilterExpr | undefined,
    controls: Record<string, unknown>,
    gates: ReadableGates,
  ): HttpError | undefined {
    if (gates.filter) {
      const bad = findFilterOffender(filter, gates.filter.predicate);
      if (bad) {
        return new HttpError(
          400,
          `Filtering on field "${bad}" is not permitted — add ${gates.filter.annotation} to enable.`,
        );
      }
    }
    if (gates.sort) {
      const bad = findSortOffender(controls.$sort, gates.sort.predicate);
      if (bad) {
        return new HttpError(
          400,
          `Sorting on field "${bad}" is not permitted — add ${gates.sort.annotation} to enable.`,
        );
      }
    }
    if (gates.search && controls.$search && !gates.search.allowed) {
      return new HttpError(400, gates.search.rejectionMessage);
    }
    return undefined;
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

  // ── Meta endpoint ──────────────────────────────────────────────────────

  /**
   * **GET /meta** — returns the bound interface's metadata envelope.
   *
   * Base implementation delegates to {@link buildMetaResponse}, which subclasses
   * override to add source-specific fields (relations, searchable flags, etc.).
   * The response is cached on the instance; async overrides must cache any
   * extra enrichment themselves.
   */
  @Get("meta")
  async meta(): Promise<TMetaResponse> {
    if (this._metaResponse) {
      return this._metaResponse;
    }
    const response = await this.buildMetaResponse();
    this._metaResponse = response;
    return response;
  }

  /**
   * Builds the `/meta` payload. Override in subclasses to populate source-specific
   * fields. Defaults return a minimal envelope with the serialized type and the
   * read-only flag; value-help dicts populate their capability hints here.
   */
  protected async buildMetaResponse(): Promise<TMetaResponse> {
    return {
      searchable: false,
      vectorSearchable: false,
      searchIndexes: [],
      primaryKeys: [],
      readOnly: this._isReadOnly(),
      relations: [],
      fields: {},
      type: this.getSerializedType(),
    };
  }
}
