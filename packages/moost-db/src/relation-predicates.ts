import type { AtscriptDbReadable, FilterExpr, TFilterRef } from "@atscript/db";
import {
  collectQueryPaths,
  containsRelationFilter,
  hasRelationOp,
  isPlainObject,
  isRelationOp,
  unsupportedOperatorMessage,
} from "@atscript/db";
import type { HttpError } from "@moostjs/event-http";

import type { TDbRequestContext, TDbRequestEndpoint } from "./as-readable.controller";

import { badRequest } from "./http-errors";
import { FieldCapabilityIndex, type TCapabilityVerdict } from "./meta/field-capabilities";

/**
 * Client relational predicates (`nav=$some(…)` / `nav=$none(…)`, since
 * 0.1.147) at the HTTP layer: the request gate and the
 * `transformRelationFilter` overlay walk. Server-side filters
 * (`transformFilter`, `transformOne`, `actionRowScope`) never pass through
 * here — they are the authorization rule itself.
 *
 * Invariant: a client predicate on relation `n` reveals nothing that
 * `$with=n(<same filter>)` would not reveal under the same controller policy
 * — same visibility (`hasField` at `n` and `n.*`), the related table's own
 * capability rules (encrypted, `@db.writeOnly`, JSON storage,
 * `@db.table.filterable 'manual'`, geo, …) and the same row overlay
 * (`transformRelationFilter`). On top, the relation must opt in with
 * `@db.rel.filterable` (a predicate filters the PARENT rows).
 */

/**
 * Nesting limit of CLIENT relational predicates per predicate chain (`$with`
 * hops don't count; server-added predicates are not counted). Below the
 * core's `REL_FILTER_MAX_DEPTH` so server overlays have headroom.
 *
 * @since 0.1.147
 */
export const REL_FILTER_CLIENT_MAX_DEPTH = 3;

/**
 * Count limit of CLIENT relational predicates per request — root filter and
 * `$with` sub-filters together. Below the core's `REL_FILTER_MAX_NODES` so
 * server overlays have headroom.
 *
 * @since 0.1.147
 */
export const REL_FILTER_CLIENT_MAX_NODES = 8;

/** What the gate reads of its controller. */
export interface TRelationGateHost {
  /** The controller's bound readable. */
  readonly readable: AtscriptDbReadable<any>;
  /** The controller's `hasField` (request-scoped visibility). */
  hasField(path: string): boolean;
  /** `hasField` is overridden — the `@db.column.derived` source rule applies. */
  readonly scoped: boolean;
  /** `@db.column.derived` path → source path of a readable. */
  derivedSourcesOf(readable: AtscriptDbReadable<any>): ReadonlyMap<string, readonly string[]>;
  /** `@db.writeOnly` own paths of a related readable. */
  writeOnlyOf(readable: AtscriptDbReadable<any>): ReadonlySet<string>;
  /** The bound readable's capability index. */
  capabilities(): FieldCapabilityIndex;
}

/** Per-request gate state: predicates counted across the root filter and every `$with` sub-filter. */
export interface TRelationGateState {
  nodes: number;
}

/** A parsed `$with` entry (nested `$with` under `controls`, or flat on the entry — legacy shape). */
type TWithEntry = {
  name: string;
  filter?: FilterExpr;
  controls?: Record<string, unknown>;
  $with?: unknown;
};

function verdictError(verdict: TCapabilityVerdict | undefined): HttpError | undefined {
  return verdict ? badRequest(verdict.path, verdict.message) : undefined;
}

/** The readable a `$with` entry name (`rel` or dotted `rel.sub`) loads from, if resolvable. */
export function relTarget(
  readable: AtscriptDbReadable<any>,
  name: string,
): AtscriptDbReadable<any> | undefined {
  let current: AtscriptDbReadable<any> | undefined = readable;
  for (const segment of name.split(".")) {
    if (typeof current?.relatedTable !== "function") return undefined;
    current = current.relatedTable(segment) as AtscriptDbReadable<any> | undefined;
  }
  return current;
}

/** The nested `$with` of an entry, wherever the parser put it. */
export function childrenOf(rel: TWithEntry): unknown {
  return rel.controls?.$with ?? rel.$with;
}

/**
 * The HTTP gate of client relational predicates — one per controller (it
 * caches the related readables' capability indexes).
 */
export class RelationPredicateGate {
  /** Capability indexes of related readables (rebuilt when their adapter signature changes). */
  private readonly _indexes = new WeakMap<object, FieldCapabilityIndex>();

  constructor(private readonly host: TRelationGateHost) {}

  /**
   * Checks one `relation` filter ref (`collectQueryPaths`) of `readable`'s
   * filter; `prefix` is `readable`'s dotted path from the controller (`""`
   * for the bound readable), `depth` the predicate nesting level of the
   * filter the ref sits in.
   *
   * In order: the navigation field is visible (`hasField(prefix + nav)`,
   * else `Unknown field` — hidden ≡ nonexistent), is a relation, is
   * `@db.rel.filterable`, its related table resolves, the depth / count caps
   * hold (`REL_FILTER_CLIENT_MAX_DEPTH` per chain, `REL_FILTER_CLIENT_MAX_NODES`
   * per request — client predicates only; the core's higher caps leave
   * headroom for server overlays), and every operand passes the related table's own gate — plain
   * paths through its capability index under the visibility at
   * `prefix + nav + "."`, nested predicates recursively.
   */
  checkRef(
    ref: TFilterRef,
    state: TRelationGateState,
    readable: AtscriptDbReadable<any> = this.host.readable,
    prefix = "",
    depth = 0,
  ): HttpError | undefined {
    const nav = ref.path;
    const path = prefix + nav;
    if (!this.host.hasField(path)) {
      return badRequest(path, `Unknown field "${path}"`);
    }
    const relation = readable.relations?.get(nav);
    if (!relation) {
      return badRequest(path, notARelationMessage(readable, nav, path));
    }
    if (relation.filterable !== true) {
      return badRequest(
        path,
        `Filtering by related "${path}" rows is not permitted — add @db.rel.filterable to enable.`,
      );
    }
    const target =
      typeof readable.relatedTable === "function"
        ? (readable.relatedTable(nav) as AtscriptDbReadable<any> | undefined)
        : undefined;
    if (!target) {
      return badRequest(
        path,
        `Filtering by related "${path}" rows is not possible — the related table is not available.`,
      );
    }
    if (depth + 1 > REL_FILTER_CLIENT_MAX_DEPTH) {
      return badRequest(
        path,
        `Relational predicates nest at most ${REL_FILTER_CLIENT_MAX_DEPTH} levels deep ("${path}")`,
      );
    }
    if (++state.nodes > REL_FILTER_CLIENT_MAX_NODES) {
      return badRequest(
        path,
        `At most ${REL_FILTER_CLIENT_MAX_NODES} relational predicates per query`,
      );
    }
    for (const { op, filter } of ref.relation ?? []) {
      if (!isPlainObject(filter)) {
        return badRequest(path, `"${op}" on "${path}" expects a filter object`);
      }
      const error = this._checkOperand(filter as FilterExpr, target, `${path}.`, depth + 1, state);
      if (error) return error;
    }
    return undefined;
  }

  /**
   * Predicates inside `$with` sub-filters (every level): the same rules,
   * with the entry's path as the prefix (`$with=tickets(issues=$some(…))`
   * gates `tickets.issues`) and the request-wide count in `state`.
   */
  checkWith(
    withRels: unknown,
    state: TRelationGateState,
    readable: AtscriptDbReadable<any> = this.host.readable,
    prefix = "",
  ): HttpError | undefined {
    if (!Array.isArray(withRels)) return undefined;
    for (const rel of withRels as TWithEntry[]) {
      if (typeof rel?.name !== "string") continue;
      const target = relTarget(readable, rel.name);
      if (!target) continue;
      const path = `${prefix}${rel.name}.`;
      if (rel.filter && containsRelationFilter(rel.filter)) {
        for (const ref of collectQueryPaths({ filter: rel.filter }).filter) {
          if (ref.predicate !== "relation") continue;
          const error = this.checkRef(ref, state, target, path);
          if (error) return error;
        }
      }
      const nested = this.checkWith(childrenOf(rel), state, target, path);
      if (nested) return nested;
    }
    return undefined;
  }

  /** One predicate operand against its related table (`prefix` = `"<nav chain>."`). */
  private _checkOperand(
    filter: FilterExpr,
    target: AtscriptDbReadable<any>,
    prefix: string,
    depth: number,
    state: TRelationGateState,
  ): HttpError | undefined {
    const refs = collectQueryPaths({ filter });
    if (refs.unsupportedOperator !== undefined) {
      return badRequest(
        refs.unsupportedOperator,
        unsupportedOperatorMessage(refs.unsupportedOperator),
      );
    }
    const index = this._indexOf(target);
    const visible = (p: string) => this._visibleAt(target, prefix, p);
    for (const ref of refs.filter) {
      const error =
        ref.predicate === "relation"
          ? this.checkRef(ref, state, target, prefix, depth)
          : verdictError(
              index.check(ref.path, "filter", visible, ref.predicate, prefix, ref.nullTest),
            );
      if (error) return error;
    }
    return undefined;
  }

  /**
   * `p` of `target` is visible at `prefix + p` — `hasField`, and (when it is
   * overridden) a derived field only while its source is visible too (a
   * computed view column while every operand is): the
   * rule the controller applies to its own fields and `$with` targets.
   */
  private _visibleAt(target: AtscriptDbReadable<any>, prefix: string, p: string): boolean {
    const host = this.host;
    if (!host.hasField(prefix + p)) return false;
    if (!host.scoped) return true;
    const sources = host.derivedSourcesOf(target).get(p);
    return sources === undefined || sources.every((source) => host.hasField(prefix + source));
  }

  /** The capability index of a related readable — the bound one's own for a self relation. */
  private _indexOf(readable: AtscriptDbReadable<any>): FieldCapabilityIndex {
    if (readable === this.host.readable) return this.host.capabilities();
    const cached = this._indexes.get(readable);
    if (cached && cached.signature === FieldCapabilityIndex.adapterSignature(readable)) {
      return cached;
    }
    const index = new FieldCapabilityIndex(readable, this.host.writeOnlyOf(readable));
    this._indexes.set(readable, index);
    return index;
  }
}

/** A `$some` / `$none` on something that is not a navigation relation of `readable`. */
function notARelationMessage(readable: AtscriptDbReadable<any>, nav: string, path: string): string {
  const dot = nav.indexOf(".");
  if (dot > 0 && readable.relations?.has(nav.slice(0, dot))) {
    // A dotted navigation path: one relation hop per nesting level.
    return (
      `"${path}" is a navigation path — nest the predicates, one relation per level: ` +
      `${nav.slice(0, dot)}=$some(${nav.slice(dot + 1)}=$some(…))`
    );
  }
  return `"$some" / "$none" are only valid on a navigation relation — "${path}" is not one`;
}

/**
 * The first relational-predicate key of a parsed request's insights (the
 * URL parser records `nav` with `$some` / `$none`, nested ones as
 * `nav.sub`, `$with` sub-filter ones under the entry's path) that
 * `hasField` rejects — answered `Unknown field "<key>"` before any operand
 * path under it, so a hidden relation reads exactly like a nonexistent one.
 */
export function hiddenRelationInsight(
  insights: ReadonlyMap<string, unknown>,
  hasField: (path: string) => boolean,
): string | undefined {
  for (const [key, ops] of insights) {
    if (!(ops instanceof Set)) continue;
    for (const op of ops as Set<string>) {
      if (isRelationOp(op) && !hasField(key)) return key;
    }
  }
  return undefined;
}

type TRelationHook = (path: string, filter: FilterExpr) => FilterExpr | Promise<FilterExpr>;

/**
 * The CLIENT's `$with` tree of one request, recorded before
 * `validateControls` (since 0.1.147) — a server hook may conjoin row scopes
 * (which may themselves use relational predicates) into `$with` entry
 * filters there. The gate judges {@link tree} only, and the overlay rewrites
 * only the predicate maps in {@link predicates}, so server-added predicates
 * are neither gated, counted, nor overlaid.
 */
export interface TClientWithSnapshot {
  /** Structural copy of the client's entries (`name`, `filter`, nested `$with`); `undefined` without client predicates. */
  readonly tree: unknown;
  /** The client's predicate operator maps (`{ $some: … }`) — the live objects. */
  readonly predicates: ReadonlySet<object>;
}

/** Records the client's `$with` tree — see {@link TClientWithSnapshot}. `undefined` when there is none. */
export function snapshotClientWith(withRels: unknown): TClientWithSnapshot | undefined {
  if (!Array.isArray(withRels) || withRels.length === 0) return undefined;
  const predicates = new Set<object>();
  const collect = (rels: unknown): void => {
    if (!Array.isArray(rels)) return;
    for (const rel of rels as TWithEntry[]) {
      if (typeof rel?.name !== "string") continue;
      if (rel.filter) collectPredicateMaps(rel.filter, predicates);
      collect(childrenOf(rel));
    }
  };
  collect(withRels);
  // No client predicate: nothing to gate or overlay — skip the copy.
  if (predicates.size === 0) return { tree: undefined, predicates };
  const copy = (rels: unknown): unknown => {
    if (!Array.isArray(rels)) return undefined;
    return rels.map((raw) => {
      const rel = raw as TWithEntry;
      if (typeof rel?.name !== "string") return raw;
      const children = copy(childrenOf(rel));
      const out: TWithEntry = { name: rel.name };
      if (rel.filter) out.filter = copyClientFilter(rel.filter);
      if (children !== undefined) out.controls = { $with: children };
      return out;
    });
  };
  return { tree: copy(withRels), predicates };
}

/**
 * A detached deep copy of a parsed client filter (plain objects, arrays,
 * RegExp, Date), deep-frozen with `freeze`. Fails closed: a value that can't
 * be copied is a 400, never the live object a later hook may rewrite.
 */
export function copyClientFilter<T>(filter: T, freeze = false): T {
  let copy: T;
  try {
    copy = structuredClone(filter);
  } catch {
    throw badRequest("", "Malformed query: the filter cannot be copied");
  }
  if (freeze) deepFreeze(copy);
  return copy;
}

function deepFreeze(v: unknown): void {
  if (v === null || typeof v !== "object" || Object.isFrozen(v)) return;
  Object.freeze(v);
  for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
}

/** The predicate operator maps of a filter's own level (through `$and` / `$or` / `$not`). */
function collectPredicateMaps(filter: unknown, out: Set<object>): void {
  if (!isPlainObject(filter)) return;
  for (const [key, value] of Object.entries(filter)) {
    if ((key === "$and" || key === "$or") && Array.isArray(value)) {
      for (const child of value) collectPredicateMaps(child, out);
    } else if (key === "$not") {
      collectPredicateMaps(value, out);
    } else if (!key.startsWith("$") && hasRelationOp(value)) {
      out.add(value);
    }
  }
}

/** Which predicate maps an overlay walk may rewrite, and which of them it met. */
interface TOverlayScope {
  readonly predicates: ReadonlySet<object>;
  readonly seen: Set<object>;
}

/**
 * Awaits `items` concurrently, resolving to their values in order. When some
 * reject, the first rejection IN ORDER is thrown (not the first to settle) —
 * the error a sequential walk would have surfaced.
 */
async function allInOrder<T>(items: ReadonlyArray<T | Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(items);
  return settled.map((r) => {
    if (r.status === "rejected") throw r.reason;
    return r.value;
  });
}

/**
 * Rewrites every client predicate operand of `filter` through `hook`
 * (`transformRelationFilter`) with its full dotted path (`prefix + nav`).
 * Nested predicates of an operand are rewritten first, then the operand
 * (with them) goes through `hook` — so the hook's own output (e.g. a
 * server-side row scope that itself uses predicates) is never walked again.
 * Sibling predicates are rewritten concurrently. Returns `filter` itself
 * when it holds no predicate; never mutates it.
 */
export function overlayRelationFilter(
  filter: FilterExpr,
  prefix: string,
  hook: TRelationHook,
  scope?: TOverlayScope,
): Promise<FilterExpr> {
  if (!containsRelationFilter(filter)) return Promise.resolve(filter);
  return overlayWalk(filter, prefix, hook, scope);
}

/** {@link overlayRelationFilter} without the pre-scan: `filter` itself when nothing changed. */
async function overlayWalk(
  filter: unknown,
  prefix: string,
  hook: TRelationHook,
  scope: TOverlayScope | undefined,
): Promise<FilterExpr> {
  if (!isPlainObject(filter)) return filter as FilterExpr;
  const entries = Object.entries(filter);
  const values = await allInOrder(
    entries.map(([key, value]) => overlayEntry(key, value, prefix, hook, scope)),
  );
  let out: Record<string, unknown> | undefined;
  for (let i = 0; i < entries.length; i++) {
    if (values[i] === entries[i]![1]) continue;
    out ??= { ...filter };
    out[entries[i]![0]] = values[i];
  }
  return (out ?? filter) as FilterExpr;
}

async function overlayEntry(
  key: string,
  value: unknown,
  prefix: string,
  hook: TRelationHook,
  scope: TOverlayScope | undefined,
): Promise<unknown> {
  if ((key === "$and" || key === "$or") && Array.isArray(value)) {
    const children = await allInOrder(
      value.map((child) => overlayWalk(child, prefix, hook, scope)),
    );
    return children.some((child, i) => child !== value[i]) ? children : value;
  }
  if (key === "$not") return overlayWalk(value, prefix, hook, scope);
  if (key.startsWith("$") || !hasRelationOp(value)) return value;
  // A server-added predicate (e.g. a row scope conjoined in validateControls): not the client's.
  if (scope && !scope.predicates.has(value)) return value;
  scope?.seen.add(value);
  const path = prefix + key;
  const ops = Object.entries(value);
  const operands = await allInOrder(
    ops.map(([op, operand]) =>
      isRelationOp(op) && isPlainObject(operand)
        ? overlayRelationFilter(operand as FilterExpr, `${path}.`, hook).then((inner) =>
            hook(path, inner),
          )
        : operand,
    ),
  );
  const out: Record<string, unknown> = {};
  for (let i = 0; i < ops.length; i++) out[ops[i]![0]] = operands[i];
  return out;
}

/**
 * {@link overlayRelationFilter} over a `$with` tree: every entry's
 * sub-filter at its path (`tickets.` for `$with=tickets(…)`), recursively and
 * concurrently. With a `scope`, only the client's predicate maps (its
 * `predicates`, recorded by {@link snapshotClientWith}) are rewritten — each
 * one met is added to `scope.seen`. Returns the same array when nothing
 * changed.
 */
export async function overlayWithFilters(
  withRels: unknown,
  prefix: string,
  hook: TRelationHook,
  scope?: TOverlayScope,
): Promise<unknown> {
  if (!Array.isArray(withRels) || withRels.length === 0) return withRels;
  const walked = await allInOrder(
    withRels.map((rel: TWithEntry) => overlayWithEntry(rel, prefix, hook, scope)),
  );
  let out: unknown[] | undefined;
  for (let i = 0; i < walked.length; i++) {
    if (walked[i] === withRels[i]) continue;
    out ??= [...withRels];
    out[i] = walked[i];
  }
  return out ?? withRels;
}

async function overlayWithEntry(
  rel: TWithEntry,
  prefix: string,
  hook: TRelationHook,
  scope: TOverlayScope | undefined,
): Promise<TWithEntry> {
  if (typeof rel?.name !== "string") return rel;
  const path = `${prefix}${rel.name}.`;
  const children = childrenOf(rel);
  const [filter, walked] = await allInOrder<unknown>([
    rel.filter ? overlayRelationFilter(rel.filter, path, hook, scope) : rel.filter,
    overlayWithFilters(children, path, hook, scope),
  ]);
  if (filter === rel.filter && walked === children) return rel;
  const next: TWithEntry = { ...rel, filter: filter as FilterExpr | undefined };
  if (walked !== children) {
    if (rel.controls?.$with !== undefined) next.controls = { ...rel.controls, $with: walked };
    else next.$with = walked;
  }
  return next;
}

/** `true` when `filter` holds a relational predicate (nested ones live inside a top-level one). */
function hasClientPredicate(filter: unknown): boolean {
  if (!isPlainObject(filter)) return false;
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value) && value.some(hasClientPredicate)) return true;
    } else if (key === "$not") {
      if (hasClientPredicate(value)) return true;
    } else if (!key.startsWith("$") && hasRelationOp(value)) {
      return true;
    }
  }
  return false;
}

/**
 * A read's {@link TDbRequestContext}: controls, plus the client filter when
 * present (since 0.1.147) — a frozen copy, made on first read, so the hook
 * can never rewrite the object the request gate judges afterwards — and
 * whether it holds relational predicates (`hasRelationFilters`, computed
 * without copying).
 */
export function readRequestContext(
  endpoint: TDbRequestEndpoint,
  controls: Record<string, unknown>,
  filter: FilterExpr | undefined,
): TDbRequestContext {
  // `POST /` carries one control, `$onConflict`: surfaced as `onConflict`, not as `controls`.
  if (endpoint === "insert") {
    return controls.$onConflict === "ignore" ? { endpoint, onConflict: "ignore" } : { endpoint };
  }
  if (!filter || Object.keys(filter).length === 0) {
    return { endpoint, controls, hasRelationFilters: false };
  }
  let copy: FilterExpr | undefined;
  return {
    endpoint,
    controls,
    hasRelationFilters: hasClientPredicate(filter),
    get filter() {
      return (copy ??= copyClientFilter(filter, true));
    },
  };
}
