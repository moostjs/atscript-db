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
import { GetOneControlsDto, PagesControlsDto, QueryControlsDto } from "./dto/controls.dto.as";
import { discoverActions, getControllerFormType } from "./actions/discover";
import { applyTerminalRefs } from "./meta/terminal-ref";

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
   * props (`@db.rel.from` / `@db.rel.to` / `@db.rel.via`) are not `.ref` nodes
   * and always expand fully regardless of `refDepth` — the write-payload shape
   * clients need is unaffected.
   *
   * Annotation whitelist: keeps `meta.*`, `expect.*`, and `db.rel.*`; strips
   * other `db.*` (table, column, index, default, etc.). Override in subclass
   * to customise.
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
          // The db-client validator skips a missing server-managed version on
          // insert only when it can see the annotation (since 0.1.128).
          key === "db.column.version"
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
    // Aggregate queries (presence of `$groupBy`) bypass the base DTO check —
    // `$groupBy` and aggregate-mode `$select` (carrying `AggregateExpr` objects)
    // don't match `QueryControlsDto`; the adapter aggregate builder validates
    // them downstream. Subclass overrides still fire, since this is the hook
    // for per-control authorization (e.g. `$groupBy: false`).
    if (type === "query" && controls.$groupBy !== undefined) {
      return undefined;
    }
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
   * static envelope is cached; {@link applyMetaOverlay} runs per request so
   * subclasses can prune the response by principal.
   */
  @Get("meta")
  async meta(): Promise<TMetaResponse> {
    if (!this._metaResponse) {
      this._metaResponse = this.buildMetaResponse();
    }
    return this.applyMetaOverlay(this._metaResponse);
  }

  /**
   * **GET /meta/form/:name** — returns the serialized schema of a form
   * referenced by an action's `inputForm` field. The form name is the
   * compiled `.as` class's `.name`, registered when an action's parameter is
   * decorated with `@InputForm(FormType)`. Schemas are serialized once and
   * cached per controller; the response uses the same annotation-allowlist
   * policy as {@link getSerializeOptions}.
   */
  @Get("meta/form/:name")
  async metaForm(@Param("name") name: string): Promise<TSerializedAnnotatedType> {
    // Form registry is populated as a side-effect of action discovery — run
    // it here so /meta/form works even before the first /meta hit.
    discoverActions(this.constructor as Function, this.app, this.logger);
    const formType = getControllerFormType(this.constructor as Function, name);
    if (!formType) {
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
