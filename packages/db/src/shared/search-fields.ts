import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { TIMESTAMP_TAGS } from "./numeric-operand";

/** How a field takes part in `$search`: matched as text, or by whole-number equality / decimal text. */
export type TSearchMemberKind = "text" | "integer";

/**
 * Problem suffixes, shared by the plugin (compile time) and the runtime
 * metadata build so both word a refusal identically.
 */
export const SEARCH_PROBLEM = {
  timestamp: "is a timestamp — filter it by range instead",
  now: "is a timestamp (@db.default.now) — filter it by range instead",
  precision: "has @db.column.precision (stored as a decimal)",
  float:
    "is a floating-point number — declare it number.int (or a sized integer), add @expect.int, or use @db.default.increment",
  floatViewField:
    "is a floating-point number — declare it number.int (or a sized integer) or add @expect.int",
  decimal: "is a decimal",
} as const;

/** Problem for a primitive of another base type (`boolean`, …). */
export function otherBaseProblem(base: string): string {
  return `is a ${base}`;
}

/** What a field's declared type and annotations say about searching it (since 0.1.150). */
export interface TSearchFieldDescriptor {
  /** Primitive base (`string`, `number`, `decimal`, `boolean`, …) or `undefined` when not a plain primitive. */
  base: string | undefined;
  tags?: ReadonlySet<string>;
  expectInt?: boolean;
  increment?: boolean;
  now?: boolean;
  precision?: boolean;
}

/**
 * The one rule behind `@db.column.searchable` / `@db.index.fulltext`:
 * a string (or a non-primitive) is `"text"`; an integer is `"integer"`;
 * floats, decimals, timestamps and other primitives are a `{ problem }`.
 */
export function searchKindOf(d: TSearchFieldDescriptor): TSearchMemberKind | { problem: string } {
  const { base } = d;
  if (base === undefined || base === "string") return "text";
  if (base === "decimal") return { problem: SEARCH_PROBLEM.decimal };
  if (base !== "number" && base !== "integer") return { problem: otherBaseProblem(base) };
  if (d.tags && TIMESTAMP_TAGS.some((t) => d.tags!.has(t))) {
    return { problem: SEARCH_PROBLEM.timestamp };
  }
  if (d.now) return { problem: SEARCH_PROBLEM.now };
  if (d.precision) return { problem: SEARCH_PROBLEM.precision };
  if (base === "integer" || d.tags?.has("int") || d.expectInt || d.increment) return "integer";
  return { problem: SEARCH_PROBLEM.float };
}

/**
 * Runtime mirror of the plugin's verdict: how the annotated type takes part
 * in `$search`. Structures, arrays, unions and unresolved types keep their
 * legacy `"text"` treatment.
 */
export function searchMemberKind(
  type: TAtscriptAnnotatedType | undefined,
): TSearchMemberKind | { problem: string } {
  const def = type?.type as { kind?: string; designType?: string; tags?: ReadonlySet<string> };
  if (!def || def.kind !== "") return "text";
  const metadata = type!.metadata as { has?(key: string): boolean };
  const has = (key: string) => metadata?.has?.(key) === true;
  return searchKindOf({
    base: def.designType,
    tags: def.tags,
    expectInt: has("expect.int"),
    increment: has("db.default.increment"),
    now: has("db.default.now"),
    precision: has("db.column.precision"),
  });
}

/**
 * Field annotations of the search / index features that cannot work over
 * ciphertext — refused on an `@db.encrypted` field, on any field inside one
 * and on a view field over an encrypted source (compile time and metadata
 * build).
 * @since 0.1.162
 */
export const ENCRYPTED_SEARCH_FEATURES = [
  "db.column.searchable",
  "db.index.fulltext",
  "db.index.geo",
  "db.search.vector",
  "db.search.filter",
  "db.mongo.search.text",
  "db.mongo.search.autocomplete",
] as const;

/** Why each of {@link ENCRYPTED_SEARCH_FEATURES} cannot sit on an `@db.encrypted` field. */
const ENCRYPTED_SEARCH_WHY: Readonly<Record<(typeof ENCRYPTED_SEARCH_FEATURES)[number], string>> =
  {
    "db.column.searchable": "search over ciphertext is impossible",
    "db.index.fulltext": "indexes over ciphertext are meaningless",
    "db.index.geo": "geo indexes over ciphertext are meaningless",
    "db.search.vector": "vector search over ciphertext is impossible",
    "db.search.filter": "search filters need cleartext equality",
    "db.mongo.search.text": "Atlas Search over ciphertext is impossible",
    "db.mongo.search.autocomplete": "Atlas Search over ciphertext is impossible",
  };

/**
 * Annotations an `@db.encrypted` field cannot carry, with the reason — the
 * compile-time `@db.encrypted` check and the metadata build share it (the
 * search rows are {@link ENCRYPTED_SEARCH_FEATURES}).
 * @since 0.1.162
 */
export const ENCRYPTED_INCOMPATIBLE: ReadonlyArray<[annotation: string, why: string]> = [
  ["meta.id", "the primary key must be addressable"],
  ["db.rel.FK", "joins are impossible over ciphertext"],
  ["db.index.plain", "indexes over ciphertext are meaningless"],
  ["db.index.unique", "indexes over ciphertext are meaningless"],
  ...ENCRYPTED_SEARCH_FEATURES.map((key): [string, string] => [key, ENCRYPTED_SEARCH_WHY[key]]),
  ["db.column.version", "the OCC filter needs cleartext equality"],
  ["db.default.increment", "engine-side defaults bypass the encryption transform"],
  ["db.default.now", "engine-side defaults bypass the encryption transform"],
  ["db.onUpdate.now", "the update time is set after the encryption transform"],
  ["db.onUpdate.inc", "the counter is incremented by the database"],
];
