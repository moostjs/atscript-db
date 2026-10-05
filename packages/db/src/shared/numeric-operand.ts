/** Primitive tags of timestamps (MySQL may store them as native `TIMESTAMP`). */
export const TIMESTAMP_TAGS = ["timestamp", "created", "updated"];

/** What decides whether a field can be an arithmetic operand: its base type and primitive tags. */
export interface TNumericOperandDescriptor {
  base: string;
  tags?: ReadonlySet<string>;
}

/**
 * Why a field cannot be an arithmetic operand, or `undefined` when it can: it
 * must be a `number` — not a decimal (exact; an expression is IEEE double) and
 * not a timestamp-tagged number. The one rule behind `@db.compute` (declared,
 * from the `.as` source) and query-time arithmetic (from the runtime
 * descriptor), so the two cannot diverge. Storage rules (`@db.ignore`,
 * encrypted, JSON) stay with the callers.
 */
export function numericTypeProblem({ base, tags }: TNumericOperandDescriptor): string | undefined {
  if (base !== "number" && base !== "integer") {
    return base === "decimal" ? "is a decimal" : `is a ${base}`;
  }
  if (tags && TIMESTAMP_TAGS.some((t) => tags.has(t))) return "is a timestamp";
  return undefined;
}
