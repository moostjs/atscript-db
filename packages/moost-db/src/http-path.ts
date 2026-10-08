import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type { Moost } from "moost";

import { findReadableBinding } from "./decorators";
import { captureDesignTime, getDesignTime } from "./http-path-design-time";

const KEY = "db.http.path";

/**
 * Normalizes a controller prefix into a public path: one leading slash, no
 * empty segments, no trailing slash.
 *
 * @since 0.1.150
 */
export function normalizeHttpPath(prefix: string): string {
  return `/${prefix.split("/").filter(Boolean).join("/")}`;
}

/** A path with a route parameter or a wildcard cannot be a static picker URL. */
export function isParametricPath(path: string): boolean {
  return path.split("/").some((s) => s.startsWith(":") || s.includes("*"));
}

// ── Constructor-recorded ctor → model pairs ─────────────────────────────

const bound = new WeakMap<Function, Map<TAtscriptAnnotatedType, boolean | undefined>>();
let boundVersion = 0;

/**
 * Records that `ctor` serves `type` (called by the readable base constructor).
 * Pure bookkeeping — nothing is written to the model. Only a NEW pair bumps
 * the version that invalidates per-app scopes.
 */
export function recordBoundType(
  ctor: Function,
  type: TAtscriptAnnotatedType,
  canonical?: boolean,
): void {
  let models = bound.get(ctor);
  if (!models) {
    models = new Map();
    bound.set(ctor, models);
  }
  if (!models.has(type) || models.get(type) !== canonical) {
    models.set(type, canonical);
    boundVersion++;
  }
}

// ── Per-app scope ────────────────────────────────────────────────────────

/** The published path of every model one app serves (`null`: mounted, published nowhere). */
export interface THttpPathScope {
  readonly paths: ReadonlyMap<TAtscriptAnnotatedType, string | null>;
}

interface TAppState {
  scope?: THttpPathScope;
  version: number;
  published: boolean;
  hookAdded: boolean;
  warned: Set<string>;
}

const apps = new WeakMap<object, TAppState>();

function stateOf(app: object): TAppState {
  let s = apps.get(app);
  if (!s) {
    s = { version: -1, published: false, hookAdded: false, warned: new Set() };
    apps.set(app, s);
  }
  return s;
}

interface TMount {
  ctor: Function;
  path: string;
  canonical: boolean | undefined;
  fromAnnotation: boolean;
  parametric: boolean;
}

const idOf = (type: TAtscriptAnnotatedType): string =>
  (type as { id?: string }).id ?? "(unnamed model)";

const hasOverview = (app: unknown): app is Moost =>
  !!app && typeof (app as Moost).getControllersOverview === "function";

function endsWithSegments(path: string, suffix: string): boolean {
  const a = path.split("/").filter(Boolean);
  const b = suffix.split("/").filter(Boolean);
  if (b.length > a.length) return false;
  return b.every((seg, i) => a[a.length - b.length + i] === seg);
}

function warnOnce(app: Moost, s: TAppState, key: string, message: string): void {
  if (s.warned.has(key)) return;
  s.warned.add(key);
  try {
    app.getLogger?.("moost-db")?.warn(message);
  } catch {
    // a logger problem must never break publishing
  }
}

function buildScope(app: Moost, s: TAppState): THttpPathScope {
  const mounts = new Map<TAtscriptAnnotatedType, TMount[]>();
  for (const o of app.getControllersOverview()) {
    if (typeof o.computedPrefix !== "string") continue;
    const ctor = o.type as Function;
    const binding = findReadableBinding(ctor);
    const recorded = bound.get(ctor);
    const models: [TAtscriptAnnotatedType, boolean | undefined][] = recorded?.size
      ? [...recorded]
      : binding?.model
        ? [[binding.model, undefined]]
        : [];
    if (models.length === 0) continue;
    if (models.length > 1) {
      warnOnce(
        app,
        s,
        `multi-model|${ctor.name}`,
        `[moost-db] ${ctor.name} serves several models; none of them gets a published value-help path (db.http.path).`,
      );
      continue;
    }
    const [model, recordedCanonical] = models[0];
    const path = normalizeHttpPath(o.computedPrefix);
    const ownPrefix = (o.meta?.controller?.prefix as string | undefined) ?? "";
    const fromAnnotation =
      binding?.prefixSource === "annotation" &&
      ownPrefix === binding.prefix &&
      endsWithSegments(path, binding.prefix ?? "");
    const list = mounts.get(model) ?? [];
    list.push({
      ctor,
      path,
      canonical: binding?.canonical ?? recordedCanonical,
      fromAnnotation,
      parametric: isParametricPath(path),
    });
    mounts.set(model, list);
  }

  const paths = new Map<TAtscriptAnnotatedType, string | null>();
  for (const [model, list] of mounts) {
    paths.set(model, resolveCanonical(app, s, model, list));
  }
  return { paths };
}

const distinct = (list: readonly TMount[]): string[] => [...new Set(list.map((m) => m.path))];

function resolveCanonical(
  app: Moost,
  s: TAppState,
  model: TAtscriptAnnotatedType,
  list: readonly TMount[],
): string | null {
  const cands = list.filter((m) => !m.parametric && m.canonical !== false);
  const marked = distinct(cands.filter((m) => m.canonical === true));
  if (marked.length === 1) return marked[0];
  if (marked.length > 1) return ambiguous(app, s, model, cands, "has several canonical mounts");
  const all = distinct(cands);
  if (all.length === 0) return null;
  if (all.length === 1) return all[0];
  const derived = distinct(cands.filter((m) => m.fromAnnotation));
  if (derived.length === 1) return derived[0];
  return ambiguous(app, s, model, cands, "is served by several controllers on different routes");
}

function ambiguous(
  app: Moost,
  s: TAppState,
  model: TAtscriptAnnotatedType,
  cands: readonly TMount[],
  what: string,
): null {
  const where = cands.map((m) => `${m.ctor.name} at ${m.path}`);
  const id = idOf(model);
  warnOnce(
    app,
    s,
    `${id}|${distinct(cands).toSorted().join(",")}|${what}`,
    `[moost-db] Model "${id}" ${what}:\n  ${where.join(", ")}.\n` +
      `Its value-help path (db.http.path) is left unset, so references to it render no picker.\n` +
      `Mark the controller that serves its value help with \`canonical: true\`\n` +
      `(@TableController(${id}, { canonical: true }), or a value-help controller's \`{ canonical: true }\`\n` +
      `constructor option) or \`canonical: false\` on the others, or declare @db.http.path on the\n` +
      `model and mount that controller without an explicit prefix.`,
  );
  return null;
}

/**
 * The scope of `app`: built lazily, rebuilt on publish or when a new
 * controller → model pair was recorded. A hit never polls the overview.
 * `undefined` when `app` has no controller overview (mock apps).
 */
export function httpPathScopeFor(app: Moost | undefined): THttpPathScope | undefined {
  if (!hasOverview(app)) return undefined;
  const s = stateOf(app);
  if (!s.scope || s.version !== boundVersion) {
    s.scope = buildScope(app, s);
    s.version = boundVersion;
  }
  return s.scope;
}

// ── Global compat mirror ─────────────────────────────────────────────────

/** Models whose runtime metadata a publish wrote, with the value written. */
const mirrored = new Map<TAtscriptAnnotatedType, string | undefined>();

/** (Re)builds the scope of `app`, warns on ambiguity and writes the global compat mirror. */
export function publishDbHttpPaths(app: Moost): void {
  if (!hasOverview(app)) return;
  const s = stateOf(app);
  s.published = true;
  s.scope = buildScope(app, s);
  s.version = boundVersion;
  const { paths } = s.scope;
  for (const [type, value] of paths) {
    captureDesignTime(type);
    if (value === null) type.metadata.delete(KEY);
    else type.metadata.set(KEY, value);
    mirrored.set(type, value ?? undefined);
  }
  for (const [type, written] of mirrored) {
    if (paths.has(type)) continue;
    if (type.metadata.get(KEY) === written) {
      const original = getDesignTime(type);
      if (original === undefined) type.metadata.delete(KEY);
      else type.metadata.set(KEY, original);
    }
    mirrored.delete(type);
  }
}

/** Lazy fallback for apps that never ran the hook (singletons reused across apps). */
export function ensurePublished(app: Moost | undefined): void {
  if (!hasOverview(app)) return;
  if (!stateOf(app).published) publishDbHttpPaths(app);
}

/** Registers the publish hook once per app (no-op on mock apps without `addInitHook`). */
export function addPublishHook(app: Moost | undefined): void {
  if (!app || typeof app.addInitHook !== "function") return;
  const s = stateOf(app);
  if (s.hookAdded) return;
  s.hookAdded = true;
  app.addInitHook((a) => publishDbHttpPaths(a), { priority: Number.MIN_SAFE_INTEGER });
}

/**
 * The `annotationOverrides` contribution for `scope`: the only way a path
 * reaches the wire. Models the app does not serve pass through at their
 * design-time value (never another app's mirror).
 */
export function httpPathOverrides(
  scope: THttpPathScope,
  type: TAtscriptAnnotatedType,
): Readonly<Record<string, unknown>> | undefined {
  if (scope.paths.has(type)) return { [KEY]: scope.paths.get(type) ?? undefined };
  if (mirrored.has(type) && type.metadata.get(KEY) === mirrored.get(type)) {
    return { [KEY]: getDesignTime(type) };
  }
  return undefined;
}
