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
