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
