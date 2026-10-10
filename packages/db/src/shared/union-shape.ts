import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

/** `null` / `undefined` as a type: a union member that only adds NULL. */
export function isNullishType(type: TAtscriptAnnotatedType): boolean {
  const def = type.type as { kind: string; designType?: string };
  return def.kind === "" && (def.designType === "null" || def.designType === "undefined");
}

/**
 * The value members of a union — nested unions expanded (a flat-union entry
 * of `flattenAnnotatedType` holds the prop's own union besides its members,
 * an alias member may be a union itself), `null` / `undefined` left out,
 * each member once. `nullable`: a `null` / `undefined` member was left out.
 */
export function unionValueMembers(type: TAtscriptAnnotatedType): {
  members: TAtscriptAnnotatedType[];
  nullable: boolean;
} {
  const members = new Set<TAtscriptAnnotatedType>();
  let nullable = false;
  const visit = (t: TAtscriptAnnotatedType, depth: number): void => {
    if (t.type.kind === "union" && depth < 8) {
      for (const item of (t.type as { items: TAtscriptAnnotatedType[] }).items) {
        visit(item, depth + 1);
      }
    } else if (isNullishType(t)) {
      nullable = true;
    } else {
      members.add(t);
    }
  };
  visit(type, 0);
  return { members: [...members], nullable };
}

/**
 * The one value member of a union (`T | null` → `T`), or `undefined` when
 * `type` is no union or has several value members. A column of a nullable
 * union is the column `T` alone would get (its type tags, size, precision).
 */
export function soleUnionMember(type: TAtscriptAnnotatedType): TAtscriptAnnotatedType | undefined {
  if (type.type.kind !== "union") return undefined;
  const { members } = unionValueMembers(type);
  return members.length === 1 ? members[0] : undefined;
}

/**
 * Whether a value at a path is always there (`"required"`), may be NULL /
 * missing (`"nullable"` — the path or an ancestor object is optional or a
 * `| null` union), or is declared by only some members of a union of objects
 * on the way (`"partial"` — `card` of `payment: Card | Bank` when only
 * `Card` declares it). Ordered: each is weaker than the previous one.
 */
export type TPathPresence = "required" | "nullable" | "partial";

const RANK: Record<TPathPresence, number> = { required: 0, nullable: 1, partial: 2 };

function weaker(a: TPathPresence, b: TPathPresence): TPathPresence {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * The {@link TPathPresence} of the dot-path `path` below the object type
 * `root`, or `undefined` when the path crosses an array or a tuple (its
 * elements' fields are no columns of their own on relational storage;
 * callers keep the field's own `optional` there).
 */
export function pathPresence(
  root: TAtscriptAnnotatedType,
  path: string,
): TPathPresence | undefined {
  return presenceAt(root, path.split("."), 0);
}

function presenceAt(
  type: TAtscriptAnnotatedType,
  segs: readonly string[],
  i: number,
): TPathPresence | undefined {
  const def = type.type as {
    kind: string;
    items?: TAtscriptAnnotatedType[];
    props?: Map<string, TAtscriptAnnotatedType>;
  };
  switch (def.kind) {
    case "union": {
      let result: TPathPresence = "required";
      for (const item of def.items!) {
        if (isNullishType(item)) {
          result = weaker(result, "nullable");
          continue;
        }
        const member = presenceAt(item, segs, i);
        if (member === undefined) return undefined;
        result = weaker(result, member);
      }
      return result;
    }
    case "intersection": {
      // Every item's fields are there: the strongest item answer wins.
      let result: TPathPresence = "partial";
      for (const item of def.items!) {
        const member = presenceAt(item, segs, i);
        if (member === undefined) return undefined;
        if (RANK[member] < RANK[result]) result = member;
      }
      return result;
    }
    case "object": {
      if (i === segs.length) return "required";
      const prop = def.props!.get(segs[i]!);
      if (!prop) return "partial";
      const rest = presenceAt(prop, segs, i + 1);
      if (rest === undefined) return undefined;
      return prop.optional ? weaker(rest, "nullable") : rest;
    }
    case "array":
    case "tuple": {
      return i === segs.length ? "required" : undefined;
    }
    default: {
      if (i < segs.length) return "partial";
      return isNullishType(type) ? "nullable" : "required";
    }
  }
}
