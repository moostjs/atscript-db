import { buildUrl } from "@uniqu/url/builder";
import type {
  AggregateQuery,
  AggregateResult,
  ComputedExpr,
  NestedAggregateQuery,
  NestedAggregateResult,
  Uniquery,
  UniqueryControls,
  ValidGroupBy,
  ValidNested,
} from "@uniqu/core";
import type { TAtscriptAnnotatedType, TSerializedAnnotatedType } from "@atscript/typescript/utils";
import type {
  TDbActionInfo,
  TDbActionTargetSummary,
  TDbAvailableActions,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbInsertIgnoreResult,
  TDbInsertManyIgnoreResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "@atscript/db";

import {
  ActionDisabledError,
  ActionTargetError,
  VersionMismatchError,
  ActionNotFoundError,
  ActionUnsupportedError,
  ClientError,
  TransportError,
  type ActionDisabledErrorBody,
  type ActionTargetErrorBody,
  type VersionMismatchErrorBody,
} from "./client-error";
import { defaultMetaStore, type MetaStore } from "./meta-store";
import type { ClientValidator, ValidatorMode } from "./validator";
import type {
  AtscriptClientShape,
  ClientOptions,
  ClientResponse,
  DecoratedControls,
  DecoratedQuery,
  IdOf,
  InsertOf,
  MetaResponse,
  NavOf,
  OwnOf,
  PageResult,
  PatchOf,
  RowOf,
  TClientCallOptions,
  TDbQueryTarget,
} from "./types";

type Own<T> = OwnOf<T>;
type Nav<T> = NavOf<T>;
type Id<T> = IdOf<T>;
type Response<T, Q> = ClientResponse<T, Q>;
/** A read row: the response over the own fields plus the declared decorations `D`, each optional. */
type DecoratedRow<T, Q, D> = Response<T, Q> & Partial<D>;
type THttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
/** Per-request transport options of the private request helpers. */
type TRequestOptions = {
  allowEmpty?: boolean;
  signal?: AbortSignal;
  /** Extra headers of this request only. */
  headers?: Record<string, string>;
};
/**
 * One insert row for `returning`: an untyped client's row is any `object`,
 * which an array would match too — there it is any non-array object.
 */
type SingleInsertOf<T> = [keyof InsertOf<T>] extends [never]
  ? Record<string, any> & { readonly [Symbol.iterator]?: never }
  : InsertOf<T>;
/** The stored row `insert(row, { returning: true })` answers: the `one()` row shape. */
type InsertedRow<T, D> = DecoratedRow<T, Record<never, never>, D>;
/** A two-level aggregate query: one with `controls.$from`. */
type NestedShape = { controls: { $from: object } };
/** The compile-time check an aggregate query must pass: two-level or flat. */
type AggregateCheck<T, Q> = Q extends NestedShape ? ValidNested<T, Q> : ValidGroupBy<T, Q>;
/** The rows `aggregate()` answers for query `Q`. */
type AggregateRows<T, Q extends AggregateQuery<T> | NestedAggregateQuery<T>> = Q extends NestedShape
  ? NestedAggregateResult<T, Q>[]
  : Q["controls"]["$select"] extends readonly (string | ComputedExpr)[]
    ? AggregateResult<T, Q["controls"]["$select"]>[]
    : Record<string, unknown>[];

/**
 * HTTP client for moost-db REST endpoints.
 *
 * Each method maps 1:1 to a controller endpoint:
 * - `query()` → `GET /query`
 * - `count()` → `GET /query` with `$count`
 * - `aggregate()` → `GET /query` with `$groupBy`
 * - `pages()` → `GET /pages`
 * - `one()`   → `GET /one/:id` or `GET /one?compositeKeys`
 * - `insert()`  → `POST /`
 * - `update()`  → `PATCH /`
 * - `replace()` → `PUT /`
 * - `remove()`  → `DELETE /:id` or `DELETE /?compositeKeys`
 * - `meta()`  → `GET /meta`
 *
 * ```typescript
 * const users = new Client<typeof User>('/api/users')
 * const all = await users.query()
 * const page = await users.pages({ filter: { active: true } }, 1, 20)
 * ```
 *
 * `D` (since 0.1.148) types the display-only fields the controller declares
 * with `@DbDecorations`: `$select` of the read methods accepts their keys and
 * rows carry them as optional properties. Filter and sort stay over `T`'s own
 * fields — a decoration is never filterable or sortable.
 *
 * ```typescript
 * const tickets = new Client<typeof Ticket, TicketDecorations>('/api/tickets')
 * const rows = await tickets.query({ controls: { $select: ['title', 'ownerName'] } })
 * rows[0].ownerName // string | undefined
 * ```
 */
export class Client<
  T extends AtscriptClientShape = AtscriptClientShape,
  D extends object = Record<never, never>,
> {
  private readonly _path: string;
  private readonly _baseUrl: string;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _headers?: ClientOptions["headers"];
  private readonly _navigate?: ClientOptions["navigate"];
  private readonly _lenientWrites?: boolean;
  private readonly _metaStore: MetaStore | undefined;
  private readonly _metaKey?: string;
  private readonly _locale?: ClientOptions["locale"];
  /** The locale {@link _metaPromise} (and the validator, forms) were loaded in. */
  private _metaLocale?: string;
  private _metaPromise?: Promise<MetaResponse>;
  /** The `ETag` of the `/meta` body {@link _metaPromise} resolved to. */
  private _metaEtag?: string;
  private _validatorPromise?: Promise<ClientValidator>;
  /** Cached deserialized form schemas keyed by resolved URL. */
  private _formCache = new Map<string, Promise<TAtscriptAnnotatedType>>();

  constructor(path: string, opts?: ClientOptions) {
    this._path = path.endsWith("/") ? path.slice(0, -1) : path;
    this._baseUrl = opts?.baseUrl ?? "";
    this._fetch = opts?.fetch ?? globalThis.fetch.bind(globalThis);
    this._headers = opts?.headers;
    this._navigate = opts?.navigate;
    this._lenientWrites = opts?.lenientWrites;
    this._metaStore = opts?.metaStore === false ? undefined : (opts?.metaStore ?? defaultMetaStore);
    this._metaKey = opts?.metaKey;
    this._locale = opts?.locale;
  }

  // ── GET /query ─────────────────────────────────────────────────────────────

  /**
   * `GET /query` — query records with typed filter, sort, select, and relations.
   *
   * The response type narrows by the literal `$with` array in `query` —
   * relations not listed in `$with` are stripped from the row type.
   */
  async query<const Q extends DecoratedQuery<T, D> = DecoratedQuery<T, D>>(
    query?: Q,
    opts?: TClientCallOptions,
  ): Promise<DecoratedRow<T, Q, D>[]> {
    return this._get("query", query as Uniquery, opts?.signal) as Promise<DecoratedRow<T, Q, D>[]>;
  }

  // ── GET /query ($count) ────────────────────────────────────────────────────

  /**
   * `GET /query` with `$count: true` — returns record count.
   */
  async count(
    query?: { filter?: Uniquery<Own<T>, Nav<T>>["filter"] },
    opts?: TClientCallOptions,
  ): Promise<number> {
    return this._get(
      "query",
      { ...query, controls: { $count: true } } as Uniquery,
      opts?.signal,
    ) as Promise<number>;
  }

  // ── GET /query ($groupBy) ──────────────────────────────────────────────────

  /**
   * `GET /query` with `$groupBy` — aggregate query with typed dimension/measure fields.
   * `$groupBy: []` is the ungrouped aggregate: one row over the filtered set (served
   * by moost-db since 0.1.155 — the URL carries the aggregate `$select` and no `$groupBy`).
   *
   * `$select` may carry calendar buckets (`{ $bucket, $field, $tz?, $weekStart?, $as? }`);
   * a `$groupBy` entry must be a dimension or a bucket alias (`ValidGroupBy`), and a
   * bucket's value is typed as its `YYYY-MM-DD` (hour: `YYYY-MM-DDTHH:00`) label
   * (`| null` for an optional source).
   * Gap-fill between labels with `nextBucketLabel` (re-exported here).
   *
   * Arithmetic (since 0.1.148): `{ $fn: 'sum', $expr, $as }` aggregates a per-row
   * expression over numeric fields; `{ $expr, $as }` computes over aliases of other
   * numeric entries or numeric `$groupBy` fields (`number | null`). `first` / `last`
   * read a representative row ordered by `$rowOrder`. The URL forms are `expr(a/b):x`,
   * `sum(a*b):x`, `first(f):x` and `$rowOrder=f,-id`.
   *
   * Since 0.1.168 (server: `/meta` `distinctFieldLists`, `conditionalAggregates`,
   * `nestedAggregates`):
   * - `{ $fn: 'countDistinct', $field: ['a', 'b'] }` counts distinct combinations (a row
   *   with any NULL field is not counted); URL `countDistinct(a,b)`;
   * - `{ $fn, $field, $where, $as }` aggregates only the rows matching `$where` (a typed
   *   filter); URL `sum(amount|status=paid):paid`;
   * - a query with `controls.$from` is a two-level aggregate: `$from` groups the filtered
   *   rows, the root controls aggregate its rows and name its columns (its `$groupBy`
   *   keys and aliases) — typed by `ValidNested`, rows by `NestedAggregateResult`.
   */
  async aggregate<const Q extends AggregateQuery<Own<T>> | NestedAggregateQuery<Own<T>>>(
    query: Q & AggregateCheck<Own<T>, Q>,
    opts?: TClientCallOptions,
  ): Promise<AggregateRows<Own<T>, Q>> {
    return this._get("query", query as unknown as Uniquery, opts?.signal) as Promise<any>;
  }

  // ── GET /pages ─────────────────────────────────────────────────────────────

  /**
   * `GET /pages` — paginated query with typed filter and relations.
   *
   * Response rows narrow by the literal `$with` array — same algebra as
   * {@link query}.
   */
  async pages<const Q extends DecoratedQuery<T, D> = DecoratedQuery<T, D>>(
    query?: Q,
    page = 1,
    size = 10,
    opts?: TClientCallOptions,
  ): Promise<PageResult<DecoratedRow<T, Q, D>>> {
    return this._get(
      "pages",
      { ...query, controls: { ...query?.controls, $page: page, $size: size } } as Uniquery,
      opts?.signal,
    ) as Promise<PageResult<DecoratedRow<T, Q, D>>>;
  }

  // ── GET /geo ───────────────────────────────────────────────────────────────

  /**
   * `GET /geo` — distance-ranked geospatial search (tables with `@db.index.geo`).
   *
   * `point` is `[lng, lat]` (GeoJSON order). Rows come back ordered by distance
   * ascending, each carrying a computed `$distance` (meters from `point`).
   * `$maxDistance` / `$minDistance` (meters) and `$index` (geo index name) ride
   * in `query.controls`; filter / `$select` / `$with` / `$skip` / `$limit`
   * compose as usual.
   */
  async geoSearch<const Q extends DecoratedQuery<T, D> = DecoratedQuery<T, D>>(
    point: [number, number],
    query?: Q,
    opts?: TClientCallOptions,
  ): Promise<Array<DecoratedRow<T, Q, D> & { $distance: number }>> {
    return this._get(
      "geo",
      { ...query, controls: { ...query?.controls, $center: point.join(",") } } as Uniquery,
      opts?.signal,
    ) as Promise<Array<DecoratedRow<T, Q, D> & { $distance: number }>>;
  }

  /**
   * `GET /geo` with `$page` / `$size` — paginated distance-ranked search.
   */
  async geoPages<const Q extends DecoratedQuery<T, D> = DecoratedQuery<T, D>>(
    point: [number, number],
    query?: Q,
    page = 1,
    size = 10,
    opts?: TClientCallOptions,
  ): Promise<PageResult<DecoratedRow<T, Q, D> & { $distance: number }>> {
    return this._get(
      "geo",
      {
        ...query,
        controls: { ...query?.controls, $center: point.join(","), $page: page, $size: size },
      } as Uniquery,
      opts?.signal,
    ) as Promise<PageResult<DecoratedRow<T, Q, D> & { $distance: number }>>;
  }

  // ── GET /one/:id ───────────────────────────────────────────────────────────

  /**
   * `GET /one/:id` or `GET /one?k1=v1&k2=v2` — single record by primary key.
   *
   * Returns `null` on 404. Response narrows by the literal `$with` array in
   * `query.controls` — same algebra as {@link query}.
   */
  async one<
    const Q extends { controls?: DecoratedControls<T, D> } = {
      controls?: DecoratedControls<T, D>;
    },
  >(id: Id<T>, query?: Q, opts?: TClientCallOptions): Promise<DecoratedRow<T, Q, D> | null> {
    const controlStr = query?.controls
      ? buildUrl({ controls: query.controls as UniqueryControls })
      : "";
    return this._getOrNull<Q>(
      this._idUrl("one", id, controlStr),
      opts?.signal,
    ) as Promise<DecoratedRow<T, Q, D> | null>;
  }

  // ── POST / ─────────────────────────────────────────────────────────────────

  // Array overloads come first: on an untyped client a row is any `object`,
  // which an array would match too.
  /**
   * `POST /` — insert many records.
   */
  async insert(data: InsertOf<T>[], opts?: TClientCallOptions): Promise<TDbInsertManyResult>;
  /**
   * `POST /?$onConflict=ignore` — insert many records, skipping the ones that
   * collide; the result reports inserted and skipped input indices (since 0.1.148).
   */
  async insert(
    data: InsertOf<T>[],
    opts: TClientCallOptions & { onConflict: "ignore" },
  ): Promise<TDbInsertManyIgnoreResult>;
  /**
   * `POST /` with `Prefer: return=representation` — insert one record and
   * get the stored row back as `row` (since 0.1.168): server defaults and
   * stamps included, shaped as `one()` would answer it. `row` is absent when
   * the server could not apply the preference (the caller may not read the
   * row, or a skipped conflict).
   */
  async insert(
    data: SingleInsertOf<T>,
    opts: TClientCallOptions & { returning: true },
  ): Promise<TDbInsertResult & { row?: InsertedRow<T, D> }>;
  /**
   * `POST /?$onConflict=ignore` with `Prefer: return=representation` — as
   * above; a skipped row answers `{ conflict: true }` without `row`.
   */
  async insert(
    data: SingleInsertOf<T>,
    opts: TClientCallOptions & { returning: true; onConflict: "ignore" },
  ): Promise<TDbInsertIgnoreResult & { row?: InsertedRow<T, D> }>;
  /**
   * `POST /` — insert one record. The version column (if any) is optional —
   * the server initialises it; `$cas` is rejected (no meaning on insert).
   */
  async insert(data: InsertOf<T>, opts?: TClientCallOptions): Promise<TDbInsertResult>;
  /**
   * `POST /?$onConflict=ignore` — insert one record, skipping it when it
   * collides on the primary key or a unique index (since 0.1.148).
   */
  async insert(
    data: InsertOf<T>,
    opts: TClientCallOptions & { onConflict: "ignore" },
  ): Promise<TDbInsertIgnoreResult>;
  async insert(
    data: InsertOf<T> | InsertOf<T>[],
    opts?: TClientCallOptions & { onConflict?: "ignore"; returning?: true },
  ): Promise<unknown> {
    const query = opts?.onConflict === "ignore" ? "?$onConflict=ignore" : "";
    const headers = opts?.returning ? { Prefer: "return=representation" } : undefined;
    return this._request("POST", query, await this._prepareWrite(data, "insert"), {
      signal: opts?.signal,
      headers,
    });
  }

  // ── PATCH / ────────────────────────────────────────────────────────────────

  /**
   * `PATCH /` — partial update one or many records by primary key.
   *
   * Accepts both OCC shapes (since 0.1.128): a bare `version: N` (the wire
   * contract) or the SDK `$cas: { version: N }`, which is lifted to `version`
   * before preflight and sending. A stale version surfaces as
   * {@link VersionMismatchError}; a PK-only body with a version is a real
   * write (the server bumps the version).
   */
  async update(
    data: PatchOf<T> | PatchOf<T>[],
    opts?: TClientCallOptions,
  ): Promise<TDbUpdateResult> {
    return this._request(
      "PATCH",
      "",
      await this._prepareWrite(data, "patch"),
      opts,
    ) as Promise<TDbUpdateResult>;
  }

  // ── PUT / ──────────────────────────────────────────────────────────────────

  /**
   * `PUT /` — full replace one or many records by primary key. Same OCC
   * shapes as {@link update}; the version column itself is optional.
   */
  async replace(data: RowOf<T> | RowOf<T>[], opts?: TClientCallOptions): Promise<TDbUpdateResult> {
    return this._request(
      "PUT",
      "",
      await this._prepareWrite(data, "replace"),
      opts,
    ) as Promise<TDbUpdateResult>;
  }

  // ── DELETE /:id ────────────────────────────────────────────────────────────

  /**
   * `DELETE /:id` or `DELETE /?k1=v1&k2=v2` — remove a record by primary key.
   */
  async remove(id: Id<T>, opts?: TClientCallOptions): Promise<TDbDeleteResult> {
    return this._request(
      "DELETE",
      this._idUrl("", id),
      undefined,
      opts,
    ) as Promise<TDbDeleteResult>;
  }

  // ── GET /meta ──────────────────────────────────────────────────────────────

  /**
   * `GET /meta` — table/view metadata (cached after first call).
   *
   * The response is revalidated through the client's meta store
   * (`ClientOptions.metaStore`): ETags seen before for this store key go out
   * as `If-None-Match`, and a `304 Not Modified` reuses the stored body.
   */
  async meta(): Promise<MetaResponse> {
    const locale = this._syncLocale();
    if (!this._metaPromise) {
      const p: Promise<MetaResponse> = this._loadMeta(locale).then(
        ({ body, etag }) => {
          if (this._metaPromise === p) this._metaEtag = etag;
          return body;
        },
        (err) => {
          if (this._metaPromise === p) this._metaPromise = undefined;
          throw err;
        },
      );
      this._metaPromise = p;
    }
    return this._metaPromise;
  }

  /**
   * The `ETag` of the `/meta` body {@link meta} resolved to — `undefined`
   * before it resolves, after {@link invalidateMeta}, or when the server sent
   * no readable `ETag` (cross-origin without `Access-Control-Expose-Headers:
   * ETag`). Equal ETags mean byte-identical `/meta` bodies, so it can key
   * anything derived from them (deserialized types, validators, column
   * definitions) across clients and route params.
   *
   * @since 0.1.153
   */
  metaEtag(): string | undefined {
    return this._metaEtag;
  }

  /**
   * The {@link MetaStore} {@link meta} revalidates through — the shared
   * default store, the one passed as `ClientOptions.metaStore`, or
   * `undefined` when that option was `false`. Read-only: clear it on an
   * identity change (`client.metaStore?.clear()`) together with
   * {@link invalidateMeta}.
   *
   * @since 0.1.155
   */
  get metaStore(): MetaStore | undefined {
    return this._metaStore;
  }

  /**
   * Drops everything this client cached from the server's metadata — the
   * `/meta` response, the validator built from it and the loaded action
   * forms — so the next call fetches them again. Call it when the viewer's
   * identity changes (login, logout, role change): `/meta` is projected per
   * user, and a client reused across identities would otherwise keep serving
   * the previous user's columns, actions and write rules.
   *
   * The next `meta()` still revalidates through the meta store, so an
   * unchanged `/meta` costs a `304`, not a download. On an identity change
   * also clear the store (`clearMetaStore()` / `metaStore.clear()`).
   *
   * @since 0.1.151
   */
  invalidateMeta(): void {
    this._metaPromise = undefined;
    this._metaEtag = undefined;
    this._validatorPromise = undefined;
    this._formCache.clear();
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Invoke a declared action by name. Resolves the action descriptor from the
   * cached `/meta` response, then dispatches based on `processor`:
   *
   * - `'backend'` → POST the identifier as a JSON body to the action's path
   *   and return the parsed server response. The HTTP method is always POST.
   * - `'navigate'` → for `level: 'row'`, substitute `$1` in `value` with the
   *   identifier values, walking `meta.preferredId` field order (each value
   *   URL-encoded, compound IDs joined with `/`); for `level: 'rows'` or
   *   `'table'`, navigate to `value` verbatim. The default navigator (browser
   *   only) calls `window.location.assign(url)`. Provide
   *   `ClientOptions.navigate` to integrate with a SPA router.
   * - `'custom'` → throw {@link ActionUnsupportedError}; UI-dispatched events
   *   are the application's responsibility, not the client's.
   *
   * Throws {@link ActionNotFoundError} when the action is not present in `/meta`.
   *
   * **Identifier shape (server contract).** `id` is always an object (single)
   * or array of objects (multi) — never a scalar. Each object's field set
   * must exactly match one legitimate identification on the table (PK or any
   * `@db.index.unique` group). Even single-field PK tables send `{ id: 'abc' }`,
   * not `'abc'`. `level: 'table'` actions take no identifier (`undefined`).
   *
   * The TypeScript signature widens to `Partial<Own<T>>` because the server's
   * exact-match validation cannot be expressed at the type level. Mismatched
   * field sets produce HTTP 400; obvious type errors (scalars, `null`) are
   * caught at compile time when `T` is typed.
   *
   * **Form input.** When the action's `inputForm` field is set, the server
   * expects a structured payload in the envelope's `input` field. Pass it as
   * the third argument; the schema can be fetched ahead of time via
   * {@link getActionForm} to drive a UI form. Body shape on the wire is
   * `{ ids?, input? }` — `ids` carries `id` (object or array per level),
   * `input` carries the form payload.
   *
   * **Delegated actions** (since 0.1.147). An action another controller owns
   * (`owner`, e.g. a view listing its source table's actions) may carry
   * `idMap`: each `id` is then a row (or identifier) of THIS controller and
   * is mapped to the owner's identification — `{ [ownerField]:
   * row[path] }` — before it is sent to `value` (the owner's route). A
   * missing path throws `TypeError`. See {@link actionIdentifier}.
   *
   * @typeParam R Caller-asserted return shape from the action handler. The
   *              server returns whatever the handler emits (commonly
   *              `{ message?: string, ... }`); the client cannot validate.
   */
  async action<R = unknown>(
    name: string,
    id?: Partial<Own<T>> | Partial<Own<T>>[],
    input?: unknown,
  ): Promise<R> {
    const meta = await this.meta();
    const action = meta.actions.find((a) => a.name === name);
    if (!action) throw new ActionNotFoundError(name);

    if (action.processor === "custom") {
      throw new ActionUnsupportedError(
        name,
        "custom",
        `Action "${name}" has processor "custom" — applications must dispatch custom actions themselves; the client cannot.`,
      );
    }

    const mapped = action.idMap ? mapDelegatedIds(action, id) : id;

    if (action.processor === "navigate") {
      const order = action.idMap ? Object.keys(action.idMap) : meta.preferredId;
      const url = this._interpolateNavigateUrl(action, mapped, order);
      await this._dispatchNavigate(action, url);
      return undefined as R;
    }

    const body = this._buildActionBody(action, mapped, input);
    return this._postAction(action, body) as Promise<R>;
  }

  /**
   * Runs a `'rows'` action on every row matching a query (since 0.1.147) —
   * the action's `/meta` entry must carry `queryTarget`. POSTs
   * `{ query: { q, exclude?, expectCount?, maxRows? }, input? }` to
   * `queryTarget.url` (a delegated action: the view resolves the rows and
   * runs the owner's action in batches) or `value`. `q` is the `/query`
   * string of `target.filter` / `search` / `index`.
   *
   * The server answers what the handler returns — for a delegated action
   * (and a handler returning `target.summary()`) a
   * {@link TDbActionTargetSummary}. Refusals arrive as
   * {@link ActionTargetError}: `TARGET_TOO_LARGE` (`cap`), `TARGET_CHANGED`
   * (`matched` differs from `expectCount`), `TARGET_INVALID`. Throws
   * {@link ActionUnsupportedError} when the action takes no query target.
   *
   * @since 0.1.147
   */
  async actionOnQuery<R = TDbActionTargetSummary>(
    name: string,
    target: TDbQueryTarget<T>,
    input?: unknown,
  ): Promise<R> {
    const action = await this._queryTargetAction(name);
    const body: { query: unknown; input?: unknown } = { query: queryTargetBody(target) };
    if (input !== undefined) body.input = input;
    return this._postQueryTarget(action, body) as Promise<R>;
  }

  /**
   * How many rows {@link actionOnQuery} would target right now (a dry run:
   * the handler does not run) — pass the answer as `expectCount` to make the
   * real run fail with `TARGET_CHANGED` if the set changed in between.
   *
   * @since 0.1.147
   */
  async countActionTarget(name: string, target: TDbQueryTarget<T>): Promise<{ matched: number }> {
    const action = await this._queryTargetAction(name);
    const query = { ...queryTargetBody(target), dryRun: true };
    return this._postQueryTarget(action, { query }) as Promise<{ matched: number }>;
  }

  private async _queryTargetAction(name: string): Promise<TDbActionInfo> {
    const meta = await this.meta();
    const action = meta.actions.find((a) => a.name === name);
    if (!action) throw new ActionNotFoundError(name);
    if (!action.queryTarget || action.processor !== "backend") {
      throw new ActionUnsupportedError(
        name,
        action.processor,
        `Action "${name}" does not accept a query target (no \`queryTarget\` in /meta).`,
      );
    }
    return action;
  }

  private _postQueryTarget(action: TDbActionInfo, body: unknown): Promise<unknown> {
    const path = action.queryTarget?.url ?? action.value;
    return this._requestUrl("POST", `${this._baseUrl}${path}`, body, { allowEmpty: true });
  }

  /**
   * `GET /meta/actions/:id` or `GET /meta/actions?k1=v1&k2=v2` — the
   * row-level actions the caller may run on one row right now, and the
   * reasons of those disabled with one: `{ actions, disabledReasons? }`.
   * Works for rows the caller cannot read; an unknown or out-of-scope id
   * resolves to `{ actions: [] }`. Id forms as {@link one}.
   *
   * @since 0.1.145
   */
  async availableActions(id: Id<T>): Promise<TDbAvailableActions> {
    return this._request("GET", this._idUrl("meta/actions", id)) as Promise<TDbAvailableActions>;
  }

  /**
   * Fetches and caches the deserialized form schema for an action's
   * `@InputForm()` parameter. Returns `null` when the action has no form
   * declared, or doesn't exist on `/meta`. Callers typically pass the
   * returned annotated type to a form-renderer (e.g. `@atscript/ui` form
   * components) and then submit the collected payload through
   * {@link action}'s `input` argument.
   *
   * The schema comes from this controller's `meta/form/:name`, or — when the
   * action carries `formUrl` — from `baseUrl + formUrl`.
   * Cached per resolved URL.
   */
  async getActionForm(actionName: string): Promise<TAtscriptAnnotatedType | null> {
    const meta = await this.meta();
    const action = meta.actions.find((a) => a.name === actionName);
    if (!action?.inputForm) return null;
    const url = action.formUrl
      ? `${this._baseUrl}${action.formUrl}`
      : this._endpointUrl(`meta/form/${encodeURIComponent(action.inputForm)}`);
    return this._loadActionForm(url);
  }

  private _loadActionForm(url: string): Promise<TAtscriptAnnotatedType> {
    this._syncLocale();
    let p = this._formCache.get(url);
    if (!p) {
      // Loaded on demand, like the preflight validator, so importing the
      // client keeps `@atscript/typescript/utils` out of an app's first chunk.
      const loading: Promise<TAtscriptAnnotatedType> = Promise.all([
        this._requestUrl("GET", url) as Promise<TSerializedAnnotatedType>,
        import("@atscript/typescript/utils"),
      ])
        .then(([schema, { deserializeAnnotatedType }]) => deserializeAnnotatedType(schema))
        .catch((err) => {
          if (this._formCache.get(url) === loading) this._formCache.delete(url);
          throw err;
        });
      p = loading;
      this._formCache.set(url, p);
    }
    return p;
  }

  // ── Validation (client utility) ────────────────────────────────────────────

  /**
   * Returns a lazily-initialized {@link ClientValidator} backed by the `/meta` type.
   * Useful for accessing `flatMap` and `navFields` (e.g. for form generation).
   */
  getValidator(): Promise<ClientValidator> {
    return this._getValidator();
  }

  /** Lifts `$cas` to the wire shape, normalizes, then validates the result — which is what gets sent. */
  private async _prepareWrite(data: unknown, mode: ValidatorMode): Promise<unknown> {
    const validator = await this._getValidator();
    const prepared = validator.normalize(validator.liftCas(data, mode), mode);
    validator.validate(prepared, mode);
    return prepared;
  }

  private _getValidator(): Promise<ClientValidator> {
    this._syncLocale();
    if (!this._validatorPromise) {
      const p: Promise<ClientValidator> = Promise.all([this.meta(), import("./validator")])
        .then(([m, { createClientValidator }]) =>
          createClientValidator(m, { lenientWrites: this._lenientWrites }),
        )
        .catch((err) => {
          if (this._validatorPromise === p) this._validatorPromise = undefined;
          throw err;
        });
      this._validatorPromise = p;
    }
    return this._validatorPromise;
  }

  // ── Action helpers ─────────────────────────────────────────────────────────

  private _buildActionBody(action: TDbActionInfo, id: unknown, input: unknown): unknown {
    const envelope: { ids?: unknown; input?: unknown } = {};
    switch (action.level) {
      case "rows":
        if (id === undefined) {
          envelope.ids = [];
        } else if (!Array.isArray(id)) {
          throw new TypeError(
            `client.action("${action.name}"): rows-level actions require an array of identifier objects; received ${describeShape(id)}.`,
          );
        } else {
          envelope.ids = id;
        }
        break;
      case "row":
        if (id === null || typeof id !== "object" || Array.isArray(id)) {
          throw new TypeError(
            `client.action("${action.name}"): row-level actions require an identifier object; received ${describeShape(id)}.`,
          );
        }
        envelope.ids = id;
        break;
      case "table":
        // Bare table-level action with no input → no body sent at all.
        if (input === undefined) return undefined;
        break;
    }
    if (input !== undefined) envelope.input = input;
    return envelope;
  }

  private _interpolateNavigateUrl(
    action: TDbActionInfo,
    id: unknown,
    preferredId: readonly string[],
  ): string {
    if (action.level !== "row") return action.value;
    if (id === undefined) return action.value;
    if (id === null || typeof id !== "object" || Array.isArray(id)) {
      throw new TypeError(
        `client.action("${action.name}"): row-level navigate actions require an identifier object; received ${describeShape(id)}.`,
      );
    }
    return action.value.replace(
      /\$1/g,
      encodeNavigateId(id as Record<string, unknown>, preferredId),
    );
  }

  private async _dispatchNavigate(action: TDbActionInfo, url: string): Promise<void> {
    if (this._navigate) {
      await this._navigate(url);
      return;
    }
    const loc = (globalThis as { location?: { assign?: (url: string) => void } }).location;
    if (loc?.assign) {
      loc.assign(url);
      return;
    }
    throw new ActionUnsupportedError(
      action.name,
      "navigate",
      `Action "${action.name}" is processor: 'navigate' but no browser is available and no \`navigate\` option was provided to Client.`,
    );
  }

  private _postAction(action: TDbActionInfo, body: unknown): Promise<unknown> {
    return this._requestUrl("POST", `${this._baseUrl}${action.value}`, body, { allowEmpty: true });
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _idToParams(id: Record<string, unknown>): URLSearchParams {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(id)) {
      params.set(k, String(v));
    }
    return params;
  }

  /**
   * The endpoint addressing one row under `base`: `base/<id>` for a scalar
   * id, `base?k1=v1&k2=v2` for an object id; `query` (a query string) is
   * appended.
   */
  private _idUrl(base: string, id: unknown, query = ""): string {
    if (id !== null && typeof id === "object") {
      const params = this._idToParams(id as Record<string, unknown>);
      for (const [k, v] of new URLSearchParams(query)) params.set(k, v);
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }
    const path = `${base ? `${base}/` : ""}${encodeURIComponent(String(id))}`;
    return query ? `${path}?${query}` : path;
  }

  private async _getOrNull<Q>(
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<Response<T, Q> | null> {
    try {
      return (await this._request("GET", endpoint, undefined, { signal })) as Response<T, Q>;
    } catch (e) {
      if (e instanceof ClientError && e.status === 404) return null;
      throw e;
    }
  }

  private async _get(endpoint: string, query?: Uniquery, signal?: AbortSignal): Promise<unknown> {
    const qs = query ? buildUrl(query) : "";
    return this._request("GET", `${endpoint}${qs ? `?${qs}` : ""}`, undefined, { signal });
  }

  private async _resolveHeaders(locale = this._currentLocale()): Promise<Record<string, string>> {
    const headers = !this._headers
      ? {}
      : typeof this._headers === "function"
        ? await this._headers()
        : this._headers;
    if (locale === undefined || hasHeader(headers, "accept-language")) return headers;
    return { ...headers, "Accept-Language": locale };
  }

  /** `ClientOptions.locale` now. */
  private _currentLocale(): string | undefined {
    return typeof this._locale === "function" ? this._locale() : this._locale;
  }

  /** {@link _currentLocale}, after dropping the `/meta`, validator and forms loaded in another one. */
  private _syncLocale(): string | undefined {
    const locale = this._currentLocale();
    if (locale !== this._metaLocale) {
      this.invalidateMeta();
      this._metaLocale = locale;
    }
    return locale;
  }

  /**
   * `GET /meta` through the meta store: conditional when the store holds
   * bodies for this key, falling back to a plain request whenever the
   * conditional one cannot be answered from the store.
   */
  private async _loadMeta(
    locale: string | undefined,
  ): Promise<{ body: MetaResponse; etag?: string }> {
    const url = this._endpointUrl("meta");
    const store = this._metaStore;
    if (!store) {
      const res = await this._fetchUrl(url, {
        method: "GET",
        headers: await this._resolveHeaders(locale),
      });
      const body = (await this._readResponse(res, url, "GET", false)) as MetaResponse;
      return { body, etag: res.ok ? readEtag(res) : undefined };
    }
    // One store entry per locale: each language is served with its own ETag.
    const base = this._metaKey ?? url;
    const key = locale === undefined ? base : `${base}#${locale}`;
    const headers = await this._resolveHeaders(locale);
    const candidates = store._isUnconditional(key) ? [] : store.candidates(key);
    if (candidates.length > 0) {
      const init: RequestInit = {
        method: "GET",
        headers: { ...headers, "If-None-Match": candidates.join(", ") },
      };
      let res: Awaited<ReturnType<typeof globalThis.fetch>> | undefined;
      try {
        res = await this._fetchUrl(url, init);
      } catch {
        // Retried below without the header. If that one succeeds, the
        // conditional request itself is what fails (typically a cross-origin
        // server whose CORS preflight does not allow `If-None-Match`).
      }
      if (res && res.status === 304) {
        const etag = readEtag(res);
        const text = etag === undefined ? undefined : store._reuse(key, etag);
        if (text !== undefined) return { body: JSON.parse(text) as MetaResponse, etag };
        // No (readable) ETag or one this store no longer holds: refetch.
      } else if (res) {
        return this._storeMeta(store, key, url, res);
      } else {
        const fallback = await this._fetchUrl(url, { method: "GET", headers: { ...headers } });
        store._markUnconditional(key);
        return this._storeMeta(store, key, url, fallback);
      }
    }
    const res = await this._fetchUrl(url, { method: "GET", headers: { ...headers } });
    return this._storeMeta(store, key, url, res);
  }

  /** Reads a `/meta` response; a `2xx` carrying a readable `ETag` goes into the store. */
  private async _storeMeta(
    store: MetaStore,
    key: string,
    url: string,
    res: Awaited<ReturnType<typeof globalThis.fetch>>,
  ): Promise<{ body: MetaResponse; etag?: string }> {
    const etag = res.ok ? readEtag(res) : undefined;
    if (etag === undefined || typeof res.text !== "function") {
      return { body: (await this._readResponse(res, url, "GET", false)) as MetaResponse, etag };
    }
    let body: MetaResponse;
    let text: string;
    try {
      text = await res.text();
      body = JSON.parse(text) as MetaResponse;
    } catch (cause) {
      throw new TransportError(
        "GET",
        url,
        `HTTP ${res.status} body is not JSON (${describeCause(cause)})`,
        cause,
      );
    }
    store._put(key, etag, text);
    return { body, etag };
  }

  private _request(
    method: THttpMethod,
    endpoint: string,
    body?: unknown,
    opts?: TRequestOptions,
  ): Promise<unknown> {
    return this._requestUrl(method, this._endpointUrl(endpoint), body, opts);
  }

  /** `baseUrl + path` joined with an endpoint relative to this controller (`""`, `meta`, `?q`…). */
  private _endpointUrl(endpoint: string): string {
    const sep = endpoint && !endpoint.startsWith("?") ? "/" : "";
    return `${this._baseUrl}${this._path}${sep}${endpoint}`;
  }

  /** Sends one request to an absolute URL with the client's headers and a JSON body. */
  private async _requestUrl(
    method: THttpMethod,
    url: string,
    body?: unknown,
    opts?: TRequestOptions,
  ): Promise<unknown> {
    const headers: Record<string, string> = { ...(await this._resolveHeaders()), ...opts?.headers };
    const init: RequestInit = { method, headers };
    if (opts?.signal) init.signal = opts.signal;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return this._send(url, init, opts?.allowEmpty === true);
  }

  private async _send(url: string, init: RequestInit, allowEmpty: boolean): Promise<unknown> {
    const res = await this._fetchUrl(url, init);
    return this._readResponse(res, url, init.method ?? "GET", allowEmpty);
  }

  /** `fetch` with a network failure surfaced as {@link TransportError}. */
  private async _fetchUrl(
    url: string,
    init: RequestInit,
  ): Promise<Awaited<ReturnType<typeof globalThis.fetch>>> {
    try {
      return await this._fetch(url, init);
    } catch (cause) {
      // No verdict: the request may or may not have reached the server.
      throw new TransportError(init.method ?? "GET", url, describeCause(cause), cause);
    }
  }

  /** A response's JSON body, or the matching error for a non-2xx status. */
  private async _readResponse(
    res: Awaited<ReturnType<typeof globalThis.fetch>>,
    url: string,
    method: string,
    allowEmpty: boolean,
  ): Promise<unknown> {
    if (!res.ok) {
      let errorBody: Record<string, unknown>;
      try {
        errorBody = (await res.json()) as Record<string, unknown>;
      } catch {
        // Non-JSON error page (proxy / gateway): keep `body.message` non-empty
        // even when the response carries no statusText (HTTP/2 has none).
        errorBody = { message: res.statusText || `HTTP ${res.status}`, statusCode: res.status };
      }
      if (errorBody.name === "ActionDisabledError") {
        throw new ActionDisabledError(res.status, errorBody as unknown as ActionDisabledErrorBody);
      }
      if (errorBody.name === "ActionTargetError") {
        throw new ActionTargetError(res.status, errorBody as unknown as ActionTargetErrorBody);
      }
      if (errorBody.kind === "version_mismatch") {
        throw new VersionMismatchError(
          res.status,
          errorBody as unknown as VersionMismatchErrorBody,
        );
      }
      throw new ClientError(res.status, errorBody as never);
    }
    if (!allowEmpty) {
      try {
        return await res.json();
      } catch (cause) {
        // A 2xx whose required body is not JSON — the server answered, but
        // its answer is unreadable, so the caller has no usable verdict.
        throw new TransportError(
          method,
          url,
          `HTTP ${res.status} body is not JSON (${describeCause(cause)})`,
          cause,
        );
      }
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") return undefined;
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
}

/** Whether `headers` has `name` (lower case), in any letter case. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  for (const key in headers) {
    if (key.toLowerCase() === name) return true;
  }
  return false;
}

/**
 * The response's `ETag`, when readable — a cross-origin response hides it
 * unless the server sends `Access-Control-Expose-Headers: ETag`.
 */
function readEtag(res: { headers?: { get?(name: string): string | null } }): string | undefined {
  return res.headers?.get?.("etag") || undefined;
}

/** One-line rendering of a thrown value for a `TransportError` message. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  return String(cause);
}

/** The value at a dot `path` of `row`. */
function valueAt(row: Record<string, unknown>, path: string): unknown {
  // A flat key spelled like the path (`{ "ticket.id": 1 }`) wins over walking.
  if (!path.includes(".") || Object.hasOwn(row, path)) return row[path];
  let v: unknown = row;
  for (const part of path.split(".")) v = (v as Record<string, unknown> | null | undefined)?.[part];
  return v;
}

/**
 * The identifier `action` takes for one row (or identifier) of the
 * controller whose `/meta` listed it (since 0.1.147):
 *
 * - a delegated action with `idMap` → the owner's identification,
 *   `{ [ownerField]: rowOrId[path] }` (dot paths allowed); a missing value
 *   throws `TypeError` naming the action and the path;
 * - any other action → `rowOrId`'s `preferredId` fields when it carries them
 *   all, else `rowOrId` itself (already an identifier).
 *
 * UIs build `ids` from loaded rows with it; `Client.action()` applies the
 * `idMap` mapping itself.
 *
 * @since 0.1.147
 */
export function actionIdentifier(
  action: Pick<TDbActionInfo, "name" | "idMap">,
  rowOrId: Record<string, unknown>,
  preferredId: readonly string[],
): Record<string, unknown> {
  if (action.idMap) {
    const out: Record<string, unknown> = {};
    for (const [field, path] of Object.entries(action.idMap)) {
      const value = valueAt(rowOrId, path);
      if (value === undefined || value === null) {
        throw new TypeError(
          `client.action("${action.name}"): the identifier has no "${path}" — needed for the owner's "${field}".`,
        );
      }
      out[field] = value;
    }
    return out;
  }
  if (preferredId.length > 0 && preferredId.every((f) => rowOrId[f] !== undefined)) {
    return Object.fromEntries(preferredId.map((f) => [f, rowOrId[f]]));
  }
  return rowOrId;
}

/** `action()`'s `id` argument through a delegated action's `idMap` (shape errors are left to the body builder). */
function mapDelegatedIds(action: TDbActionInfo, id: unknown): unknown {
  const map = (one: unknown): unknown =>
    one !== null && typeof one === "object" && !Array.isArray(one)
      ? actionIdentifier(action, one as Record<string, unknown>, [])
      : one;
  return Array.isArray(id) ? id.map(map) : map(id);
}

/** The wire `query` of a {@link TDbQueryTarget}. */
function queryTargetBody(target: TDbQueryTarget<any>): Record<string, unknown> {
  const controls: Record<string, unknown> = {};
  if (target.search !== undefined) controls.$search = target.search;
  if (target.index !== undefined) controls.$index = target.index;
  const q = buildUrl({ filter: target.filter ?? {}, controls } as Uniquery);
  const out: Record<string, unknown> = { q };
  if (target.exclude?.length) out.exclude = target.exclude;
  if (target.expectCount !== undefined) out.expectCount = target.expectCount;
  if (target.maxRows !== undefined) out.maxRows = target.maxRows;
  return out;
}

/**
 * Render a single identifier field for substitution into a navigate-URL
 * template or human-readable string. `null` / `undefined` collapse to `""`
 * (NOT the literal `"undefined"` / `"null"` that `String()` would produce).
 */
export function formatIdentifierField(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

/**
 * Render a row identifier as a `/`-joined string in `preferredId`
 * declaration order — NOT object-key insertion order (which is unstable
 * across callers). Raw form, no URL-encoding; for prompt text, error
 * messages, log lines, etc.
 */
export function formatIdentifier(
  id: Record<string, unknown> | undefined,
  preferredId: readonly string[],
): string {
  if (id === undefined) return "";
  return preferredId.map((f) => formatIdentifierField(id[f])).join("/");
}

/**
 * URL-encoded form of `formatIdentifier` — for `processor: 'navigate'`
 * `$1` substitution. Each field is `encodeURIComponent`'d, then joined
 * with a literal `/`. Missing fields render as empty segments (e.g.
 * `acme//jane`), not the literal `"undefined"`.
 */
export function encodeNavigateId(
  id: Record<string, unknown>,
  preferredId: readonly string[],
): string {
  return preferredId.map((f) => encodeURIComponent(formatIdentifierField(id[f]))).join("/");
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
