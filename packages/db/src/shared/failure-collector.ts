/**
 * Collects failures from a batch of independent operations so one failing
 * operation (e.g. CREATE UNIQUE INDEX over duplicate rows) doesn't abort the
 * rest. Run every operation through `attempt`, then call `throwIfAny()` to
 * rethrow the collected failures as a single aggregate error — so the caller
 * (schema sync) still marks the entry errored and skips persisting the schema
 * hash, and the next boot retries.
 */
export function createFailureCollector(what: string): {
  /** Runs `op`; `true` when it succeeded, `false` when its failure was collected. */
  attempt: (label: string, op: () => Promise<unknown>) => Promise<boolean>;
  throwIfAny: () => void;
} {
  const failures: string[] = [];
  return {
    attempt: async (label, op) => {
      try {
        await op();
        return true;
      } catch (error) {
        failures.push(`${label}: ${(error as Error).message}`);
        return false;
      }
    },
    throwIfAny: () => {
      if (failures.length > 0) {
        throw new Error(
          `${what} failed for ${failures.length} operation(s): ${failures.join("; ")}`,
        );
      }
    },
  };
}

/**
 * Records the changes a sync pass makes — or, in a dry run, would make — so
 * planning and syncing share one code path. `apply(change, label, op)`
 * records `change` straight away in a dry run; otherwise it runs `op` first:
 * through `attempt` when given (a {@link createFailureCollector} collector —
 * a failure is collected and the change not recorded), else directly (a
 * failure throws).
 * @since 0.1.162
 */
export function createChangeRecorder<C>(
  dryRun: boolean,
  attempt?: (label: string, op: () => Promise<unknown>) => Promise<boolean>,
): {
  /** The changes recorded so far, in order. */
  changes: C[];
  apply: (change: C, label: string, op: () => unknown) => Promise<void>;
} {
  const changes: C[] = [];
  return {
    changes,
    apply: async (change, label, op) => {
      if (!dryRun) {
        if (attempt) {
          if (!(await attempt(label, async () => op()))) return;
        } else {
          await op();
        }
      }
      changes.push(change);
    },
  };
}
