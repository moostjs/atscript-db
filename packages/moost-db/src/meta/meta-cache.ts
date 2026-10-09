/**
 * `/meta` identity memo (since 0.1.151). Each layer that turns the cached
 * envelope into a request's `/meta` object memoizes its output per INPUT
 * identity and per the request-dependent answers it reads (the key), so
 * equal inputs give the same object across requests. The final object is
 * then registered with wooks' `prerenderJson` (JSON serialized once, weak
 * ETag from the bytes).
 *
 * Soundness: a memoized object is never mutated (the `applyMetaOverlay`
 * contract), so its identity implies its bytes; every key covers every
 * request-dependent input its layer reads. Inputs that are not themselves
 * stable (an overlay that builds a fresh object per request) are not memoized —
 * their output is computed per request, as before, and gets no ETag.
 */

/** Objects whose identity implies their bytes: cached envelopes and memo outputs derived from one. */
const stable = new WeakSet<object>();

/**
 * Most memoized variants derived from one root envelope, over all chained
 * layers (planner → index visibility → delegated actions → own path); past it
 * a variant is computed per request (and is not stable).
 */
const MAX_VARIANTS_PER_ROOT = 128;

/** The root envelope each memo output was derived from (for the budget). */
const rootOf = new WeakMap<object, object>();
/** Variants memoized so far per root envelope. */
const rootBudget = new WeakMap<object, number>();

/** Memoized variants per input object, then per key — one per controller instance. */
export type TMetaVariants = WeakMap<object, Map<string, object>>;

/** Marks `obj` as identity-stable (never mutated after this point). Returns it. */
export function markStableMeta<T extends object>(obj: T): T {
  stable.add(obj);
  return obj;
}

/**
 * Marks a `/meta` payload your override memoizes (an `applyMetaOverlay`
 * variant, a `metaForm` projection) as reusable: it is deep-frozen and, when
 * served again, sent from its serialized-once JSON with an `ETag`. Return the
 * same object for the same inputs only — its bytes are fixed from now on.
 *
 * @since 0.1.151
 */
export function stableMeta<T extends object>(obj: T): T {
  deepFreeze(obj);
  return markStableMeta(obj);
}

/**
 * `obj` may be memoized on and registered for prerendering: a cached envelope,
 * a memo output, or an object passed to {@link stableMeta}. (Frozenness alone
 * is not enough: `Object.freeze` is shallow.)
 */
export function isStableMeta(obj: object): boolean {
  return stable.has(obj);
}

/**
 * The memoized variant of `input` for `key` in `variants` — `compute()` once
 * per (input, key). Keys of different layers must not collide (prefix them).
 * An unstable input is not memoized (computed every time); past
 * {@link MAX_VARIANTS_PER_ROOT} variants of one envelope a variant is computed
 * per request (and is not stable).
 */
export function metaVariant<T extends object>(
  variants: TMetaVariants,
  input: T,
  key: string,
  compute: () => T,
): T {
  if (!isStableMeta(input)) return compute();
  let byKey = variants.get(input);
  const hit = byKey?.get(key);
  if (hit) return hit as T;
  const out = compute();
  const root = rootOf.get(input) ?? input;
  const used = rootBudget.get(root) ?? 0;
  if (used < MAX_VARIANTS_PER_ROOT) {
    rootBudget.set(root, used + 1);
    if (out !== input) {
      markStableMeta(out);
      rootOf.set(out, root);
    }
    if (!byKey) variants.set(input, (byKey = new Map()));
    byKey.set(key, out);
  }
  return out;
}

/** Stable small ids for objects (memo keys over object identities). */
const ids = new WeakMap<object, number>();
let nextId = 1;

/** A per-process id of `obj`'s identity. */
export function identityId(obj: object): number {
  let id = ids.get(obj);
  if (id === undefined) ids.set(obj, (id = nextId++));
  return id;
}

/** Bit string of `flags` (memo key). */
export function bits(flags: Iterable<boolean>): string {
  let out = "";
  for (const flag of flags) out += flag ? "1" : "0";
  return out;
}

let freezeServed: boolean | undefined;
const deepFrozen = new WeakSet<object>();

/**
 * Shared objects are deep-frozen when `NODE_ENV` is `test` or
 * `development`, or `ATSCRIPT_DB_FREEZE_META=1` — an in-place mutation (which
 * would keep serving the old bytes) then throws instead.
 */
function shouldFreeze(): boolean {
  if (freezeServed === undefined) {
    const env = typeof process === "undefined" ? undefined : process.env;
    freezeServed =
      env?.NODE_ENV === "test" ||
      env?.NODE_ENV === "development" ||
      env?.ATSCRIPT_DB_FREEZE_META === "1";
  }
  return freezeServed;
}

/**
 * Deep-freezes `obj` in dev / test (see {@link shouldFreeze}); a no-op
 * otherwise. For objects shared across requests (served `/meta` payloads,
 * memoized projections), which must never be mutated.
 */
export function freezeShared(obj: object): void {
  if (!shouldFreeze()) return;
  deepFreeze(obj);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || deepFrozen.has(value)) return;
  deepFrozen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
}
