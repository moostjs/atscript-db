import type { FilterExpr } from "@uniqu/core";

import { isPlainObject } from "../shared/object";
import type { TableMetadata } from "../table/table-metadata";

/**
 * Whether a filter entry's value only asks if the value is there: `null`,
 * `{ $eq: null }`, `{ $ne: null }`, `{ $exists: true | false }` (and
 * combinations of them).
 */
export function isNullTest(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainObject(value)) return false;
  const ops = Object.entries(value);
  return (
    ops.length > 0 &&
    ops.every(([op, operand]) =>
      op === "$exists"
        ? typeof operand === "boolean"
        : (op === "$eq" || op === "$ne") && operand === null,
    )
  );
}

/**
 * The leaf form of one null test on an object (see
 * {@link rewriteObjectNullTests}) as `$and` members: absent — `$exists: false`
 * on every leaf; present — one `$or` of `$exists: true` per leaf.
 */
function objectTest(value: unknown, leaves: readonly string[]): FilterExpr[] {
  const ops = value === null ? { $eq: null } : (value as Record<string, unknown>);
  const out: FilterExpr[] = [];
  for (const [op, operand] of Object.entries(ops)) {
    const present = op === "$exists" ? (operand as boolean) : op === "$ne";
    const tests = leaves.map((leaf) => ({ [leaf]: { $exists: present } }) as FilterExpr);
    if (present) out.push({ $or: tests } as FilterExpr);
    else out.push(...tests);
  }
  return out;
}

/**
 * A null test on a stored object (since 0.1.155) — `{ address: null }`,
 * `{ address: { $ne: null } }`, `{ address: { $exists: … } }` — on the
 * object's leaves: the object is null when none of its fields holds a value
 * (`$exists: false` on every leaf), present when one does. Relational
 * storage has no column for the object (an all-NULL row reads back as
 * `null`); document storage answers the same, so an object stored as `{}`
 * or with only null fields counts as null everywhere. LOGICAL filter;
 * copy-on-write (the same object comes back when nothing changed).
 */
export function rewriteObjectNullTests(filter: FilterExpr, meta: TableMetadata): FilterExpr {
  if (!isPlainObject(filter)) return filter;
  let out: Record<string, unknown> | undefined;
  const extra: FilterExpr[] = [];
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    let next = value;
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) {
        const mapped = value.map((f) => rewriteObjectNullTests(f as FilterExpr, meta));
        if (mapped.some((m, i) => m !== value[i])) next = mapped;
      }
    } else if (key === "$not") {
      next = rewriteObjectNullTests(value as FilterExpr, meta);
    } else if (!key.startsWith("$") && isNullTest(value)) {
      const leaves = meta.objectLeaves(key);
      if (leaves && leaves.length > 0) {
        extra.push(...objectTest(value, leaves));
        out ??= { ...(filter as Record<string, unknown>) };
        delete out[key];
        continue;
      }
    }
    if (next !== value) {
      out ??= { ...(filter as Record<string, unknown>) };
      out[key] = next;
    }
  }
  if (!out) return filter;
  if (extra.length > 0) {
    const and = out.$and;
    out.$and = [...(Array.isArray(and) ? and : []), ...extra];
  }
  return out as FilterExpr;
}
