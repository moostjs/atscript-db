import type {
  AtscriptDbReadable,
  TDbActionInfo,
  TDbAvailableActions,
  TViewColumnMapping,
} from "@atscript/db";
import { HttpError, type MoostHttp } from "@moostjs/event-http";
import type { EventContext } from "@wooksjs/event-core";
import { withControllerContext, type Moost, type TConsoleBase, type TIsolatedSlot } from "moost";

import { getAtscriptDbMate } from "../mate";
import { boundTableKey } from "./controller-access";
import { isAsDbReadableControllerSubclass } from "./controller-registry";
import { maxIdsOfOpts } from "./current-action";
import { discoverActions, discoverRowLevelActions, type TDbActionEnvelope } from "./discover";
import { dbActionIdSlot, dbActionIdsSlot, useDbActionId, useDbActionIds } from "./id-cache";
import { dbActionBodySlot, dbActionInputSlot, useDbActionInput } from "./input-form-cache";
import { WARN_PREFIX, type TDbActionsFromMeta } from "./keys";
import { dbActionPreparedSlot } from "./prepare-request";
import {
  dbActionQueryTargetSlot,
  dbActionSkippedKey,
  dbActionStaleKey,
  queryTargetLimitsOf,
  streamedQueryTargetSlot,
  type TQueryTargetLimits,
  type TSkippedRow,
} from "./query-target";
import { dbActionRowSlot, dbActionRowsSlot, useDbActionRow, useDbActionRows } from "./row-cache";
import { dbActionOverlaySlot, scopedControllerSlot } from "./row-scope";
import { idKey } from "./rows-by-id";
import { dbActionTargetKey, type TDbActionTarget } from "./target";

/** Internal: a source controller's batch `$actions` verdicts for delegated ids. */
export const ACTION_VERDICTS = Symbol.for("atscript-db.actionVerdicts");
/** Internal: a source controller's `GET /meta/actions/:id` answer for one id. */
export const AVAILABLE_ACTIONS = Symbol.for("atscript-db.availableActions");
/** Internal: the subset of delegated action names a source controller lists for the caller. */
export const ALLOWED_ACTIONS = Symbol.for("atscript-db.allowedActions");

/** The internal surface a delegating controller calls on its source (inside {@link runAsController}). */
export interface TDelegateSource {
  [ACTION_VERDICTS](
    ids: Record<string, unknown>[],
    names: readonly string[],
  ): Promise<Array<TDbAvailableActions | undefined>>;
  [AVAILABLE_ACTIONS](
    id: Record<string, unknown>,
    names: readonly string[],
  ): Promise<TDbAvailableActions>;
  [ALLOWED_ACTIONS](names: readonly string[]): Promise<readonly string[]>;
}

/**
 * The route a view serves a delegated action's query target on (relative to
 * the view's prefix; `:name` = the action).
 */
export const DELEGATED_QUERY_ROUTE = "delegated-actions";

// ── Delegated evaluation: the source "as itself" in the same request ────────

/**
 * The per-event state of the actions module (slots and composables) — never
 * read through from the delegating event: a child computes its own.
 */
export const ACTION_SLOTS: readonly TIsolatedSlot[] = [
  dbActionBodySlot,
  dbActionInputSlot,
  dbActionIdSlot,
  dbActionIdsSlot,
  dbActionRowSlot,
  dbActionRowsSlot,
  dbActionOverlaySlot,
  scopedControllerSlot,
  dbActionPreparedSlot,
  dbActionQueryTargetSlot,
  streamedQueryTargetSlot,
  dbActionSkippedKey,
  dbActionStaleKey,
  dbActionTargetKey,
  boundTableKey,
  useDbActionId,
  useDbActionIds,
  useDbActionRow,
  useDbActionRows,
  useDbActionInput,
];

/**
 * Runs `fn` in a copy-on-write child of the current event with `instance` /
 * `method` as its controller context (moost `withControllerContext`) — the
 * controller's hooks (`prepareRequest`, `allowedActions`, `actionRowScope`,
 * a permission layer reading the current controller) run as if the request
 * had been routed to it, without touching the current event's state. The
 * child shares the event's DI scope (`FOR_EVENT` dependencies resolve) and
 * never reads the actions module's per-event state through.
 */
export function runAsController<R>(instance: object, method: string, fn: () => R): R {
  return withControllerContext(instance, method, fn, { isolate: ACTION_SLOTS });
}

/** `true` when `error` is the 401 / 403 a permission layer refuses a caller with. */
export function isAuthRefusal(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  const status = error.body.statusCode as number;
  return status === 401 || status === 403;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/** One `@DbActionsFrom` source of a controller, validated and resolved. */
export interface TDelegation {
  /** The source controller class. */
  source: Function;
  /** The source's server-absolute base path. */
  prefix: string;
  /** The source's row / rows-level envelopes delegated, in its `/meta` order. */
  envelopes: TDbActionEnvelope[];
  names: string[];
  /** The `/meta.actions` entries the delegating controller lists (`owner`, `idMap`, …). */
  infos: TDbActionInfo[];
  /** Source identification field → path in the delegating controller's rows. */
  idMap: Readonly<Record<string, string>>;
  /** The delegating controller's paths of {@link idMap}. */
  paths: readonly string[];
  /** Per delegated action accepting a query target: its limits and `maxIds`. */
  queryTargets: ReadonlyMap<string, TQueryTargetLimits & { maxIds: number; route: string }>;
}

/** What discovery reads off the delegating controller. */
export interface TDelegatingController {
  ctor: Function;
  readable: AtscriptDbReadable<any>;
  /** The app the current event runs in (resolved through DI per event, never a stale one). */
  app: Moost;
  logger: TConsoleBase;
  /** Resolves the source controller instance for the current event (moost DI). */
  instantiate(ctor: Function): Promise<object>;
}

const delegationCache = new WeakMap<Moost, WeakMap<Function, Promise<TDelegation[]>>>();

/** `true` when the controller class declares `@DbActionsFrom` (inherited included). */
export function hasActionDelegations(ctor: Function): boolean {
  return (getAtscriptDbMate().read(ctor)?.atscript_db_actions_from?.length ?? 0) > 0;
}

/**
 * The `@DbActionsFrom` delegations of a controller class, validated against
 * the sources bound in `view.app` (memoized per app and class; a
 * configuration error is never memoized — it is thrown at every `/meta`,
 * read or `/meta/actions` that needs it).
 */
export function discoverDelegations(view: TDelegatingController): Promise<TDelegation[]> {
  let perApp = delegationCache.get(view.app);
  if (!perApp) {
    perApp = new WeakMap();
    delegationCache.set(view.app, perApp);
  }
  let found = perApp.get(view.ctor);
  if (!found) {
    const pending = buildDelegations(view);
    found = pending;
    perApp.set(view.ctor, pending);
    pending.catch(() => {
      if (perApp.get(view.ctor) === pending) perApp.delete(view.ctor);
    });
  }
  return found;
}

interface TSourceReadable {
  tableName: string;
  preferredId: readonly string[];
  identifications: readonly { fields: readonly string[] }[];
  fieldDescriptors: readonly { path: string; physicalName: string }[];
}

function normalizePrefix(prefix: string): string {
  const p = `/${prefix}`.replaceAll(/\/+/g, "/");
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function prefixOf(app: Moost, ctor: Function): string | undefined {
  const overview = app.getControllersOverview?.()?.find((o) => o.type === ctor);
  return overview === undefined ? undefined : normalizePrefix(overview.computedPrefix);
}

async function buildDelegations(view: TDelegatingController): Promise<TDelegation[]> {
  const metas = getAtscriptDbMate().read(view.ctor)?.atscript_db_actions_from ?? [];
  const viewName = view.ctor.name;
  const viewPrefix = prefixOf(view.app, view.ctor) ?? "";
  const taken = new Map<string, string>();
  for (const e of discoverActions(view.ctor, view.app, view.logger)) {
    taken.set(e.info.name, viewName);
  }
  const out: TDelegation[] = [];
  for (const meta of metas) {
    out.push(await buildDelegation(view, viewName, viewPrefix, meta, taken));
  }
  return out;
}

async function buildDelegation(
  view: TDelegatingController,
  viewName: string,
  viewPrefix: string,
  meta: TDbActionsFromMeta,
  taken: Map<string, string>,
): Promise<TDelegation> {
  const fail: (message: string) => never = (message) => {
    throw new Error(`${WARN_PREFIX} @DbActionsFrom on ${viewName}: ${message}`);
  };
  const source = meta.source();
  if (typeof source !== "function") fail("the source reference does not resolve to a class");
  const sourceName = source.name;
  const prefix = prefixOf(view.app, source);
  if (prefix === undefined) fail(`${sourceName} is not a controller registered with the app`);
  if (!isAsDbReadableControllerSubclass(source)) {
    fail(`${sourceName} is not an AsDbReadableController`);
  }
  const instance = (await view.instantiate(source)) as { readable?: TSourceReadable };
  const readable = instance.readable;
  if (!readable) fail(`${sourceName} has no bound readable`);

  const all = discoverActions(source, view.app, view.logger);
  const rowLevel = discoverRowLevelActions(source, view.app, view.logger);
  const names = meta.actions ? [...meta.actions] : rowLevel.map((e) => e.info.name);
  for (const name of names) {
    const found = all.find((e) => e.info.name === name);
    if (!found) fail(`${sourceName} has no action "${name}"`);
    if (found.info.level === "table") {
      fail(`"${name}" of ${sourceName} is a table-level action — only row / rows actions delegate`);
    }
    const owner = taken.get(name);
    if (owner !== undefined) fail(`action "${name}" of ${sourceName} collides with ${owner}'s`);
    taken.set(name, sourceName);
  }
  const wanted = new Set(names);
  const envelopes = rowLevel.filter((e) => wanted.has(e.info.name));

  const idMap = meta.idMap
    ? checkIdMap(meta.idMap, readable, view.readable, sourceName, fail)
    : deriveIdMap(readable, view.readable, sourceName, fail);
  const paths = Object.values(idMap);
  const preferred = view.readable.preferredId ?? [];
  const identical =
    Object.entries(idMap).every(([k, v]) => k === v) &&
    paths.length === preferred.length &&
    preferred.every((f) => paths.includes(f));

  const queryTargets = new Map<string, TQueryTargetLimits & { maxIds: number; route: string }>();
  const infos = envelopes.map((e) => {
    const { disabled: _disabled, queryTarget, ...rest } = e.info;
    const info: TDbActionInfo = { ...rest, owner: prefix };
    if (!identical) info.idMap = { ...idMap };
    if (info.inputForm && !info.formUrl) {
      info.formUrl = `${prefix}/meta/form/${encodeURIComponent(info.inputForm)}`;
    }
    const limits = queryTarget ? queryTargetLimitsOf(e.raw) : undefined;
    // Only a static source route: `value` renders a `:param` as `{param}`.
    if (limits && !/[{:*]/.test(e.info.value)) {
      const maxIds = maxIdsOfOpts(e.raw);
      queryTargets.set(e.info.name, { ...limits, maxIds, route: e.info.value });
      info.queryTarget = {
        maxRows: limits.maxRows,
        url: `${viewPrefix}/${DELEGATED_QUERY_ROUTE}/${encodeURIComponent(e.info.name)}`,
      };
    }
    return info;
  });
  return {
    source,
    prefix,
    envelopes,
    names: envelopes.map((e) => e.info.name),
    infos,
    idMap,
    paths,
    queryTargets,
  };
}

function checkIdMap(
  idMap: Record<string, string>,
  source: TSourceReadable,
  view: AtscriptDbReadable<any>,
  sourceName: string,
  fail: (message: string) => never,
): Record<string, string> {
  const keys = Object.keys(idMap).toSorted();
  const matches = source.identifications.some(
    (ident) =>
      ident.fields.length === keys.length && ident.fields.toSorted().every((f, i) => f === keys[i]),
  );
  if (!matches) {
    fail(
      `idMap keys [${keys.join(", ")}] are not an identification of ${sourceName} ` +
        `(${source.identifications.map((i) => `[${i.fields.join(", ")}]`).join(", ")})`,
    );
  }
  for (const [field, path] of Object.entries(idMap)) {
    if (typeof path !== "string" || !view.flatMap.has(path)) {
      fail(`idMap "${field}" → "${path}": no such field on "${view.tableName}"`);
    }
  }
  return { ...idMap };
}

function deriveIdMap(
  source: TSourceReadable,
  view: AtscriptDbReadable<any>,
  sourceName: string,
  fail: (message: string) => never,
): Record<string, string> {
  const mappingsOf = (view as { getViewColumnMappings?: () => TViewColumnMapping[] })
    .getViewColumnMappings;
  if (!view.isView || typeof mappingsOf !== "function") {
    fail(`"${view.tableName}" is not a view — pass an explicit idMap`);
  }
  const mappings = mappingsOf.call(view);
  if (source.preferredId.length === 0) fail(`${sourceName} has no primary key`);
  const out: Record<string, string> = {};
  for (const field of source.preferredId) {
    const physical = source.fieldDescriptors.find((fd) => fd.path === field)?.physicalName ?? field;
    const candidates = mappings.filter(
      (m) =>
        m.sourceTable === source.tableName &&
        m.sourceColumn === physical &&
        m.aggFn === undefined &&
        m.json === undefined,
    );
    if (candidates.length !== 1) {
      fail(
        `cannot derive where "${source.tableName}.${field}" is in view "${view.tableName}" ` +
          `(${candidates.length === 0 ? "no plain column maps it" : "several columns map it"}) — pass idMap`,
      );
    }
    out[field] = candidates[0].viewPath;
  }
  return out;
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
 * The deduped source identities of `rows` through `idMap` and, per row, its
 * index in `ids` (`-1`: a mapped value is missing — no source row).
 */
export function mapToSourceIds(
  rows: readonly Record<string, unknown>[],
  idMap: Readonly<Record<string, string>>,
): { ids: Record<string, unknown>[]; index: number[] } {
  const fields = Object.keys(idMap).toSorted();
  const ids: Record<string, unknown>[] = [];
  const index: number[] = [];
  const byKey = new Map<string, number>();
  for (const row of rows) {
    const id: Record<string, unknown> = {};
    let complete = true;
    for (const [field, path] of Object.entries(idMap)) {
      const value = valueAt(row, path);
      if (value === undefined || value === null) {
        complete = false;
        break;
      }
      id[field] = value;
    }
    const k = complete ? idKey(id, fields) : undefined;
    if (k === undefined) {
      index.push(-1);
      continue;
    }
    let at = byKey.get(k);
    if (at === undefined) {
      at = ids.push(id) - 1;
      byKey.set(k, at);
    }
    index.push(at);
  }
  return { ids, index };
}

// ── Running the source's action pipeline (delegated query targets) ──────────

/** What one batch through the source's action route reports. */
export interface TSourceBatchOutcome {
  processed: number;
  skipped: TSkippedRow[];
  failed: { id: Record<string, unknown>; reason: string }[];
  /** The source's handler ran (its gate let at least part of the batch through). */
  ran: boolean;
  /**
   * The batch failed (any error but the gate's own refusal, which is
   * retried): the ids still pending are NOT counted anywhere — the caller
   * decides (rethrow when nothing ran yet, else abort with a partial summary).
   */
  error?: unknown;
  /** The ids the failed attempt carried. */
  pending?: Record<string, unknown>[];
  /** The `message` (a string) the source's handler returned. */
  message?: string;
}

/**
 * Runs the source's own `POST route` for `ids` (one batch) inside the
 * current request (`MoostHttp.invoke`) — its whole pipeline: guards and
 * other interceptors, `prepareRequest`, the row overlay, `actionRowScope`,
 * `disabled`, `@InputForm` validation, the handler — with the body
 * `{ ids, input }` (every body reader of the source sees it, never the
 * delegating request's). A batch the gate refuses before the handler ran
 * (409 `ActionDisabledError`) is retried once without the ids it named, so
 * every batch runs with skip semantics; any other error — or a refusal the
 * handler itself threw — is returned as `error` (with the ids it carried and
 * whether the handler ran).
 */
export async function runSourceActionBatch(
  http: MoostHttp,
  route: string,
  ids: Record<string, unknown>[],
  input: unknown,
): Promise<TSourceBatchOutcome> {
  const outcome: TSourceBatchOutcome = { processed: 0, skipped: [], failed: [], ran: false };
  let pending = ids;
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    let child: EventContext | undefined;
    const body = input === undefined ? { ids: pending } : { ids: pending, input };
    let result: unknown;
    try {
      result = await http.invoke("POST", route, {
        body,
        isolate: ACTION_SLOTS,
        prepare: (ctx) => {
          child = ctx;
        },
      });
    } catch (error) {
      // Only the GATE's refusal (before the handler ran: no target yet) is
      // retried — a handler that threw it may have mutated rows already.
      const handlerRan = child?.hasOwn(dbActionTargetKey) === true;
      const refused = handlerRan ? undefined : disabledIds(error);
      if (!refused || attempt > 0) {
        if (handlerRan) outcome.ran = true;
        outcome.error = error;
        outcome.pending = pending;
        return outcome;
      }
      outcome.skipped.push(...refused.skipped);
      const refusedKeys = new Set(refused.skipped.map((s) => keyOf(s.id)));
      pending = pending.filter((id) => !refusedKeys.has(keyOf(id)));
      continue;
    }
    collectOutcome(child!, pending, outcome);
    const message = (result as { message?: unknown } | null | undefined)?.message;
    if (typeof message === "string") outcome.message = message;
    break;
  }
  return outcome;
}

function keyOf(id: Record<string, unknown>): string {
  return idKey(id, Object.keys(id).toSorted()) ?? "";
}

/** The ids (+ reasons) of an `ActionDisabledError` thrown by the source's gate. */
function disabledIds(error: unknown): { skipped: TSkippedRow[] } | undefined {
  if (!(error instanceof HttpError) || error.name !== "ActionDisabledError") return undefined;
  const body = error.body as unknown as {
    ids?: Record<string, unknown>[];
    reasons?: (string | null)[];
    reason?: string;
  };
  if (!Array.isArray(body.ids)) return undefined;
  return {
    skipped: body.ids.map((id, i) => {
      const reason = body.reasons?.[i] ?? body.reason ?? undefined;
      return reason ? { id, reason } : { id };
    }),
  };
}

/**
 * What the source's gate / handler left in the child event: its target's
 * summary. No target → the handler never ran (an interceptor answered
 * instead): every id of the batch failed as `"not run"`.
 */
function collectOutcome(
  child: EventContext,
  ids: Record<string, unknown>[],
  outcome: TSourceBatchOutcome,
): void {
  if (!child.hasOwn(dbActionTargetKey)) {
    for (const id of ids) outcome.failed.push({ id, reason: "not run" });
    return;
  }
  outcome.ran = true;
  const summary = (child.getOwn(dbActionTargetKey) as TDbActionTarget).summary();
  outcome.processed += summary.processed;
  outcome.skipped.push(...summary.skipped);
  outcome.failed.push(...summary.failed);
}
