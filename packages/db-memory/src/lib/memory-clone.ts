/**
 * Deep clone with the exact observable result of `structuredClone` — fast for
 * the plain data the store holds (plain objects, dense arrays, `Date`s and
 * primitives), and delegating to `structuredClone` for everything else.
 *
 * The fast walk gives up — and the WHOLE value is re-cloned by
 * `structuredClone` — on anything whose `structuredClone` result it would not
 * reproduce exactly: a function or symbol (so the `DataCloneError` still
 * throws), a non-plain prototype (class instances, `Map`, `Set`, typed arrays,
 * `RegExp`, boxed primitives, …), an own `__proto__` key, a sparse array or
 * one carrying extra own properties, and an object reached twice (a cycle or a
 * shared subtree — `structuredClone` preserves both, a tree walk would not).
 */
export function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    // A function / symbol throws `DataCloneError`, like `structuredClone`.
    return typeof value === "function" || typeof value === "symbol"
      ? structuredClone(value)
      : value;
  }
  const seen = new Set<object>();
  const out = walk(value, seen);
  return out === GIVE_UP ? structuredClone(value) : (out as T);
}

const GIVE_UP: unique symbol = Symbol("give-up");

const OBJECT_PROTO = Object.prototype;
const ARRAY_PROTO = Array.prototype;
const DATE_PROTO = Date.prototype;

function walk(value: object, seen: Set<object>): unknown {
  if (seen.has(value)) {
    return GIVE_UP;
  }
  seen.add(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === ARRAY_PROTO) {
    const src = value as unknown[];
    const len = src.length;
    const arr: unknown[] = [];
    for (let i = 0; i < len; i++) {
      if (!(i in src)) {
        return GIVE_UP;
      }
      const item = leaf(src[i], seen);
      if (item === GIVE_UP) {
        return GIVE_UP;
      }
      arr.push(item);
    }
    // Dense, so `Object.keys` exceeds `length` only for extra own properties.
    return Object.keys(src).length === len ? arr : GIVE_UP;
  }
  if (proto === OBJECT_PROTO || proto === null) {
    const src = value as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      if (key === "__proto__") {
        return GIVE_UP;
      }
      const item = leaf(src[key], seen);
      if (item === GIVE_UP) {
        return GIVE_UP;
      }
      obj[key] = item;
    }
    return obj;
  }
  if (proto === DATE_PROTO) {
    return new Date((value as Date).getTime());
  }
  return GIVE_UP;
}

function leaf(value: unknown, seen: Set<object>): unknown {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "object":
      return walk(value, seen);
    case "function":
    case "symbol":
      return GIVE_UP;
    default:
      return value;
  }
}
