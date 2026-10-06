import type { TDbActionTargetSummary } from "@atscript/db";
import { current, key, type EventContext } from "@wooksjs/event-core";
import { ApplyDecorators, Resolve } from "moost";

import { getAtscriptDbMate } from "../mate";
import { getActionTable, noTableError } from "./controller-access";
import { readCurrentActionMeta } from "./current-action";
import {
  dbActionIdsSlot,
  dbActionRequestIdsKey,
  echoRequests,
  requestCount,
  requestCountOf,
} from "./id-cache";
import {
  DEFAULT_QUERY_TARGET_BATCH_SIZE,
  dbActionSkippedKey,
  queryTargetLimitsOf,
  resolveActionQueryTarget,
  type TSkippedRow,
} from "./query-target";
import { asFetchTable, dbActionRowsSlot, seedActionFields } from "./row-cache";
import { applyActionScope, dbActionOverlaySlot } from "./row-scope";
import { errorMessage, errorStatus } from "./action-target-error";
import { actionHandlerStarted } from "./handler-start";
import { findRowsByIds, identityKey, type TRequestedId } from "./rows-by-id";
import { judgeRows, verdictReason, type TDisabledFn } from "./verdict";

/**
 * The rows a `'rows'` action runs on, as the handler surface of
 * `@DbActionTarget()` / {@link useDbActionTarget} (since 0.1.147) — the same
 * for an id target (`{ ids }`) and a query target (`{ query }`).
 *
 * @since 0.1.147
 */
export interface TDbActionTarget<Row = Record<string, unknown>> {
  /** `"ids"` — the body listed identifiers; `"query"` — a query target. */
  readonly kind: "ids" | "query";
  /** Rows the target resolved to (after `exclude`, before the per-batch gate). */
  readonly matched: number;
  /**
   * The target in batches, each already gated: the row overlay, the
   * action's `actionRowScope` for the batch, `disabled`, and — for a query
   * target — the query itself (a row that changed out of it is skipped as
   * `"stale"`). Rows carry the identity fields and the visible
   * `requiredFields`. Single pass.
   */
  batches(): AsyncIterable<{ ids: Record<string, unknown>[]; rows: Row[] }>;
  /** Reports a row the handler could not process — listed in {@link summary}. */
  fail(id: Record<string, unknown>, reason: string): void;
  /** What happened so far: matched, processed, skipped (by the gate) and failed rows. */
  summary(): TDbActionTargetSummary;
}

/** The current action's target, set by its gate before the handler runs. */
export const dbActionTargetKey = key<TDbActionTarget>("atscript_db_action_target");

/** The partial summary a `@DbActionTarget` run answered after its handler failed mid-run. */
export const dbActionAbortedKey = key<TDbActionTargetSummary>("atscript_db_action_aborted");

/**
 * The current `'rows'` action's {@link TDbActionTarget} (since 0.1.147).
 * Available in the handler of every `'rows'` action — `@DbActionTarget()`
 * handlers process it batch by batch; `@DbActionIDs()` / `@DbActionRows()`
 * handlers read it for `summary()` (the ids `onDisabledRows: 'skip'`
 * dropped, with their reasons).
 *
 * @since 0.1.147
 */
export function useDbActionTarget<Row = Record<string, unknown>>(
  ctx: EventContext = current(),
): TDbActionTarget<Row> {
  if (!ctx.has(dbActionTargetKey)) {
    throw new Error(
      "[moost-db actions] useDbActionTarget(): no action target in this event — " +
        "it is available in the handler of a 'rows' level @DbAction",
    );
  }
  return ctx.get(dbActionTargetKey) as unknown as TDbActionTarget<Row>;
}

/**
 * Parameter decorator injecting the action's {@link TDbActionTarget}
 * (since 0.1.147). Makes the action `'rows'` level and switches its gate to
 * batch mode: the handler iterates `target.batches()`, each batch gated on
 * its own (skip semantics — rows failing the gate are skipped and reported
 * in `summary()`, never rejected). Accepts `{ ids }` bodies, and `{ query }`
 * bodies when the action declares `queryTarget`. Not combinable with
 * `@DbActionID*` / `@DbActionRow*`.
 *
 * ```ts
 * @Post("actions/close")
 * @DbAction<Issue>("close", { label: "Close", queryTarget: true })
 * async close(@DbActionTarget() target: TDbActionTarget<Issue>) {
 *   for await (const { ids } of target.batches()) await closeIssues(ids)
 *   return target.summary()
 * }
 * ```
 *
 * @since 0.1.147
 */
export function DbActionTarget(): ParameterDecorator {
  return ApplyDecorators(
    getAtscriptDbMate().decorate("atscript_db_action_target", true),
    Resolve(() => useDbActionTarget(), "dbActionTarget"),
  );
}

/** Shared bookkeeping of both target flavours. */
class TargetBase {
  readonly skipped: TSkippedRow[] = [];
  readonly failed: { id: Record<string, unknown>; reason: string }[] = [];
  processed = 0;
  /** Identities of every id handed to the handler so far. */
  protected readonly handedKeys = new Set<string>();
  private readonly failedKeys = new Set<string>();

  constructor(
    readonly kind: "ids" | "query",
    readonly matched: number,
    /** Every id a summary reports is the request's (`resolveRowIds`, since 0.1.148). */
    protected readonly ctx: EventContext,
  ) {}

  /**
   * One failure per id, whether or not `resolveRowIds` rewrote any id: a
   * second `fail()` of the same identity is ignored (the first reason stands),
   * so `failed` and `processed` agree in both modes.
   */
  fail(id: Record<string, unknown>, reason: string): void {
    const k = identityKey(id);
    if (k !== undefined) {
      if (this.failedKeys.has(k)) return;
      this.failedKeys.add(k);
    }
    this.failed.push({ id, reason });
  }

  /**
   * A batch handed to the handler, counted per request id (two aliases of one
   * row count twice, like two distinct rows).
   */
  protected countProcessed(ids: readonly Record<string, unknown>[]): void {
    for (const id of ids) {
      const k = identityKey(id);
      if (k !== undefined) this.handedKeys.add(k);
    }
    this.processed += requestCountOf(this.ctx, ids);
  }

  summary(): TDbActionTargetSummary {
    return this.summaryOf(this.failed);
  }

  /** {@link summary} over `failed` (the run's, plus an abort's), all in request order. */
  protected summaryOf(
    failed: readonly { id: Record<string, unknown>; reason: string }[],
  ): TDbActionTargetSummary {
    const echoedFailed = echoRequests(this.ctx, failed);
    return {
      matched: this.matched,
      processed: Math.max(0, this.processed - echoedFailed.length),
      skipped: echoRequests(this.ctx, this.skipped),
      failed: echoedFailed,
    };
  }
}

/**
 * The target of a `@DbActionIDs` / `@DbActionRows` handler: the gate already
 * ran over the whole target, so `batches()` yields its survivors once.
 */
class MaterializedTarget extends TargetBase implements TDbActionTarget {
  private iterated = false;

  constructor(
    kind: "ids" | "query",
    matched: number,
    private readonly ids: Record<string, unknown>[],
    private readonly rows: () => Promise<Record<string, unknown>[]>,
    skipped: readonly TSkippedRow[],
    ctx: EventContext,
  ) {
    super(kind, matched, ctx);
    this.skipped.push(...skipped);
    this.countProcessed(ids);
  }

  async *batches(): AsyncIterable<{ ids: Record<string, unknown>[]; rows: any[] }> {
    if (this.iterated) throw new Error("[moost-db actions] target.batches() is single-pass");
    this.iterated = true;
    if (this.ids.length > 0) yield { ids: this.ids, rows: await this.rows() };
  }
}

/** {@link MaterializedTarget} for the current event, after the `'rows'` gate ran (or found nothing to check). */
export async function setMaterializedTarget(ctx: EventContext): Promise<void> {
  const target = await resolveActionQueryTarget(ctx, false);
  const ids = await ctx.get(dbActionIdsSlot);
  const skipped = ctx.has(dbActionSkippedKey) ? ctx.get(dbActionSkippedKey) : [];
  ctx.set(
    dbActionTargetKey,
    new MaterializedTarget(
      target ? "query" : "ids",
      target ? target.matched : requestCount(ctx, ids.length + skipped.length),
      ids,
      async () => {
        const rows = await ctx.get(dbActionRowsSlot);
        return rows.filter((r): r is Record<string, unknown> => r !== undefined);
      },
      skipped,
      ctx,
    ),
  );
}

interface TStreamedSource {
  kind: "ids" | "query";
  ids: Record<string, unknown>[];
  load(
    ids: readonly Record<string, unknown>[],
    select: Iterable<string>,
  ): Promise<Array<Record<string, unknown> | undefined>>;
}

/** The `@DbActionTarget` surface: the target in batches, each gated when it is reached. */
class StreamedTarget extends TargetBase implements TDbActionTarget {
  private iterated = false;

  constructor(
    matched: number,
    ctx: EventContext,
    private readonly source: TStreamedSource,
    private readonly batchSize: number,
    private readonly action: string,
    private readonly disabled: TDisabledFn | undefined,
  ) {
    super(source.kind, matched, ctx);
  }

  /** The batch the handler holds (yielded, not yet given back) and where the next one starts. */
  private current?: Record<string, unknown>[];
  private next = 0;

  async *batches(): AsyncIterable<{ ids: Record<string, unknown>[]; rows: any[] }> {
    if (this.iterated) throw new Error("[moost-db actions] target.batches() is single-pass");
    this.iterated = true;
    const { ids } = this.source;
    for (let start = 0; start < ids.length; start += this.batchSize) {
      this.next = start; // a failure while gating: this batch was not run either
      const batch = await this.gate(ids.slice(start, start + this.batchSize));
      this.next = start + this.batchSize;
      if (batch.ids.length === 0) continue;
      this.countProcessed(batch.ids);
      this.current = batch.ids;
      yield batch;
      this.current = undefined;
    }
    this.next = ids.length;
  }

  /**
   * The summary of a run the handler failed after it received a batch, judged
   * per REQUEST id by its own request position — an alias after the abort
   * point is "not run" even when its row was judged (run, skipped) earlier,
   * exactly as the same request of distinct rows would be:
   * - at or after the position the run stopped at: `failed` as `"not run"`;
   * - before it, a row the handler failed itself: its reason;
   * - before it, the batch the handler held (uncertain): the error's message;
   * - before it, a row the gate skipped: `skipped`; a row that ran: `processed`.
   * `aborted` is set.
   */
  abort(error: unknown): TDbActionTargetSummary {
    const message = errorMessage(error);
    const ids = this.source.ids;
    const requests: readonly TRequestedId[] = this.ctx.has(dbActionRequestIdsKey)
      ? this.ctx.get(dbActionRequestIdsKey)
      : ids.map((id, i) => ({ id, key: identityKey(id) ?? `#${i}` }));
    let cutoff = requests.length;
    if (this.next < ids.length) {
      if (this.ctx.has(dbActionRequestIdsKey)) {
        const at = identityKey(ids[this.next]!);
        const first = requests.findIndex((r) => r.key === at);
        if (first >= 0) cutoff = first;
      } else {
        cutoff = this.next;
      }
    }
    const held = new Set((this.current ?? []).map((id) => identityKey(id)));
    const failedBy = new Map(this.failed.map((f) => [identityKey(f.id), f]));
    const skippedBy = new Map<string | undefined, TSkippedRow>();
    for (const row of this.skipped) {
      const k = identityKey(row.id);
      if (!skippedBy.has(k)) skippedBy.set(k, row);
    }
    const failed: { id: Record<string, unknown>; reason: string }[] = [];
    const skipped: TSkippedRow[] = [];
    let processed = 0;
    requests.forEach((r, i) => {
      const own = failedBy.get(r.key);
      const skip = skippedBy.get(r.key);
      if (i >= cutoff) failed.push({ id: r.id, reason: "not run" });
      else if (own) failed.push({ id: r.id, reason: own.reason });
      else if (held.has(r.key)) failed.push({ id: r.id, reason: message });
      else if (skip) skipped.push({ ...skip, id: r.id });
      else if (this.handedKeys.has(r.key)) processed++;
    });
    return {
      matched: this.matched,
      processed,
      skipped,
      failed,
      aborted: { status: errorStatus(error), message },
    };
  }

  /** The action table and the fields its gate loads — resolved once per run. */
  private loadPlan?: ReturnType<StreamedTarget["planLoads"]>;

  private planLoads() {
    const table = asFetchTable(getActionTable(this.ctx));
    if (!table) throw noTableError(this.ctx);
    return { table, select: seedActionFields(this.ctx, table) };
  }

  /** One batch through the gate: still in the target → in scope → not disabled. */
  private async gate(
    ids: Record<string, unknown>[],
  ): Promise<{ ids: Record<string, unknown>[]; rows: Record<string, unknown>[] }> {
    const ctx = this.ctx;
    const { table, select } = (this.loadPlan ??= this.planLoads());
    const loaded = await this.source.load(ids, select);
    const scoped = await applyActionScope(ctx, table, loaded);
    const present: Record<string, unknown>[] = [];
    for (const row of scoped) if (row !== undefined) present.push(row);
    const verdicts = this.disabled ? judgeRows(this.action, this.disabled, present) : undefined;
    const out = { ids: [] as Record<string, unknown>[], rows: [] as Record<string, unknown>[] };
    let v = 0;
    for (let i = 0; i < ids.length; i++) {
      const row = scoped[i];
      if (row === undefined) {
        // Gone from the query it was selected by → "stale"; out of the
        // action's scope (or, for an id target, missing) → no reason.
        const stale = this.kind === "query" && loaded[i] === undefined;
        this.skipped.push(stale ? { id: ids[i], reason: "stale" } : { id: ids[i] });
        continue;
      }
      const verdict = verdicts?.[v++];
      if (verdict) {
        const reason = verdictReason(verdict);
        this.skipped.push(reason === undefined ? { id: ids[i] } : { id: ids[i], reason });
        continue;
      }
      out.ids.push(ids[i]);
      out.rows.push(row);
    }
    return out;
  }
}

/**
 * The partial summary of the current `@DbActionTarget` run when its handler
 * failed after receiving a batch (see `StreamedTarget.abort`); `undefined`
 * when the handler never started (a guard, `@InputForm` validation or
 * another pipe failed) or no batch reached it — the error then stands.
 */
export function abortStreamedTarget(
  ctx: EventContext,
  error: unknown,
): TDbActionTargetSummary | undefined {
  if (!actionHandlerStarted(ctx) || !ctx.has(dbActionTargetKey)) return undefined;
  const target = ctx.get(dbActionTargetKey);
  // `processed` grows only as a non-empty batch is handed over
  if (!(target instanceof StreamedTarget) || target.processed === 0) return undefined;
  const summary = target.abort(error);
  ctx.set(dbActionAbortedKey, summary);
  return summary;
}

/**
 * Builds and stores the `@DbActionTarget` target of the current event:
 * `{ ids }` (validated, `maxIds`) or `{ query }` (resolved, `queryTarget.
 * maxRows`). Returns it — the caller replies `{ matched }` for a dry run.
 */
export async function setStreamedTarget(
  ctx: EventContext,
  action: string,
  disabled: TDisabledFn | undefined,
): Promise<{ target: TDbActionTarget; dryRun: boolean }> {
  const overlay = await ctx.get(dbActionOverlaySlot);
  const opts = readCurrentActionMeta(ctx)?.opts;
  const batchSize = queryTargetLimitsOf(opts)?.batchSize ?? DEFAULT_QUERY_TARGET_BATCH_SIZE;
  const query = await resolveActionQueryTarget(ctx, true);
  let source: TStreamedSource;
  if (query) {
    source = { kind: "query", ids: query.ids, load: (batch, select) => query.load(batch, select) };
  } else {
    const ids = await ctx.get(dbActionIdsSlot);
    source = {
      kind: "ids",
      ids,
      load: (batch, select) => {
        const table = asFetchTable(getActionTable(ctx));
        if (!table) throw noTableError(ctx);
        return findRowsByIds(table, batch, overlay, select);
      },
    };
  }
  const matched = query ? query.matched : requestCount(ctx, source.ids.length);
  const target = new StreamedTarget(matched, ctx, source, batchSize, action, disabled);
  ctx.set(dbActionTargetKey, target);
  return { target, dryRun: query?.dryRun === true };
}
