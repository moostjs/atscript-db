import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

/**
 * The one non-`null` item of a `T | null` union (`number.timestamp.created |
 * null` → `number.timestamp.created`), nested unions expanded (a flat-map
 * entry of a union field holds the field's own union besides its items).
 * `undefined` for any other type, including a union of two or more non-`null`
 * items.
 */
export function nullableUnionBase(
  type: TAtscriptAnnotatedType,
): TAtscriptAnnotatedType | undefined {
  if (type.type.kind !== "union") return undefined;
  const items = new Set<TAtscriptAnnotatedType>();
  const visit = (t: TAtscriptAnnotatedType, depth: number): void => {
    if (t.type.kind === "union" && depth < 8) {
      for (const item of (t.type as { items: TAtscriptAnnotatedType[] }).items) {
        visit(item, depth + 1);
      }
    } else if (t.type.kind !== "" || (t.type as { designType?: string }).designType !== "null") {
      items.add(t);
    }
  };
  visit(type, 0);
  return items.size === 1 ? items.values().next().value : undefined;
}

/**
 * The `T` of a field typed `T | null` whose db annotations (`@db.default.now`
 * of `number.timestamp.created`) describe the field's column like those of a
 * field typed `T`. Not for a reference to another field (`closedAt:
 * Order.closedAt`): it shares that field's union, whose db annotations stay
 * with the referenced field.
 */
export function columnUnionBase(type: TAtscriptAnnotatedType): TAtscriptAnnotatedType | undefined {
  return type.ref?.field ? undefined : nullableUnionBase(type);
}
