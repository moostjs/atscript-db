import { pathReader } from "./memory-filter";

type TRow = Record<string, unknown>;

/**
 * A unique index recorded by `MemoryAdapter.syncIndexes`. `fields` holds the
 * ordered PHYSICAL field names (dot-paths); `optional[i]` marks a member
 * declared `field?:` in the model — a present-only (partial) index skips a row
 * whose optional member is absent/`null`, matching SQL's `NULLS DISTINCT`.
 *
 * `entries` maps each indexed row's {@link uniqueTupleKey} to the storage keys
 * (`pkKey`) of the rows holding that tuple, so a uniqueness check is one
 * lookup instead of a scan of the table. It is kept in step with the table's
 * rows by every write (see `MemoryAdapter`).
 */
export interface RecordedUniqueIndex {
  name: string;
  fields: string[];
  readers: Array<(row: TRow) => unknown>;
  optional: boolean[];
  entries: Map<string, Set<string>>;
}

/** Builds an empty {@link RecordedUniqueIndex}. */
export function recordUniqueIndex(
  name: string,
  fields: string[],
  optionalFields: Set<string>,
): RecordedUniqueIndex {
  return {
    name,
    fields,
    readers: fields.map((field) => pathReader(field)),
    optional: fields.map((field) => optionalFields.has(field)),
    entries: new Map(),
  };
}

/**
 * Identity of `row`'s tuple in `index`, or `undefined` when the row can never
 * collide in it. Two rows collide exactly when every component is equal under
 * the memory filter's strict equality (`valuesEqual`: `===`, `Date`s by
 * instant), so each component is type-tagged:
 *
 * - an optional member absent / `null` → `undefined` (present-only index);
 * - `NaN`, an invalid `Date`, or any other object (arrays included — compared
 *   by reference, and rows never share one) → `undefined`: equal to nothing;
 * - a required member that is `null` or missing is a value like any other
 *   (`null` ≠ missing).
 */
export function uniqueTupleKey(index: RecordedUniqueIndex, row: TRow): string | undefined {
  const parts: string[] = [];
  for (let i = 0; i < index.readers.length; i++) {
    const value = index.readers[i]!(row);
    if (index.optional[i] && (value === null || value === undefined)) {
      return undefined;
    }
    const part = tuplePart(value);
    if (part === undefined) {
      return undefined;
    }
    parts.push(part);
  }
  return JSON.stringify(parts);
}

function tuplePart(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return `s:${value}`;
    case "number":
      return Number.isNaN(value) ? undefined : `n:${value === 0 ? 0 : value}`;
    case "bigint":
      return `b:${value}`;
    case "boolean":
      return `t:${value}`;
    case "undefined":
      return "u";
    default:
      if (value === null) return "z";
      if (value instanceof Date) {
        const time = value.getTime();
        return Number.isNaN(time) ? undefined : `d:${time}`;
      }
      return undefined;
  }
}

/** Records `row` (stored under `key`) in every index; `tuples` are its precomputed tuple keys. */
export function indexRow(
  indexes: readonly RecordedUniqueIndex[],
  key: string,
  row: TRow,
  tuples?: ReadonlyArray<string | undefined>,
): void {
  for (let i = 0; i < indexes.length; i++) {
    const index = indexes[i]!;
    const tuple = tuples ? tuples[i] : uniqueTupleKey(index, row);
    if (tuple === undefined) continue;
    const holders = index.entries.get(tuple);
    if (holders) {
      holders.add(key);
    } else {
      index.entries.set(tuple, new Set([key]));
    }
  }
}

/** Removes `row` (stored under `key`) from every index. */
export function unindexRow(indexes: readonly RecordedUniqueIndex[], key: string, row: TRow): void {
  for (const index of indexes) {
    const tuple = uniqueTupleKey(index, row);
    if (tuple === undefined) continue;
    const holders = index.entries.get(tuple);
    if (holders?.delete(key) && holders.size === 0) {
      index.entries.delete(tuple);
    }
  }
}

/** Whether a row other than the one stored under `excludeKey` holds `tuple`. */
export function tupleTaken(
  index: RecordedUniqueIndex,
  tuple: string,
  excludeKey: string | undefined,
): boolean {
  const holders = index.entries.get(tuple);
  if (!holders) return false;
  if (excludeKey === undefined || !holders.has(excludeKey)) return holders.size > 0;
  return holders.size > 1;
}
