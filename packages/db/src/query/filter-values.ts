import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type { FilterExpr } from "@uniqu/core";
import { isAggregateExpr, isBucketExpr } from "@uniqu/core";

import { DbError } from "../db-error";
import { resolveAlias } from "../agg";
import type { TableMetadata } from "../table/table-metadata";
import type { TDbFieldMeta } from "../types";
import { isPlainObject } from "../shared/object";
import { hasRelationOp } from "./relation-filter";
import { jsonValueAncestor } from "./buckets";

/**
 * Filter VALUE guard (since 0.1.147): every comparison operand must be able
 * to denote the field's declared scalar type, so a mistyped value is one
 * `INVALID_QUERY` on every adapter instead of an engine error (PostgreSQL
 * `invalid input syntax`), a silent cast (MySQL `'x'` → `0`, wrong rows) or
 * an empty result (SQLite / MongoDB / memory).
 *
 * Accepted per scalar kind (`null` / `undefined` always pass; so do class
 * instances such as `Date` or `ObjectId`, which only programmatic callers
 * send and which adapters handle natively):
 *
 * - `number` and `decimal` — a number, a bigint, or a numeric string
 *   (`'5'`, `'-1.5e3'`, `'12.50'`);
 * - an integer (`number.int` and its sizes, `number.timestamp`, a number
 *   with `@db.default.increment` / `@db.default.now`) — an integral number,
 *   a bigint, or an integer string (`'5'`): integer columns cannot parse
 *   `5.5` (PostgreSQL `invalid input syntax for type bigint`);
 * - `boolean` — `true` / `false`, or `0` / `1`;
 * - `string` (every `string.*`, string literals) — a string, number, boolean
 *   or bigint: the URL grammar reads an unquoted `?code=123` as a number.
 *
 * A union accepts what any member accepts; an array field checks its
 * element type (containment) and each element of an array operand. JSON
 * (`@db.json`), object, tuple (`db.geoPoint`) and other non-scalar types are
 * opaque — never checked. `$regex` (and a bare `RegExp`) needs a field that
 * holds strings, and a string / `RegExp` pattern. `$exists` / `$geoWithin`
 * are checked by `guardFilter`; relational predicates by the related table.
 */

/** A scalar kind a field's values belong to; `any` = opaque, never checked. */
type TScalarKind = "string" | "number" | "integer" | "decimal" | "boolean" | "any";

/** The accepted value kinds of a field (union of its members / array element). */
interface TValueType {
  kinds: ReadonlySet<TScalarKind>;
  /** A `number.timestamp` member — the message names epoch milliseconds. */
  timestamp: boolean;
}

const OPAQUE: TValueType = { kinds: new Set<TScalarKind>(["any"]), timestamp: false };
const NUMBER: TValueType = { kinds: new Set<TScalarKind>(["number"]), timestamp: false };
const INTEGER: TValueType = { kinds: new Set<TScalarKind>(["integer"]), timestamp: false };
const STRING: TValueType = { kinds: new Set<TScalarKind>(["string"]), timestamp: false };

function collectKinds(
  type: TAtscriptAnnotatedType | undefined,
  kinds: Set<TScalarKind>,
  out: { timestamp: boolean },
  depth = 0,
): void {
  const def = type?.type as
    | {
        kind: string;
        designType?: string;
        items?: TAtscriptAnnotatedType[];
        of?: TAtscriptAnnotatedType;
        tags?: ReadonlySet<string>;
      }
    | undefined;
  const metadata = type?.metadata as { has?(key: string): boolean } | undefined;
  if (!def || depth > 8) {
    kinds.add("any");
    return;
  }
  switch (def.kind) {
    case "": {
      switch (def.designType) {
        case "string":
          kinds.add("string");
          return;
        case "number": {
          const timestamp = def.tags?.has("timestamp") === true;
          if (timestamp) out.timestamp = true;
          const integer =
            timestamp || def.tags?.has("int") === true || metadata?.has?.("expect.int") === true;
          kinds.add(integer ? "integer" : "number");
          return;
        }
        case "decimal":
          kinds.add("decimal");
          return;
        case "boolean":
          kinds.add("boolean");
          return;
        case "null":
        case "undefined":
        case "never":
          // No value besides `null` / `undefined` (always accepted).
          return;
        default:
          kinds.add("any");
          return;
      }
    }
    case "union":
      for (const item of def.items ?? []) collectKinds(item, kinds, out, depth + 1);
      return;
    case "array":
      // A filter on an array field tests its elements (containment).
      collectKinds(def.of, kinds, out, depth + 1);
      return;
    default:
      kinds.add("any");
  }
}

const typeCache = new WeakMap<TDbFieldMeta, TValueType>();

/**
 * The value kinds a filter on `fd` accepts (cached per descriptor). A leaf
 * inside a JSON value (a `@db.json` object or an array, addressable on
 * nested-object adapters) is opaque: its contents are not schema-enforced.
 */
function valueTypeOf(meta: TableMetadata, fd: TDbFieldMeta): TValueType {
  let vt = typeCache.get(fd);
  if (vt) return vt;
  if (
    jsonValueAncestor(fd.path, meta.jsonValueParents) !== undefined ||
    fd.encrypted ||
    fd.isGeoPoint ||
    fd.designType === "json" ||
    fd.designType === "object" ||
    !fd.type
  ) {
    vt = OPAQUE;
  } else {
    const kinds = new Set<TScalarKind>();
    const out = { timestamp: false };
    collectKinds(fd.type, kinds, out);
    // Values generated by `increment` / `now` are integers, and so is a
    // view's count column: so is the column type.
    const metadata = fd.type.metadata as { has?(key: string): boolean } | undefined;
    const integral =
      (fd.defaultValue?.kind === "fn" && fd.defaultValue.fn !== "uuid") ||
      metadata?.has?.("db.agg.count") === true ||
      metadata?.has?.("db.agg.countDistinct") === true;
    if (integral && kinds.delete("number")) kinds.add("integer");
    vt = kinds.size === 0 ? OPAQUE : { kinds, timestamp: out.timestamp };
  }
  typeCache.set(fd, vt);
  return vt;
}

/** A decimal literal (`5`, `-1.5`, `.5`, `1e3`), surrounding blanks allowed — no hex, no `Infinity`. */
const NUMERIC_RE = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i;
/** An integer literal (`5`, `-12`), surrounding blanks allowed. */
const INTEGER_RE = /^\s*[+-]?\d+\s*$/;

function acceptsScalar(kind: TScalarKind, value: unknown): boolean {
  switch (kind) {
    case "any":
      return true;
    case "string":
      return (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
      );
    case "number":
    case "decimal":
      return (
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "bigint" ||
        (typeof value === "string" && NUMERIC_RE.test(value))
      );
    case "integer":
      return (
        (typeof value === "number" && Number.isInteger(value)) ||
        typeof value === "bigint" ||
        (typeof value === "string" && INTEGER_RE.test(value))
      );
    default:
      // boolean
      return typeof value === "boolean" || value === 0 || value === 1;
  }
}

/** The first element of `value` (itself when not an array) `vt` rejects, or `undefined`. */
function rejectedValue(vt: TValueType, value: unknown): { value: unknown } | undefined {
  if (vt.kinds.has("any") || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const bad = rejectedValue(vt, item);
      if (bad) return bad;
    }
    return undefined;
  }
  // Class instances (`Date`, `ObjectId`, …) are the adapters' own currency.
  if (typeof value === "object" && !isPlainObject(value)) return undefined;
  for (const kind of vt.kinds) {
    if (acceptsScalar(kind, value)) return undefined;
  }
  return { value };
}

const KIND_LABEL: Record<Exclude<TScalarKind, "any">, string> = {
  string: "a string",
  number: "a number",
  integer: "an integer",
  decimal: "a decimal (number or numeric string)",
  boolean: "a boolean",
};

function expectedOf(vt: TValueType): string {
  const labels: string[] = [];
  for (const kind of vt.kinds) {
    if (kind === "any") continue;
    labels.push(
      kind === "integer" && vt.timestamp ? "an integer (epoch milliseconds)" : KIND_LABEL[kind],
    );
  }
  return labels.join(" or ");
}

function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  }
  if (isPlainObject(value)) return "an object";
  return String(value);
}

function valueError(path: string, op: string | undefined, message: string): DbError {
  return new DbError("INVALID_QUERY", [
    { path, message: `Invalid filter value for "${path}"${op ? ` (${op})` : ""}: ${message}` },
  ]);
}

function holdsStrings(vt: TValueType): boolean {
  return vt.kinds.has("string") || vt.kinds.has("any");
}

function checkRegex(path: string, vt: TValueType, op: string, pattern: unknown): void {
  if (!holdsStrings(vt)) {
    throw valueError(
      path,
      op,
      `a pattern match needs a string field, "${path}" holds ${expectedOf(vt)}`,
    );
  }
  if (typeof pattern !== "string" && !(pattern instanceof RegExp)) {
    throw valueError(path, op, `expected a regular expression, got ${describeValue(pattern)}`);
  }
}

function checkValue(path: string, vt: TValueType, op: string | undefined, value: unknown): void {
  if (value instanceof RegExp) {
    checkRegex(path, vt, op ?? "RegExp", value);
    return;
  }
  const bad = rejectedValue(vt, value);
  if (bad) {
    throw valueError(path, op, `expected ${expectedOf(vt)}, got ${describeValue(bad.value)}`);
  }
}

/** Operators whose operand is compared with the field's values. */
const COMPARE_OPS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"]);

/** Checks one filter entry's value (a bare value or an operator map) against `vt`. */
function checkEntry(path: string, vt: TValueType, value: unknown): void {
  if (vt.kinds.has("any")) return;
  if (!isPlainObject(value)) {
    checkValue(path, vt, undefined, value);
    return;
  }
  for (const [op, operand] of Object.entries(value)) {
    if (op === "$regex") {
      checkRegex(path, vt, op, operand);
    } else if (COMPARE_OPS.has(op)) {
      checkValue(path, vt, op, operand);
    }
  }
}

/**
 * Walks `filter` (through `$and` / `$or` / `$not`; relational predicates are
 * the related table's) and checks every entry whose key `typeOf` knows.
 */
function walkFilterValues(filter: unknown, typeOf: (key: string) => TValueType | undefined): void {
  if (!isPlainObject(filter)) return;
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) {
        for (const child of value) walkFilterValues(child, typeOf);
      }
      continue;
    }
    if (key === "$not") {
      walkFilterValues(value, typeOf);
      continue;
    }
    if (key.startsWith("$") || hasRelationOp(value)) continue;
    const vt = typeOf(key);
    if (vt) checkEntry(key, vt, value);
  }
}

/**
 * Rejects (`INVALID_QUERY`, `path` = the field) a filter value that cannot
 * denote its field's declared type — see the module notes for the accepted
 * forms. Unknown paths are skipped (the path guard owns them).
 */
export function guardFilterValues(meta: TableMetadata, filter: FilterExpr | undefined): void {
  if (!filter) return;
  walkFilterValues(filter, (key) => {
    const fd = meta.descriptorByPath.get(key);
    return fd ? valueTypeOf(meta, fd) : undefined;
  });
}

/**
 * `$having` values: an aggregate alias is a number (`count`,
 * `countDistinct`, `sum`, `avg`) or its source field's type (`min` / `max`),
 * a calendar-bucket alias a string label, any other key a `$groupBy`
 * field's own type.
 */
export function guardHavingValues(
  meta: TableMetadata,
  controls: { $select?: unknown; $having?: unknown } | undefined,
): void {
  if (!controls?.$having) return;
  const aliases = new Map<string, TValueType>();
  if (Array.isArray(controls.$select)) {
    for (const item of controls.$select) {
      if (isAggregateExpr(item)) {
        const fd =
          item.$fn === "min" || item.$fn === "max"
            ? meta.descriptorByPath.get(item.$field)
            : undefined;
        const counts = item.$fn === "count" || item.$fn === "countDistinct";
        aliases.set(resolveAlias(item), fd ? valueTypeOf(meta, fd) : counts ? INTEGER : NUMBER);
      } else if (isBucketExpr(item)) {
        aliases.set(resolveAlias(item), STRING);
      }
    }
  }
  walkFilterValues(controls.$having, (key) => {
    const alias = aliases.get(key);
    if (alias) return alias;
    const fd = meta.descriptorByPath.get(key);
    return fd ? valueTypeOf(meta, fd) : undefined;
  });
}
