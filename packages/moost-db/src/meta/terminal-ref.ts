import {
  serializeAnnotatedType,
  type TAtscriptAnnotatedType,
  type TAtscriptTypeObject,
  type TSerializeOptions,
  type TSerializedAnnotatedType,
  type TSerializedAnnotatedTypeInner,
} from "@atscript/typescript/utils";

/**
 * Terminal-reference resolution for `/meta` and `/meta/form/:name`
 * (since 0.1.128).
 *
 * A prop declared through a reference chain — a view field `code: Issue.code`
 * where `Issue.code: Dict.code` carries `@db.rel.FK` — serializes with
 * `refDepth: 0.5` as a shallow ref to its DIRECT hop (`Issue.code`), and the
 * `@db.rel.FK` marker does not travel through references. Value-help pickers
 * therefore target the wrong table. This post-pass re-points every serialized
 * `ref` to the chain's terminal field (the column's value domain) and
 * inherits the FK marker when any hop of the chain is an FK. The runtime type
 * is never mutated; direct references serialize byte-identically.
 */

/** Result of walking a reference chain to its end. */
export interface TTerminalRef {
  type: TAtscriptAnnotatedType;
  field: string;
  /** `true` when the prop itself or any hop of its chain carries `@db.rel.FK`. */
  fk: boolean;
}

type TShallowTarget = { id: string; metadata: Record<string, unknown> };

const NAV_KEYS = ["db.rel.to", "db.rel.from", "db.rel.via"] as const;

function isNav(metadata: { has(key: string): boolean }): boolean {
  return NAV_KEYS.some((key) => metadata.has(key));
}

/**
 * Resolves a (possibly dotted) prop path against an object type by walking
 * `type.props` one segment at a time. Bails with `undefined` as soon as a hop
 * is not an object type or the segment is missing.
 */
export function resolveProp(
  type: TAtscriptAnnotatedType,
  field: string,
): TAtscriptAnnotatedType | undefined {
  let current: TAtscriptAnnotatedType | undefined = type;
  for (const segment of field.split(".")) {
    if (!current || current.type.kind !== "object") return undefined;
    current = (current.type as TAtscriptTypeObject).props.get(segment);
  }
  return current;
}

/**
 * Follows `def.ref` hop by hop until a prop without a `ref` (a primary key or
 * a plain column) is reached. Cycle-safe (visited on `<typeId>.<field>`) and
 * bounded by chain length.
 */
export function resolveTerminalRef(def: TAtscriptAnnotatedType): TTerminalRef | undefined {
  const ref = def.ref;
  if (!ref) return undefined;
  let type = ref.type();
  let field = ref.field;
  if (!type) return undefined;
  let fk = def.metadata.has("db.rel.FK");
  const visited = new Set<string>([`${type.id ?? ""}.${field}`]);
  for (;;) {
    const prop = resolveProp(type, field);
    if (!prop) break;
    if (prop.metadata.has("db.rel.FK")) fk = true;
    const next = prop.ref;
    if (!next) break;
    const nextType = next.type();
    if (!nextType) break;
    const key = `${nextType.id ?? ""}.${next.field}`;
    if (visited.has(key)) break;
    visited.add(key);
    type = nextType;
    field = next.field;
  }
  return { type, field, fk };
}

/**
 * Post-pass over a serialized type in lock-step with its runtime type: every
 * object prop (recursing into nested objects and array elements — never into
 * `ref` bodies or navigation subtrees) whose runtime prop has a `ref` gets its
 * serialized `ref` re-pointed to the terminal field (shallow `{ id, metadata }`
 * target, serialized with the same annotation whitelist) and, when the chain
 * passes an FK, `metadata["db.rel.FK"] = true` (never the hop's alias).
 *
 * Only shallow refs (`refDepth` with a `.5` step) are rewritten; a full-body
 * ref target is left alone. Mutates and returns `serialized`.
 */
export function applyTerminalRefs(
  serialized: TSerializedAnnotatedType,
  runtime: TAtscriptAnnotatedType,
  options: TSerializeOptions,
): TSerializedAnnotatedType {
  const shallowCache = new Map<TAtscriptAnnotatedType, TShallowTarget>();
  const shallow = (type: TAtscriptAnnotatedType): TShallowTarget => {
    let target = shallowCache.get(type);
    if (!target) {
      target = {
        id: type.id ?? "",
        metadata: serializeAnnotatedType(type, { ...options, refDepth: 0 }).metadata,
      };
      shallowCache.set(type, target);
    }
    return target;
  };
  walk(serialized, runtime, shallow);
  return serialized;
}

function walk(
  node: TSerializedAnnotatedTypeInner,
  def: TAtscriptAnnotatedType,
  shallow: (type: TAtscriptAnnotatedType) => TShallowTarget,
): void {
  const kind = def.type.kind;
  if (kind === "object") {
    const sType = node.type as {
      kind: string;
      props?: Record<string, TSerializedAnnotatedTypeInner>;
    };
    if (sType.kind !== "object" || !sType.props) return;
    for (const [name, prop] of (def.type as TAtscriptTypeObject).props) {
      const sProp = sType.props[name];
      if (!sProp) continue;
      // Nav subtrees expand fully and their FK props are direct hops — skip.
      if (isNav(prop.metadata)) continue;
      if (prop.ref && sProp.ref && !("type" in sProp.ref.type)) {
        const terminal = resolveTerminalRef(prop);
        if (terminal) {
          const direct = prop.ref.type();
          if (terminal.type !== direct || terminal.field !== prop.ref.field) {
            sProp.ref = { field: terminal.field, type: shallow(terminal.type) };
          }
          if (terminal.fk && sProp.metadata["db.rel.FK"] === undefined) {
            sProp.metadata["db.rel.FK"] = true;
          }
        }
      }
      walk(sProp, prop, shallow);
    }
    return;
  }
  if (kind === "array") {
    const sType = node.type as { kind: string; of?: TSerializedAnnotatedTypeInner };
    const of = (def.type as unknown as { of?: TAtscriptAnnotatedType }).of;
    if (sType.kind === "array" && sType.of && of) walk(sType.of, of, shallow);
  }
}
