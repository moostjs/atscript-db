import { AsyncLocalStorage } from "node:async_hooks";

import { DbError } from "@atscript/db";
import type { TGenericLogger } from "@atscript/db";

import type { TSqliteDriver } from "./types";

/**
 * Per-waiter options for the transaction gate (taken from the adapter's
 * {@link SqliteAdapterOptions} at wait time — the gate itself is per driver).
 */
export interface SqliteTxWaitOptions {
  /**
   * Max milliseconds a waiter blocks for the connection before rejecting with
   * `DbError("TX_WAIT_TIMEOUT")`. Default: unbounded (matches the mysql2 / pg
   * pool defaults).
   */
  transactionWaitTimeoutMs?: number;
  /**
   * Log a warning through `logger` once a waiter has waited this long.
   * Default: 5000 ms. `0` disables the warning.
   */
  transactionWaitWarnMs?: number;
  /** Logger for the wait warning (the adapter passes its own). */
  logger?: TGenericLogger;
}

/** Options accepted by `SqliteAdapter` / `createAdapter` for the transaction gate. */
export type SqliteAdapterOptions = Pick<
  SqliteTxWaitOptions,
  "transactionWaitTimeoutMs" | "transactionWaitWarnMs"
>;

const DEFAULT_WARN_MS = 5000;

/** Async context that holds a gate exclusively via {@link SqliteTxGate.runExclusive}. */
const exclusiveHolds = new AsyncLocalStorage<SqliteTxGate>();

/**
 * One waiter for the gate, created once per `_stmt` / `acquire` call and kept
 * across wake-ups: the timeout and warn timers are armed ONCE with an absolute
 * deadline, so `transactionWaitTimeoutMs` bounds the waiter's TOTAL wait
 * however many transactions run ahead of it, and a re-queued waiter allocates
 * nothing new. `next()` resolves on the next release (or rejects once the
 * deadline passed); `dispose()` clears the timers.
 */
class GateWaiter {
  private _resolve?: () => void;
  private _reject?: (e: Error) => void;
  private _timeoutTimer?: ReturnType<typeof setTimeout>;
  private _warnTimer?: ReturnType<typeof setTimeout>;
  private _expired?: DbError;
  private readonly _startedAt = Date.now();

  constructor(
    private readonly _gate: SqliteTxGate,
    opts: SqliteTxWaitOptions | undefined,
  ) {
    const timeoutMs = opts?.transactionWaitTimeoutMs;
    const warnMs = opts?.transactionWaitWarnMs ?? DEFAULT_WARN_MS;
    const heldSince = this._gate.heldSince;
    if (timeoutMs !== undefined && timeoutMs >= 0) {
      this._timeoutTimer = setTimeout(() => {
        const waited = Date.now() - this._startedAt;
        const heldFor = heldSince ? Date.now() - heldSince : 0;
        this._expired = new DbError("TX_WAIT_TIMEOUT", [
          {
            path: "",
            message:
              `SQLite transaction gate: waited ${waited}ms for the connection ` +
              `(a transaction has been open for ${heldFor}ms) — transactionWaitTimeoutMs exceeded`,
          },
        ]);
        this._gate._dequeue(this);
        const reject = this._reject;
        this._resolve = undefined;
        this._reject = undefined;
        reject?.(this._expired);
      }, timeoutMs);
      this._timeoutTimer.unref?.();
    }
    if (warnMs > 0 && opts?.logger) {
      const logger = opts.logger;
      this._warnTimer = setTimeout(() => {
        const waited = Date.now() - this._startedAt;
        const since = heldSince ? new Date(heldSince).toISOString() : "unknown";
        logger.warn(
          `[atscript-db-sqlite] a statement has been waiting ${waited}ms for an open ` +
            `transaction (held since ${since}); never await external I/O inside ` +
            `withTransaction on SQLite`,
        );
      }, warnMs);
      this._warnTimer.unref?.();
    }
  }

  /** Resolves on the NEXT release; rejects with `TX_WAIT_TIMEOUT` once the deadline passed. */
  next(): Promise<void> {
    if (this._expired) return Promise.reject(this._expired);
    return new Promise<void>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._gate._enqueue(this);
    });
  }

  /** Called by the gate on release: wakes the pending `next()` (a no-op when none is pending). */
  wake(): void {
    const resolve = this._resolve;
    this._resolve = undefined;
    this._reject = undefined;
    resolve?.();
  }

  dispose(): void {
    if (this._timeoutTimer !== undefined) clearTimeout(this._timeoutTimer);
    if (this._warnTimer !== undefined) clearTimeout(this._warnTimer);
  }
}

/**
 * Logical FIFO mutex around the single synchronous SQLite connection.
 *
 * SQLite has one connection per driver, so two async contexts cannot each
 * own a transaction: a second `BEGIN` fails with "cannot start a transaction
 * within a transaction", and — worse — any statement from another context
 * that runs while a transaction is open executes INSIDE that transaction
 * (rolled back with it, reads its uncommitted rows). The gate serialises:
 *
 * - {@link acquire} / {@link release} — taken by `BEGIN`, released by
 *   `COMMIT` / `ROLLBACK`;
 * - {@link runWhenFree} — plain (non-transactional) statements check
 *   {@link held} synchronously right before executing and wait otherwise;
 * - {@link runExclusive} — hold the connection without a transaction (schema sync).
 *
 * Fairness: one FIFO waiter list for acquirers and statement waiters alike;
 * a release wakes every current waiter in registration order, each re-checks
 * synchronously and re-queues (ahead of any new arrival) if someone ahead took
 * the gate. A waiter is one object with timers armed once, whatever the
 * number of wake-ups. The fast path (nothing held) allocates nothing.
 */
export class SqliteTxGate {
  /** True while a transaction (or an exclusive hold) owns the connection. */
  held = false;
  /** `Date.now()` when the current holder took the gate (0 when free). */
  heldSince = 0;
  private _waiters: GateWaiter[] = [];

  /** True when the current async context holds this gate via {@link runExclusive}. */
  get heldByCurrentContext(): boolean {
    return exclusiveHolds.getStore() === this;
  }

  /**
   * Waits until the gate is free, then takes it synchronously (no `await`
   * between the check and `held = true`). Pair with {@link release}.
   */
  async acquire(opts?: SqliteTxWaitOptions): Promise<void> {
    if (this.held) {
      // The re-check and the take run in the same synchronous continuation
      // after each wake-up, so two woken waiters can never both take the gate.
      const waiter = new GateWaiter(this, opts);
      try {
        do {
          await waiter.next();
        } while (this.held);
      } finally {
        waiter.dispose();
      }
    }
    this.held = true;
    this.heldSince = Date.now();
  }

  /** Frees the gate and wakes every waiter (in registration order). */
  release(): void {
    this.held = false;
    this.heldSince = 0;
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w.wake();
  }

  /**
   * Runs one synchronous statement once no transaction holds the connection
   * (immediately when the gate is free). The `held` check and `fn` run in
   * the same synchronous segment, so they cannot interleave with a `BEGIN`
   * from another context.
   */
  async runWhenFree<R>(fn: () => R, opts?: SqliteTxWaitOptions): Promise<R> {
    if (this.held) {
      const waiter = new GateWaiter(this, opts);
      try {
        do {
          await waiter.next();
        } while (this.held);
      } finally {
        waiter.dispose();
      }
    }
    return fn();
  }

  /**
   * Holds the gate for the duration of `fn` WITHOUT opening a transaction
   * (nested transactions inside `fn` still `BEGIN`/`COMMIT` on the held
   * connection without re-acquiring). Re-entrant for the same async context.
   */
  async runExclusive<T>(fn: () => Promise<T>, opts?: SqliteTxWaitOptions): Promise<T> {
    if (this.heldByCurrentContext) {
      return fn();
    }
    await this.acquire(opts);
    try {
      return await exclusiveHolds.run(this, fn);
    } finally {
      this.release();
    }
  }

  /** @internal */
  _enqueue(waiter: GateWaiter): void {
    this._waiters.push(waiter);
  }

  /** @internal */
  _dequeue(waiter: GateWaiter): void {
    const idx = this._waiters.indexOf(waiter);
    if (idx !== -1) this._waiters.splice(idx, 1);
  }
}

/**
 * Transaction state returned by `SqliteAdapter._beginTransaction`: releases
 * the gate the transaction holds exactly once (a transaction opened inside an
 * exclusive hold owns nothing to release). Ownership across adapters is
 * decided by the core (`_transactionOwner()` = the driver), not here.
 */
export class SqliteTxState {
  constructor(
    private readonly _gate: SqliteTxGate,
    private _holdsGate: boolean,
  ) {}

  release(): void {
    if (!this._holdsGate) return;
    this._holdsGate = false;
    this._gate.release();
  }
}

const gates = new WeakMap<TSqliteDriver, SqliteTxGate>();

/**
 * Returns the gate for a driver instance (one gate per driver — every adapter
 * of a space shares its driver, so they share the gate; two driver wrappers
 * around one `Database` would get two gates: construct one driver per database).
 */
export function getSqliteTxGate(driver: TSqliteDriver): SqliteTxGate {
  let gate = gates.get(driver);
  if (!gate) {
    gate = new SqliteTxGate();
    gates.set(driver, gate);
  }
  return gate;
}
