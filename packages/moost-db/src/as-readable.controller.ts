import {
  serializeAnnotatedType,
  type TSerializeOptions,
  type TSerializedAnnotatedType,
  type Validator,
  type TAtscriptAnnotatedType,
  type TAtscriptDataType,
} from "@atscript/typescript/utils";
import type {
  FilterExpr,
  TCrudPermissions,
  TDbActionInfo,
  TMetaResponse,
  Uniquery,
} from "@atscript/db";
import { Get, HttpError } from "@moostjs/event-http";
import { Moost, Param, useControllerContext, type TConsoleBase } from "moost";
import { parseUrl } from "@uniqu/url";

import { badRequest, UseValidationErrorTransform } from "./validation-interceptor";
import { insightError, unknownInsight } from "./http-errors";
import {
  GeoControlsDto,
  GetOneControlsDto,
  PagesControlsDto,
  QueryControlsDto,
} from "./dto/controls.dto.as";
import { discoverActions, getControllerFormType } from "./actions/discover";
import { readRequestContext } from "./relation-predicates";
import { applyTerminalRefs } from "./meta/terminal-ref";

/**
 * Endpoint a {@link AsReadableController.prepareRequest} call serves. `/one`
 * and `/one/:id` both report `"one"`; `DELETE /:id` and `DELETE /?…` both
 * report `"remove"`; value-help controllers report `query` / `pages` / `one`
 * like DB readables do; every `@DbAction` handler (row, rows and table
 * level) reports `"action"` with the action's name in
 * {@link TDbRequestContext.action}; `GET /meta/actions/:id` and
 * `/meta/actions?…` report `"availableActions"` (since 0.1.145); a view's
 * `POST /delegated-actions/:name` (a query target for a `@DbActionsFrom`
 * action — a read of THIS controller's rows) reports `"delegatedAction"` with
 * the action's name in {@link TDbRequestContext.action} (since 0.1.147).
 *
 * @since 0.1.143
 */
export type TDbRequestEndpoint =
  | "query"
  | "pages"
  | "geo"
  | "one"
  | "meta"
  | "metaForm"
  | "insert"
  | "replace"
  | "update"
  | "remove"
  | "action"
  | "availableActions"
  | "delegatedAction";

/**
 * Context passed to {@link AsReadableController.prepareRequest}.
 *
 * @since 0.1.143
 */
export interface TDbRequestContext {
  /** The endpoint being served. */
  readonly endpoint: TDbRequestEndpoint;
  /**
   * The parsed Uniquery controls (`$select`, `$with`, `$search`, …) on read
   * endpoints (`query`, `pages`, `geo`, `one`) — the object the rest of
   * the pipeline validates and reads with. `undefined` on `meta`,
   * `metaForm`, writes and actions.
   */
  readonly controls?: Record<string, unknown>;
  /**
   * The parsed CLIENT filter of `query`, `pages` and `geo` (absent when the
   * URL carries none, and on every other endpoint) — e.g. for a permission
   * layer to resolve which relations the request's relational predicates
   * (`ticket=$some(…)`) touch, alongside `controls.$with`. A deep-frozen
   * COPY of the parsed filter — reading it is all a hook can do; the request
   * gate judges the original. Server-side filters (`transformFilter`, …) are
   * not in it.
   *
   * @since 0.1.147
   */
  readonly filter?: FilterExpr;
  /**
   * Read endpoints (`query`, `pages`, `geo`, `one`): whether {@link filter} holds a relational
   * predicate (`ticket=$some(…)`) — `false` without a filter. Reading
   * `filter` copies the whole filter on first access; check this first when
   * only the predicates matter. `$with` sub-filters are not counted (they are
   * in `controls.$with`).
   *
   * @since 0.1.147
   */
  readonly hasRelationFilters?: boolean;
  /** `"action"` / `"delegatedAction"` endpoints only: the `@DbAction` name being run. */
  readonly action?: string;
  /**
   * `"insert"` endpoint only: the `?$onConflict=` mode the request carries
   * (`"ignore"`); absent for a plain insert. A controller can refuse it by
   * throwing from `prepareRequest`.
   *
   * @since 0.1.148
   */
  readonly onConflict?: "ignore";
}

/** Control DTO a {@link AsReadableController.validateControls} call checks against. @since 0.1.143 (`"geo"`) */
export type TDbControlsType = "query" | "pages" | "getOne" | "geo";

/**
 * A read request as {@link AsReadableController.parseRequest} hands it back.
 *
 * @since 0.1.143
 */
export interface TDbParsedRequest {
  /** The parsed URL (filter, controls, insights). */
  parsed: ReturnType<typeof parseUrl>;
  /** `parsed.controls` — the object `prepareRequest` saw and the pipeline validates. */
  controls: Record<string, unknown>;
  /** `"one"` only: the URL carried non-control (filter) parts, which `/one/:id` rejects. */
  hasNonControl: boolean;
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
 * - Implement {@link hasField} — the field-visibility hook every validated
 *   path consults; a path it rejects gets the same `Unknown field` 400 as a
 *   nonexistent one, so overriding it hides fields per request.
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
  /** {@link metaCacheKey} the cached response was built for. */
  private _metaResponseKey?: unknown;

  /** Cached serialized form schemas keyed by `FormType.name` — populated lazily by {@link metaForm}. */
  private _formSchemas = new Map<string, TSerializedAnnotatedType>();

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

  /**
   * Subclass contract: return `true` if `path` addresses a field that exists
   * AND is visible to the current request — see the DB controller's override
   * for the full list of positions that consult it.
   */
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
      this._serializedType = this.serializeForMeta(this.boundType);
    }
    return this._serializedType;
  }

  /**
   * Serializes a type for the meta surfaces (`/meta`, `/meta/form/:name`)
   * with {@link getSerializeOptions}, then re-points every reference chain to
   * its terminal field and inherits the `db.rel.FK` value-help marker through
   * the chain (since 0.1.128; see `meta/terminal-ref.ts`). Direct references
   * serialize exactly as before.
   */
  protected serializeForMeta(type: TAtscriptAnnotatedType): TSerializedAnnotatedType {
    const options = this.getSerializeOptions();
    return applyTerminalRefs(serializeAnnotatedType(type, options), type, options);
  }

  /**
   * One-time initialization hook. Override to seed data, register watchers, etc.
   */
  protected init(): void | Promise<void> {
    // no-op by default
  }

  /**
   * Returns serialization options for the `/meta` endpoint's type field.
   *
   * `refDepth: 0.5` is intentionally static — independent of `@db.depth.limit`
   * (which is a security guard on nested writes, not a serialization policy).
   * The shallow shape emits `{ field, type: { id, metadata } }` for every FK,
   * which carries the target's `db.http.path` so clients can resolve value-help
   * URLs and lazy-fetch target `/meta` when deeper structure is needed. Nav
   * props (`@db.rel.from` / `@db.rel.to` / `@db.rel.via`) carry only a plain
   * `ref` (`field: ""`) and their bodies always expand fully regardless of
   * `refDepth` — the write-payload shape clients need is unaffected.
   *
   * Annotation whitelist: keeps `meta.*`, `expect.*`, `db.rel.*`, the `db.*`
   * keys the shared db validator plugin reads in db-client (`db.json`,
   * `db.patch.strategy`, `db.default*`, `db.column.version`,
   * `db.column.derived`) and the client-facing `db.http.path` /
   * `db.writeOnly`; strips every other `db.*` (table, column, index, etc.).
   * Override in subclass to customise — keep the validator keys, or client
   * preflight diverges from the server.
   */
  protected getSerializeOptions(): TSerializeOptions {
    return {
      refDepth: 0.5,
      processAnnotation: ({ key, value }) => {
        if (key.startsWith("meta.") || key.startsWith("expect.") || key.startsWith("db.rel.")) {
          return { key, value };
        }
        if (
          key === "db.json" ||
          key === "db.patch.strategy" ||
          key.startsWith("db.default") ||
          key === "db.http.path" ||
          // Clients need the write-only marker: forms render set-only inputs,
          // validators accept the field in writes and never expect it in reads.
          key === "db.writeOnly" ||
          // Server-managed: the db-client validator lets insert/replace omit
          // them (and rejects $inc/$dec/$mul on a derived one) only when it
          // can see the annotation.
          key === "db.column.version" ||
          key === "db.column.derived"
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

  // ── Lazily built validators ────────────────────────────────────────────
  // Kept as protected getters (pre-0.1.143 surface); `validateControls` picks one per type.

  private _queryControlsValidator?: Validator<any>;
  private _pagesControlsValidator?: Validator<any>;
  private _getOneControlsValidator?: Validator<any>;
  private _geoControlsValidator?: Validator<any>;

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

  /** `/geo` controls validator (since 0.1.143 — `/geo` runs {@link validateParsed} like `/query`). */
  protected get geoControlsValidator() {
    if (!this._geoControlsValidator) {
      this._geoControlsValidator = GeoControlsDto.validator();
    }
    return this._geoControlsValidator;
  }

  // ── Request preparation ────────────────────────────────────────────────

  /**
   * Per-request preparation hook — THE entry point for a permission layer to
   * resolve per-request policy asynchronously (load the principal's scopes,
   * evaluate grants) so the synchronous hooks that follow (`hasField`,
   * `validateControls`, `checkCapabilities`) can consult it. Not
   * implemented by default — defining it in a subclass switches it on (it is
   * awaited only then, so unmodified controllers pay nothing).
   *
   * Runs once per request, before anything else consults the request:
   * - read endpoints (`query`, `pages`, `geo`, `one`) — right after the
   *   URL is parsed, BEFORE validation, `hasField`, `validateControls`,
   *   `transformFilter` / `transformProjection`; `ctx.controls` are the
   *   parsed controls (mutating them is allowed and is what the pipeline
   *   then validates);
   * - writes (`insert`, `replace`, `update`, `remove`) — at handler start,
   *   before the shape gate, `onWrite` / `onRemove` and any guard;
   * - `meta` / `metaForm` — first;
   * - `@DbAction` handlers of every level (`action`, with `ctx.action` = the
   *   action name) — from the action's interceptor (after the guards),
   *   before its ids are validated, its rows loaded, its row overlay built
   *   and the handler runs. A permission layer needs no separate action
   *   guard.
   *
   * A throw aborts the request with the thrown error (throw an `HttpError`
   * for a specific status). Value-help controllers get it too.
   *
   * ```ts
   * protected async prepareRequest(ctx: TDbRequestContext) {
   *   const scopes = await loadScopes(useAuthorization(), ctx.endpoint)
   *   if (!scopes) throw new HttpError(403)
   *   requestScopes.set(scopes) // read back by hasField / transformFilter
   * }
   * ```
   *
   * @since 0.1.143
   */
  protected prepareRequest?(ctx: TDbRequestContext): void | Promise<void>;

  /**
   * The ONE request entry of every built-in route: with a `url` (read
   * endpoints, and `POST /`) it parses the query string — `/one` and `POST /`
   * keep only the `$` controls ({@link parseControlsOnlyFromUrl}), every other endpoint the
   * whole query ({@link parseQueryString}) — and coerces boolean controls the
   * URL grammar leaves as strings (`$actions=true`); then it awaits
   * {@link prepareRequest} (when implemented) with the parsed controls.
   * Without a `url` (writes, `meta`, `metaForm`) only the hook runs. Custom
   * routes on a subclass should call it too.
   *
   * @since 0.1.143
   */
  protected parseRequest(endpoint: TDbRequestEndpoint): Promise<undefined>;
  protected parseRequest(endpoint: TDbRequestEndpoint, url: string): Promise<TDbParsedRequest>;
  protected async parseRequest(
    endpoint: TDbRequestEndpoint,
    url?: string,
  ): Promise<TDbParsedRequest | undefined> {
    let request: TDbParsedRequest | undefined;
    if (url !== undefined) {
      const { parsed, hasNonControl } =
        endpoint === "one" || endpoint === "insert"
          ? this.parseControlsOnlyFromUrl(url)
          : { parsed: this.parseQueryString(url), hasNonControl: false };
      const controls = parsed.controls as Record<string, unknown>;
      // The URL parser only auto-coerces `$count`; a boolean control arrives
      // as `"true"` / `"1"` and would fail the controls DTO.
      if (typeof controls.$actions === "string") {
        controls.$actions =
          controls.$actions === "true" || controls.$actions === "1" || controls.$actions === "";
      }
      request = { parsed, controls, hasNonControl };
    }
    if (typeof this.prepareRequest === "function") {
      await this.prepareRequest(
        request
          ? readRequestContext(endpoint, request.controls, request.parsed.filter as FilterExpr)
          : { endpoint },
      );
    }
    return request;
  }

  // ── Validation ─────────────────────────────────────────────────────────

  /**
   * Validates the parsed controls against the endpoint's DTO — the hook for
   * per-control authorization (override, call `super`, add rules). `"geo"`
   * since 0.1.143 (`/geo` used to skip it).
   */
  protected validateControls(
    controls: Record<string, unknown>,
    type: TDbControlsType,
  ): string | undefined {
    // Aggregate queries (presence of `$groupBy`) bypass the base DTO check —
    // `$groupBy` and aggregate-mode `$select` (carrying `AggregateExpr` objects)
    // don't match `QueryControlsDto`; the adapter aggregate builder validates
    // them downstream. Subclass overrides still fire, since this is the hook
    // for per-control authorization (e.g. `$groupBy: false`).
    if (type === "query" && controls.$groupBy !== undefined) {
      return undefined;
    }
    let v: Validator<any>;
    switch (type) {
      case "query":
        v = this.queryControlsValidator;
        break;
      case "pages":
        v = this.pagesControlsValidator;
        break;
      case "geo":
        v = this.geoControlsValidator;
        break;
      default:
        v = this.getOneControlsValidator;
    }
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
        return unknownInsight(insights, key);
      }
    }
    return undefined;
  }

  protected validateParsed(parsed: Uniquery, type: TDbControlsType): HttpError | undefined {
    const controlsError = this.validateControls(
      parsed.controls as unknown as Record<string, unknown>,
      type,
    );
    if (controlsError) {
      return new HttpError(400, controlsError);
    }
    if (parsed.insights) {
      const insights = parsed.insights as Map<string, unknown>;
      const insightsError = this.validateInsights(insights);
      if (insightsError) {
        return insightError(insights, insightsError);
      }
    }
    return undefined;
  }

  /**
   * Per-request gate hook, invoked by the DB readable controller right after
   * its capability gate (`checkCapabilities`) with the parsed query. The
   * default accepts everything. Return an `HttpError` to reject.
   *
   * @deprecated since 0.1.128 — the filter / sort gate is the
   * `FieldCapabilityIndex` behind `checkCapabilities` (override that, or read
   * `this.capabilities` on `AsDbReadableController`); this hook only remains
   * so subclasses that overrode it keep being called.
   */
  protected checkGates(_parsed: { filter?: FilterExpr; controls?: object }): HttpError | undefined {
    return undefined;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  protected parseQueryString(url: string) {
    const idx = url.indexOf("?");
    return this.parseUrlOr400(idx >= 0 ? url.slice(idx + 1) : "");
  }

  /**
   * The ONE place a query string meets the `@uniqu/url` grammar. A lexer /
   * parser error (e.g. an unquoted `-` in a value: `?name=json-w1`) is the
   * client's fault, so since 0.1.128 it is a 400 with the validation envelope
   * `{ message, statusCode: 400, errors: [{ path: "", message }] }` instead of
   * an unhandled 500. Quote such values: `?name='json-w1'`.
   */
  protected parseUrlOr400(queryString: string): ReturnType<typeof parseUrl> {
    try {
      return parseUrl(queryString);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw badRequest("", `Malformed query string: ${detail}`);
    }
  }

  /**
   * Parse a URL keeping only `$*` control keywords; report whether any
   * non-control parts were present. Used by `/one` routes where the
   * uniquery lexer cannot tokenise PK values containing `-` and other
   * reserved chars, so non-control parts must be stripped before lexing.
   * `/one/:id` rejects stray filter params with 400 via `hasNonControl`;
   * `/one` (composite) ignores it because the composite-key params have
   * already been extracted via `@Query()`.
   */
  protected parseControlsOnlyFromUrl(url: string): {
    parsed: ReturnType<typeof parseUrl>;
    hasNonControl: boolean;
  } {
    const idx = url.indexOf("?");
    const qs = idx >= 0 ? url.slice(idx + 1) : "";
    if (!qs) return { parsed: this.parseUrlOr400(""), hasNonControl: false };
    const kept: string[] = [];
    let hasNonControl = false;
    for (const part of qs.split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const rawKey = eq === -1 ? part : part.slice(0, eq);
      let key: string;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        key = rawKey;
      }
      if (key.startsWith("$")) {
        kept.push(part);
      } else {
        hasNonControl = true;
      }
    }
    return { parsed: this.parseUrlOr400(kept.join("&")), hasNonControl };
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
   * **GET /meta** — returns the bound interface's metadata envelope. The
   * static envelope is cached (rebuilt when {@link metaCacheKey} changes);
   * {@link applyMetaOverlay} runs per request so subclasses can prune the
   * response by principal.
   */
  @Get("meta")
  async meta(): Promise<TMetaResponse> {
    await this.parseRequest("meta");
    return this.resolveMeta();
  }

  /**
   * The `/meta` payload for the current request — the cached envelope
   * through {@link applyMetaOverlay} — WITHOUT the `/meta` route's
   * {@link prepareRequest} call. Internal consumers (e.g. `$actions`
   * filtering on a read) use this, so the hook runs once per request with
   * the endpoint actually being served.
   *
   * @since 0.1.143
   */
  protected resolveMeta(): TMetaResponse | Promise<TMetaResponse> {
    const key = this.metaCacheKey();
    if (!this._metaResponse || key !== this._metaResponseKey) {
      this._metaResponse = this.buildMetaResponse();
      this._metaResponseKey = key;
    }
    return this.applyMetaOverlay(this._metaResponse);
  }

  /**
   * Identity of the inputs the cached `/meta` envelope is built from — a new
   * value rebuilds it. Default: constant (built once). The DB readable
   * controller returns its capability index, which is rebuilt when the
   * adapter's capabilities change (since 0.1.132).
   */
  protected metaCacheKey(): unknown {
    return undefined;
  }

  /**
   * **GET /meta/form/:name** — returns the serialized schema of a form
   * referenced by an action's `inputForm` field. The form name is the
   * compiled `.as` class's `.name`, registered when an action's parameter is
   * decorated with `@InputForm(FormType)`. Schemas are serialized once and
   * cached per controller; the response uses the same annotation-allowlist
   * policy as {@link getSerializeOptions}. Since 0.1.143 the form must pass
   * {@link authorizeForm} — a refused form answers exactly like an unknown one.
   */
  @Get("meta/form/:name")
  async metaForm(@Param("name") name: string): Promise<TSerializedAnnotatedType> {
    await this.parseRequest("metaForm");
    // Form registry is populated as a side-effect of action discovery — run
    // it here so /meta/form works even before the first /meta hit.
    const envelopes = discoverActions(this.constructor as Function, this.app, this.logger);
    const formType = getControllerFormType(this.constructor as Function, name);
    // A refused form answers exactly like an unknown one.
    if (
      !formType ||
      !(await this.authorizeForm(
        name,
        envelopes.filter((e) => e.info.inputForm === name).map((e) => e.info.name),
      ))
    ) {
      throw new HttpError(404, `Unknown form "${name}"`);
    }
    let cached = this._formSchemas.get(name);
    if (!cached) {
      cached = this.serializeForMeta(formType);
      this._formSchemas.set(name, cached);
    }
    return cached;
  }

  /**
   * Per-request gate for `GET /meta/form/:name`: return `false` to refuse the
   * form — the response is then the same 404 an unknown form gets, so a
   * refused form's existence does not leak. `actionNames` are the discovered
   * actions whose input form is `name` (a permission layer typically allows
   * the form iff the caller may run at least one of them). Default: `true`.
   *
   * @since 0.1.143
   */
  protected authorizeForm(
    _name: string,
    _actionNames: readonly string[],
  ): boolean | Promise<boolean> {
    return true;
  }

  /**
   * Builds the `/meta` payload. Override in subclasses to populate source-specific
   * fields. Subclasses that fully replace the envelope must call
   * {@link buildActions} and {@link buildCrud} directly so `@DbAction*`
   * decorators and CRUD permissions still surface.
   */
  protected buildMetaResponse(): TMetaResponse {
    return {
      searchable: false,
      vectorSearchable: false,
      searchIndexes: [],
      primaryKeys: [],
      preferredId: [],
      relations: [],
      fields: {},
      type: this.getSerializedType(),
      actions: this.buildActions(),
      crud: this.buildCrud(),
    };
  }

  /**
   * Discovers `@DbAction*` and `@DbActions`-style class metadata on this
   * controller and produces the `actions` array. Returns `[]` for value-help
   * controllers — see {@link AsValueHelpController#buildMetaResponse}.
   */
  protected buildActions(): TDbActionInfo[] {
    return discoverActions(this.constructor as Function, this.app, this.logger).map((e) => e.info);
  }

  /**
   * Declares the built-in CRUD operations this controller exposes. Subclasses
   * override to add their keys; the bare base only exposes `/meta`. See
   * `docs/http/permissions.md` for the wire shape and overlay rules.
   */
  protected buildCrud(): TCrudPermissions {
    return {};
  }

  /**
   * Per-request overlay applied to the cached `/meta` envelope. Default no-op.
   * Subclasses may shallow-clone and prune `crud` keys, `crud[op]` arrays, or
   * `actions[]` based on the current request principal (read via Moost
   * composables). The cached envelope MUST NOT be mutated — see
   * `docs/http/permissions.md` for the full contract, including the
   * "discoverability only" caveat.
   */
  protected applyMetaOverlay(meta: TMetaResponse): TMetaResponse | Promise<TMetaResponse> {
    return meta;
  }
}
