import type { TAtscriptAnnotatedType, TAtscriptDataType } from "@atscript/typescript/utils";

import type { DbSpace } from "../table/db-space";
import { getPath } from "../shared/object";
import { isNavRelation } from "../validator";
import type { TDataStep, TDataStepOutcome } from "./schema-sync";

/** Options shared by both forms of {@link rewriteRowsStep}. */
interface TRewriteRowsCommon {
  /**
   * The step id before its `@<hash>` suffix. Default: `rewrite:<table>` or
   * `rewrite:<table>.<field>`. Change it to run the step again although the
   * metadata did not change (for example, after changing `map`).
   */
  id?: string;
  /** Rows read and written per batch, in primary-key order. Default: 500. */
  batchSize?: number;
  /** See {@link TDataStep.phase}. */
  phase?: TDataStep["phase"];
  /** See {@link TDataStep.onError}. */
  onError?: TDataStep["onError"];
}

/** {@link rewriteRowsStep} over one field. */
export interface TRewriteFieldOptions<Row> extends TRewriteRowsCommon {
  /** The field to rewrite — a dotted path reaches into nested objects. */
  field: string;
  /**
   * The field's new value — `undefined` leaves the row unchanged. Gets a copy
   * of the stored value: mutating and returning it is fine. Must be
   * idempotent: see {@link rewriteRowsStep}.
   */
  map: (value: any, row: Row) => unknown;
}

/** {@link rewriteRowsStep} over whole rows. */
export interface TRewriteRowOptions<Row> extends TRewriteRowsCommon {
  field?: undefined;
  /**
   * The row with your changes — `undefined` leaves it unchanged. Gets a copy
   * of the stored row: mutating and returning it is fine. A top-level field
   * left out of the result is not changed (set it to `null` to clear it); the
   * primary key is never changed. Must be idempotent: see
   * {@link rewriteRowsStep}.
   */
  map: (row: Row) => Row | Partial<Row> | undefined | void;
}

/**
 * A data step (since 0.1.175) that rewrites the stored rows of a table when
 * its type changes — for example, clamping stored JSON to a new
 * `@expect.maxLength`. Pass it in {@link TSyncOptions.dataSteps}.
 *
 * Its id ends in a short hash of the validation metadata of the `field` —
 * or of every column of the table without one: when it changes, the step is
 * pending again and the next sync runs it once more; while it stays the same,
 * it stays recorded. The hash covers only what decides which values are
 * valid: the kind and primitive type, optional / nullable, the structure of
 * objects and arrays by property name, and the `@expect.*` (without their
 * messages), `@meta.required`, `@normalize.*` and `@db.json` annotations.
 * It does not cover names of types, labels, descriptions, `@ui.*`, other
 * annotations or the `@atscript/typescript` version — renaming a nested type
 * or upgrading the toolchain keeps the id. In the whole-row form, adding or
 * removing a column (or changing a column's validation) is a change: the step
 * runs again.
 *
 * **`map` must be idempotent** — `map(map(x))` equals `map(x)`. The step runs
 * again whenever the id changes, after a failed attempt, and on adapters
 * without transactions a retry sees the rows an earlier attempt already
 * rewrote. A clamp (`turns.slice(-50)`) or a trim is idempotent; `v => v * 100`
 * is not — derive the new value from the row's other fields, or guard it
 * (`v => v < 1000 ? v * 100 : v`).
 *
 * The step reads the rows in primary-key order, `batchSize` at a time, calls
 * `map` and writes only the rows it changed — as a patch of the changed
 * top-level fields, validated against the current type. It runs at sync, in
 * the step's transaction, never at read time.
 *
 * ```ts
 * await syncSchema(db, [Chat], {
 *   dataSteps: [
 *     rewriteRowsStep(Chat, { field: "turns", map: (turns) => turns.slice(-50) }),
 *   ],
 * });
 * ```
 */
export function rewriteRowsStep<T extends TAtscriptAnnotatedType>(
  type: T,
  opts: TRewriteFieldOptions<TAtscriptDataType<T>> | TRewriteRowOptions<TAtscriptDataType<T>>,
): TDataStep {
  const tableName = type.metadata.get("db.table" as never) as string | undefined;
  if (typeof tableName !== "string" || tableName === "") {
    throw new Error("rewriteRowsStep: expected a type with @db.table");
  }
  const { field } = opts;
  const batchSize = opts.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`rewriteRowsStep: batchSize must be a positive integer, got ${batchSize}`);
  }
  let target: TAtscriptAnnotatedType = type;
  if (field !== undefined) {
    target = fieldType(type, field, tableName);
    checkRewritableField(type, field, tableName);
  }
  const base = opts.id ?? `rewrite:${tableName}${field === undefined ? "" : `.${field}`}`;
  return {
    id: `${base}@${metadataHash(target)}`,
    phase: opts.phase,
    onError: opts.onError,
    run: (space) => rewriteRows(space, type, opts, batchSize),
  };
}

async function rewriteRows(
  space: DbSpace,
  type: TAtscriptAnnotatedType,
  opts: TRewriteFieldOptions<any> | TRewriteRowOptions<any>,
  batchSize: number,
): Promise<TDataStepOutcome> {
  const table = space.getTable(type) as any;
  const keys = table.primaryKeys as readonly string[];
  if (keys.length === 0) {
    throw new Error(`rewriteRowsStep: table "${table.tableName}" has no primary key`);
  }
  const top = opts.field?.split(".")[0];
  if (top !== undefined && keys.includes(top)) {
    throw new Error(
      `rewriteRowsStep: "${table.tableName}.${top}" is a primary-key field — rewriting it would address the wrong row`,
    );
  }
  const sort = Object.fromEntries(keys.map((k) => [k, 1]));
  let after: Record<string, unknown> | undefined;
  let read = 0;
  let written = 0;
  for (;;) {
    const rows = (await table.findMany({
      filter: after ? afterKey(keys, after) : {},
      controls: { $sort: sort, $limit: batchSize },
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) break;
    read += rows.length;
    const patches = rows.map((row) => rowPatch(row, opts, keys)).filter((p) => p !== undefined);
    if (patches.length > 0) {
      await table.bulkUpdate(patches);
      written += patches.length;
    }
    if (rows.length < batchSize) break;
    after = rows.at(-1);
  }
  return { note: `rewrote ${written} of ${read} rows` };
}

/** The patch of one row (its key + the changed top-level fields), `undefined` when unchanged. */
function rowPatch(
  row: Record<string, unknown>,
  opts: TRewriteFieldOptions<any> | TRewriteRowOptions<any>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const changed: Record<string, unknown> = {};
  if (opts.field === undefined) {
    const next = opts.map(structuredClone(row));
    if (next === undefined || next === null) return undefined;
    for (const [k, value] of Object.entries(next)) {
      if (!keys.includes(k) && value !== undefined && !sameValue(row[k], value)) {
        changed[k] = value;
      }
    }
  } else {
    const [top, ...rest] = opts.field.split(".");
    const current = getPath(row, opts.field);
    const next = opts.map(structuredClone(current), structuredClone(row));
    if (next === undefined || sameValue(current, next)) return undefined;
    // A nested field is written as its whole top-level value: a patch of a
    // nested object replaces it by default.
    changed[top] = rest.length === 0 ? next : setPath(structuredClone(row[top]), rest, next);
  }
  if (Object.keys(changed).length === 0) return undefined;
  const patch: Record<string, unknown> = {};
  for (const k of keys) patch[k] = row[k];
  return Object.assign(patch, changed);
}

/** The filter for the rows after `last` in primary-key order. */
function afterKey(keys: readonly string[], last: Record<string, unknown>): Record<string, unknown> {
  if (keys.length === 1) return { [keys[0]]: { $gt: last[keys[0]] } };
  return {
    $or: keys.map((key, i) => ({
      ...Object.fromEntries(keys.slice(0, i).map((k) => [k, { $eq: last[k] }])),
      [key]: { $gt: last[key] },
    })),
  };
}

/** The annotated type of `path` in the table type — an object path, no unions. */
function fieldType(
  type: TAtscriptAnnotatedType,
  path: string,
  tableName: string,
): TAtscriptAnnotatedType {
  let node: TAtscriptAnnotatedType | undefined = type;
  for (const segment of path.split(".")) {
    const def = node?.type as { kind?: string; props?: Map<string, TAtscriptAnnotatedType> };
    node = def?.kind === "object" ? def.props?.get(segment) : undefined;
    if (!node) {
      throw new Error(`rewriteRowsStep: "${tableName}" has no field "${path}"`);
    }
  }
  return node!;
}

/** Reject a field the step cannot rewrite: a primary-key column or a relation. */
function checkRewritableField(type: TAtscriptAnnotatedType, path: string, tableName: string): void {
  const [top] = path.split(".");
  const def = type.type as { props?: Map<string, TAtscriptAnnotatedType> };
  const prop = def.props?.get(top);
  if (prop?.metadata.has("meta.id")) {
    throw new Error(
      `rewriteRowsStep: "${tableName}.${top}" is a primary-key field — rewriting it would address the wrong row`,
    );
  }
  if (prop && isNavRelation(prop)) {
    throw new Error(
      `rewriteRowsStep: "${tableName}.${top}" is a relation, not a stored field — rewrite its foreign-key field instead`,
    );
  }
}

/**
 * Validation metadata that changes what a stored value must look like. The
 * messages are text, not rules (`expect.message` is one, `message` keys of the
 * others are dropped in {@link ruleValue}).
 */
function isValidationKey(key: string): boolean {
  return (
    (key.startsWith("expect.") && key !== "expect.message") ||
    key.startsWith("normalize.") ||
    key === "meta.required" ||
    key === "db.json"
  );
}

/** An annotation value without message texts; an empty object counts as `true`. */
function ruleValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ruleValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([k, v]) => k !== "message" && v !== undefined)
      .toSorted(byKey)
      .map(([k, v]) => [k, ruleValue(v)] as const);
    return entries.length === 0 ? true : entries;
  }
  return value;
}

/** The validation annotations of a node, by key. */
function rulesOf(node: TAtscriptAnnotatedType): unknown[] {
  return [...node.metadata.keys()]
    .filter(isValidationKey)
    .toSorted()
    .map((key) => [key, ruleValue(node.metadata.get(key as never))]);
}

/** A property that is not a stored column: a relation or an ignored field. */
function isNotAColumn(prop: TAtscriptAnnotatedType): boolean {
  return isNavRelation(prop) || prop.metadata.has("db.ignore");
}

/** UTF-16 code-unit order — the order the step id hashes are pinned to. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => cmp(a, b);
const byJson = (a: unknown, b: unknown): number => cmp(JSON.stringify(a), JSON.stringify(b));

/**
 * The projection of a type that the step id hashes: the kind and primitive
 * type, optional, the structure by property name, and the validation
 * annotations — nothing else (no `$v`, type names, labels or `@ui.*`).
 */
function validationProjection(
  node: TAtscriptAnnotatedType,
  trail: Set<unknown> = new Set(),
): unknown {
  const def = node.type as any;
  const head = [def.kind, node.optional ? 1 : 0, rulesOf(node)];
  if (trail.has(def)) return [...head, "cycle"];
  trail.add(def);
  try {
    switch (def.kind) {
      case "":
        return [...head, def.designType, def.value === undefined ? null : def.value];
      case "array":
        return [...head, validationProjection(def.of, trail)];
      case "object": {
        const props = ([...def.props.entries()] as Array<[string, TAtscriptAnnotatedType]>)
          .filter(([, prop]) => !isNotAColumn(prop))
          .toSorted(byKey)
          .map(([name, prop]) => [name, validationProjection(prop, trail)]);
        const patterns = (
          def.propsPatterns as Array<{ pattern: RegExp; def: TAtscriptAnnotatedType }>
        )
          .map((p) => [p.pattern.source, p.pattern.flags, validationProjection(p.def, trail)])
          .toSorted(byJson);
        return [...head, props, patterns];
      }
      case "tuple":
        return [...head, def.items.map((item: any) => validationProjection(item, trail))];
      case "union":
      case "intersection":
        return [
          ...head,
          def.items.map((item: any) => validationProjection(item, trail)).toSorted(byJson),
        ];
      default:
        return head;
    }
  } finally {
    trail.delete(def);
  }
}

/** A short hash of `type`'s validation projection. */
function metadataHash(type: TAtscriptAnnotatedType): string {
  const json = JSON.stringify(validationProjection(type));
  // FNV-1a, 32 bits
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash = Math.imul(hash ^ json.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** `target` with `value` set at `path` — missing parents become objects. */
function setPath(target: unknown, path: readonly string[], value: unknown): unknown {
  const root = target !== null && typeof target === "object" ? target : {};
  let node = root as Record<string, unknown>;
  for (const segment of path.slice(0, -1)) {
    const next = node[segment];
    node = node[segment] = (next !== null && typeof next === "object" ? next : {}) as Record<
      string,
      unknown
    >;
  }
  node[path.at(-1)!] = value;
  return root;
}

/** Structural equality of stored values (plain objects, arrays, dates, primitives). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => sameValue(item, other[i]));
  }
  const ka = Object.keys(a).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue((a as any)[k], (b as any)[k]));
}
