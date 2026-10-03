import { cached, key, type EventContext } from "@wooksjs/event-core";

import { targetInvalid } from "./action-target-error";
import { actionMaxIds, readCurrentActionMeta } from "./current-action";
import { dbActionBodySlot } from "./input-form-cache";
import { awaitActionPrepared } from "./prepare-request";
import { scopedControllerSlot } from "./row-scope";

/**
 * A query target — the `query` of an action request body: "every row
 * matching this query" instead of a list of identifiers (since 0.1.147).
 *
 * @since 0.1.147
 */
export interface TDbActionQueryTarget {
  /** The query string `GET /query` accepts — filter plus `$search` / `$index` ONLY. */
  q: string;
  /** Identifiers to leave out (any identification; at most the action's `maxIds`). */
  exclude?: Record<string, unknown>[];
  /** Guard: the request fails with 409 `TARGET_CHANGED` when the match count differs. */
  expectCount?: number;
  /** Client-side cap (it never raises the server's `maxRows`). */
  maxRows?: number;
  /** Resolve and count only — the reply is `{ matched }`, the handler does not run. */
  dryRun?: boolean;
}

/** `queryTarget` of `@DbAction` options. `true` = the defaults. @since 0.1.147 */
export type TDbQueryTargetOpts = boolean | { maxRows?: number; batchSize?: number };

/** {@link TDbQueryTargetOpts} with the defaults applied. */
export interface TQueryTargetLimits {
  maxRows: number;
  batchSize: number;
}

/** Default most rows one query target may match. */
export const DEFAULT_QUERY_TARGET_MAX_ROWS = 10_000;
/** Default rows per execution batch of a query target. */
export const DEFAULT_QUERY_TARGET_BATCH_SIZE = 500;

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The `queryTarget` limits declared in `opts`, `undefined` when the action accepts none. */
export function queryTargetLimitsOf(opts: unknown): TQueryTargetLimits | undefined {
  const raw = (opts as { queryTarget?: unknown } | undefined)?.queryTarget;
  if (!raw) return undefined;
  const o = typeof raw === "object" ? (raw as { maxRows?: unknown; batchSize?: unknown }) : {};
  return {
    maxRows: positiveInt(o.maxRows) ?? DEFAULT_QUERY_TARGET_MAX_ROWS,
    batchSize: positiveInt(o.batchSize) ?? DEFAULT_QUERY_TARGET_BATCH_SIZE,
  };
}

/**
 * Key of `AsDbReadableController`'s internal query-target resolver (a
 * registered symbol, like `ACTION_OVERLAY`).
 */
export const RESOLVE_TARGET = Symbol.for("atscript-db.resolveTarget");

/** What {@link RESOLVE_TARGET} resolves. */
export interface TTargetRequest {
  action: string;
  /** The raw `query` of the request body — validated by the resolver. */
  query: unknown;
  /** The most rows the target may match (server side). */
  cap: number;
  /** The most `exclude` entries. */
  maxExclude: number;
  /**
   * The row overlay the target resolves under, besides `queryTargetScope`:
   * `"action"` — the controller's `rowOverlay()` (its own action runs on the
   * rows); `"read"` — `transformFilter` (a view resolving rows it delegates).
   */
  overlay: "action" | "read";
  /** Fields of the phase-1 read (sorted by the first identification's fields). */
  select: readonly string[];
  /** Key sets `exclude` entries may use besides the controller's identifications. */
  excludeShapes?: readonly (readonly string[])[];
}

/** A resolved query target: the phase-1 snapshot plus its re-check. */
export interface TResolvedTarget {
  /** Rows matched at phase 1 (after `exclude`). */
  matched: number;
  /** The phase-1 rows (`select` fields), ordered by identity. */
  rows: Record<string, unknown>[];
  dryRun: boolean;
  /** The validated `exclude` entries (already applied to {@link rows}). */
  exclude: Record<string, unknown>[];
  /**
   * The rows `ids` address that STILL match the target (filter, search,
   * overlay, `queryTargetScope`, `exclude`), aligned with `ids`; `select`
   * plus the id fields. The FIRST call directly follows the snapshot and is
   * not re-checked (served from {@link rows}, or read by identity alone
   * when `select` needs more fields); every later call re-checks.
   */
  load(
    ids: readonly Record<string, unknown>[],
    select: Iterable<string>,
  ): Promise<Array<Record<string, unknown> | undefined>>;
}

interface TTargetResolver {
  [RESOLVE_TARGET]?: (req: TTargetRequest) => Promise<TResolvedTarget>;
  readable?: { primaryKeys: readonly string[]; preferredId?: readonly string[] };
}

/** A resolved own-action target with its identities (`preferredId`, else the primary key). */
export interface TActionQueryTarget extends TResolvedTarget {
  ids: Record<string, unknown>[];
}

const QUERY_KEYS = new Set(["q", "exclude", "expectCount", "maxRows", "dryRun"]);

/** Validates the shape of a request body's `query` (400 `TARGET_INVALID` on any mismatch). */
export function parseQueryTargetBody(action: string, raw: unknown): TDbActionQueryTarget {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw targetInvalid(action, "`query` must be an object { q, exclude?, expectCount?, … }");
  }
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (!QUERY_KEYS.has(k)) throw targetInvalid(action, `Unknown query target key "${k}"`);
  }
  if (typeof body.q !== "string") throw targetInvalid(action, "`query.q` must be a string");
  if (body.exclude !== undefined && !Array.isArray(body.exclude)) {
    throw targetInvalid(action, "`query.exclude` must be an array of identifier objects");
  }
  const count = body.expectCount;
  if (
    count !== undefined &&
    !(typeof count === "number" && Number.isInteger(count) && count >= 0)
  ) {
    throw targetInvalid(action, "`query.expectCount` must be a non-negative integer");
  }
  if (body.maxRows !== undefined && positiveInt(body.maxRows) === undefined) {
    throw targetInvalid(action, "`query.maxRows` must be a positive integer");
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    throw targetInvalid(action, "`query.dryRun` must be a boolean");
  }
  return body as unknown as TDbActionQueryTarget;
}

/**
 * The action request's query target, resolved (phase 1) — `null` when the
 * body carries none. 400 `TARGET_INVALID` when it carries `ids` too, or the
 * action accepts no query target. Runs after the controller's
 * `prepareRequest`. `streamed`: the `@DbActionTarget` surface (no `maxIds`
 * cap — rows are processed in batches).
 */
export function resolveActionQueryTarget(
  ctx: EventContext,
  streamed: boolean,
): Promise<TActionQueryTarget | null> {
  const slot = streamed ? streamedQueryTargetSlot : dbActionQueryTargetSlot;
  return ctx.get(slot);
}

async function resolveQueryTarget(
  ctx: EventContext,
  streamed: boolean,
): Promise<TActionQueryTarget | null> {
  await awaitActionPrepared(ctx);
  const env = await ctx.get(dbActionBodySlot);
  if (env.query === undefined) return null;
  const meta = readCurrentActionMeta(ctx);
  const name = meta?.name ?? "";
  if (env.ids !== undefined) throw targetInvalid(name, "`ids` and `query` cannot be combined");
  const limits = queryTargetLimitsOf(meta?.opts);
  const ctrl = ctx.get(scopedControllerSlot) as TTargetResolver | null;
  const resolve = ctrl?.[RESOLVE_TARGET];
  if (!limits || !resolve || !ctrl.readable) {
    throw targetInvalid(name, `Action "${name}" does not accept a query target`);
  }
  const maxIds = actionMaxIds(ctx);
  const table = ctrl.readable;
  const idFields = table.preferredId?.length ? table.preferredId : table.primaryKeys;
  const resolved = await resolve.call(ctrl, {
    action: name,
    query: env.query,
    cap: streamed ? limits.maxRows : Math.min(limits.maxRows, maxIds),
    maxExclude: maxIds,
    overlay: "action",
    select: idFields,
  });
  const ids = resolved.rows.map((row) => {
    const id: Record<string, unknown> = {};
    for (const f of idFields) id[f] = row[f];
    return id;
  });
  return { ...resolved, ids };
}

/** {@link resolveActionQueryTarget} — materialized (`@DbActionIDs` / `@DbActionRows`). */
export const dbActionQueryTargetSlot = cached<Promise<TActionQueryTarget | null>>((ctx) =>
  resolveQueryTarget(ctx, false),
);

export const streamedQueryTargetSlot = cached<Promise<TActionQueryTarget | null>>((ctx) =>
  resolveQueryTarget(ctx, true),
);

/** One row the gate left out of a target. */
export interface TSkippedRow {
  id: Record<string, unknown>;
  reason?: string;
}

/**
 * The ids the `'rows'` gate skipped (`onDisabledRows: 'skip'`) with their
 * reasons (since 0.1.147) — read back by `useDbActionTarget().summary()`.
 */
export const dbActionSkippedKey = key<TSkippedRow[]>("atscript_db_action_skipped");

/** Indexes (into the request ids) of target rows that no longer match their query. */
export const dbActionStaleKey = key<ReadonlySet<number>>("atscript_db_action_stale");
