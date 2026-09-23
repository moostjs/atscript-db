import type { TResolvedBucket } from "@atscript/db";
import { sqlTimeZoneLiteral } from "@atscript/db-sql-tools";
import { bucketer, type BucketUnit, type CalendarBucketLabel, type WeekStart } from "@uniqu/core";

import type { TSqliteDriver } from "./types";

/**
 * Name of the scalar SQL function the adapter registers on its driver:
 * `atscript_bucket(value, unit, tz, weekStart)` → TEXT `'YYYY-MM-DD'` or NULL.
 */
export const SQLITE_BUCKET_FN = "atscript_bucket";

type TBucketer = (ms: number | bigint | null | undefined) => CalendarBucketLabel | null;

/**
 * Prepared kernels by `unit|tz|weekStart`. Bounded by construction: the
 * arguments are the literals `sqliteCalendarBucket` inlines — closed unit /
 * week-start sets and validated IANA zones — and an invalid combination
 * throws before it is stored.
 */
const bucketers = new Map<string, TBucketer>();
/** The last arguments and their kernel — a query calls the UDF with one combination per row. */
let last: { unit: unknown; tz: unknown; weekStart: unknown; fn: TBucketer } | undefined;

function cachedBucketer(unit: unknown, tz: unknown, weekStart: unknown): TBucketer {
  if (last && last.unit === unit && last.tz === tz && last.weekStart === weekStart) {
    return last.fn;
  }
  // SQLite hands TEXT arguments over as strings; `String` is the one cast.
  const u = String(unit) as BucketUnit;
  const z = String(tz);
  const w = String(weekStart) as WeekStart;
  const key = `${u}|${z}|${w}`;
  let fn = bucketers.get(key);
  if (!fn) {
    // Throws RangeError for an unknown unit / zone / week start — the core
    // validated all three, so only a hand-written call can hit it.
    fn = bucketer(u, z, w);
    bucketers.set(key, fn);
  }
  last = { unit, tz, weekStart, fn };
  return fn;
}

/**
 * Body of the `atscript_bucket` UDF: the `@uniqu/core` calendar kernel — the
 * same definition the in-memory adapter groups with. INTEGER / REAL values
 * arrive as `number` (or `bigint` in better-sqlite3's safe-integer mode);
 * NULL and any other storage class (TEXT, BLOB) label as NULL, as does an
 * instant outside the supported range. The kernel is prepared once per
 * (unit, zone, week start), not per row.
 *
 * Four declared parameters on purpose: SQLite drivers take a UDF's arity from
 * `fn.length`.
 */
export function atscriptBucketUdf(
  value: unknown,
  unit: unknown,
  tz: unknown,
  weekStart: unknown,
): CalendarBucketLabel | null {
  if (typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  return cachedBucketer(unit, tz, weekStart)(value);
}

/** Drivers the UDF is registered on. */
const registered = new WeakSet<TSqliteDriver>();

/**
 * Registers {@link SQLITE_BUCKET_FN} on `driver` once — every table adapter
 * of a space shares one driver — and reports whether the driver has the UDF.
 * A driver without {@link TSqliteDriver.registerFunction} cannot run calendar
 * buckets (the adapter then advertises no bucket units → `BUCKET_NOT_SUPPORTED`).
 * A failing `registerFunction` propagates: it is a broken driver, not a
 * missing capability.
 */
export function registerBucketFunction(driver: TSqliteDriver): boolean {
  if (typeof driver.registerFunction !== "function") {
    return false;
  }
  if (!registered.has(driver)) {
    driver.registerFunction(SQLITE_BUCKET_FN, atscriptBucketUdf, { deterministic: true });
    registered.add(driver);
  }
  return true;
}

/**
 * The SQLite dialect's calendar-bucket expression:
 * `atscript_bucket("col", 'week', 'Europe/Berlin', 'sun')`. Parameter-free —
 * the shared builder asserts the unit and week start against their closed
 * sets, and the zone passes {@link sqlTimeZoneLiteral}'s charset — so SELECT,
 * GROUP BY and HAVING render identical text. Deterministic, so SQLite treats
 * repeated calls as one expression.
 */
export function sqliteCalendarBucket(quotedCol: string, b: TResolvedBucket): string {
  return `${SQLITE_BUCKET_FN}(${quotedCol}, '${b.unit}', ${sqlTimeZoneLiteral(b.tz)}, '${b.weekStart}')`;
}
