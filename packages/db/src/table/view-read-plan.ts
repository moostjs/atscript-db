import type {
  AtscriptQueryFieldRef,
  AtscriptQueryNode,
  TAtscriptAnnotatedType,
} from "@atscript/typescript/utils";

import { isFieldRef, walkViewExpr, type TViewJoin, type TViewPlan } from "../query/query-tree";
import type { TViewSource } from "./view-source";
import type { TViewColumnMapping } from "./db-view";

/**
 * One read variant of a managed view with the left joins its query does not
 * need removed — see `AtscriptDbView.readPlan`.
 * @since 0.1.153
 */
export interface TViewReadPlan {
  /** The view plan without the dropped joins (entry table and view filter unchanged). */
  readonly plan: TViewPlan;
  /** The column mappings that remain readable — every mapping none of whose sources was dropped. */
  readonly columns: TViewColumnMapping[];
  /** Scopes of the dropped joins, in declaration order. */
  readonly dropped: readonly string[];
  /** Physical view columns the variant no longer exposes. */
  readonly droppedColumns: readonly string[];
  /** Identifies the variant within its view (the dropped scopes) — a cache key. */
  readonly key: string;
}

/** What the planner needs from the view (kept narrow for unit tests). */
export interface TViewPrunerHost {
  readonly viewPlan: TViewPlan;
  getViewColumnMappings(): TViewColumnMapping[];
  resolveRefSource(ref: AtscriptQueryFieldRef): { table: string; source: TViewSource };
  /** Whether the adapter stores nested documents (MongoDB) rather than flat columns. */
  readonly nested: boolean;
  /**
   * The unique column sets (physical, the primary key included) of a joined
   * BASE table, or `undefined` when the target is a view or cannot be resolved.
   */
  uniqueKeySets(targetType: TAtscriptAnnotatedType): readonly (readonly string[])[] | undefined;
  /**
   * How a field ref's source column compares: `compare` identifies its
   * comparison semantics (collation and engine-type overrides, the table's
   * charset / collation) — two columns compare alike when equal; `encrypted`
   * when it stores ciphertext.
   */
  fieldTraits(ref: AtscriptQueryFieldRef): { compare: string; encrypted: boolean };
}

/** Design types whose `=` compares one scalar to one scalar on every engine. */
const SCALAR_TYPES = new Set(["string", "number", "boolean", "decimal", "bigint"]);

/** The comparisons of a pure conjunction (nested `$and`s flattened), or `undefined` for any `$or` / `$not`. */
function conjuncts(
  node: AtscriptQueryNode,
  out: AtscriptQueryNode[] = [],
): AtscriptQueryNode[] | undefined {
  if ("$and" in node) {
    for (const child of (node as { $and: AtscriptQueryNode[] }).$and) {
      if (!conjuncts(child, out)) return undefined;
    }
    return out;
  }
  if ("$or" in node || "$not" in node) return undefined;
  out.push(node);
  return out;
}

/** Every scope a predicate references (its field refs' tables). */
function predicateScopes(
  host: TViewPrunerHost,
  node: AtscriptQueryNode,
  out: Set<string>,
): Set<string> {
  if ("$and" in node || "$or" in node) {
    const children = node as { $and?: AtscriptQueryNode[]; $or?: AtscriptQueryNode[] };
    for (const child of children.$and ?? children.$or ?? []) predicateScopes(host, child, out);
    return out;
  }
  if ("$not" in node) {
    return predicateScopes(host, (node as { $not: AtscriptQueryNode }).$not, out);
  }
  const comp = node as { left: AtscriptQueryFieldRef; right?: unknown };
  out.add(host.resolveRefSource(comp.left).table);
  if (isFieldRef(comp.right)) out.add(host.resolveRefSource(comp.right).table);
  return out;
}

/** Whether a literal `value` compares as the scalar design type `designType` (no implicit casts). */
function literalMatches(value: unknown, designType: string): boolean {
  switch (typeof value) {
    case "string":
      return designType === "string";
    case "number":
      return designType === "number" || designType === "decimal";
    case "boolean":
      return designType === "boolean";
    default:
      return false;
  }
}

/**
 * Whether the left join `join` matches AT MOST ONE target row per input row,
 * so dropping it (when nothing reads it) leaves every result row in place:
 *
 * - a first-row join (its ON pins the target's primary key to one value);
 * - otherwise its condition is a conjunction whose `=` comparisons pin EVERY
 *   column of one of the target's unique keys (primary key included) to a
 *   value that does not depend on the target — another scope's field of the
 *   same scalar design type that compares alike (collation, type overrides,
 *   table charset), or a literal of that type.
 *   Other conjuncts only narrow the match.
 *
 * Never for an inner join (it filters), a target that is a view (its
 * uniqueness is unknown), or a predicate with `$or` / `$not`. On a document
 * store every pinned key field must also be required: a unique index over an
 * optional field is partial there, and a missing value would match many.
 */
function atMostOneMatch(host: TViewPrunerHost, join: TViewJoin): boolean {
  if (join.kind !== "left") return false;
  const keySets = host.uniqueKeySets(join.targetType());
  if (!keySets) return false;
  if (join.first) return true;
  const comparisons = conjuncts(join.condition);
  if (!comparisons) return false;
  const pinned = new Set<string>();
  for (const node of comparisons) {
    const comp = node as { left: AtscriptQueryFieldRef; op: string; right?: unknown };
    if (comp.op !== "$eq" || comp.right === null || comp.right === undefined) continue;
    const left = host.resolveRefSource(comp.left);
    const rightRef = isFieldRef(comp.right) ? comp.right : undefined;
    const right = rightRef ? host.resolveRefSource(rightRef) : undefined;
    let target: { ref: AtscriptQueryFieldRef; source: TViewSource };
    let other: { ref: AtscriptQueryFieldRef; source: TViewSource } | undefined;
    if (left.table === join.scope && right?.table !== join.scope) {
      target = { ref: comp.left, source: left.source };
      other = right && rightRef ? { ref: rightRef, source: right.source } : undefined;
    } else if (right && rightRef && right.table === join.scope && left.table !== join.scope) {
      target = { ref: rightRef, source: right.source };
      other = { ref: comp.left, source: left.source };
    } else {
      continue;
    }
    const { source } = target;
    if (source.jsonPath || source.flattened || !SCALAR_TYPES.has(source.designType)) continue;
    if (host.nested && source.optional) continue;
    const traits = host.fieldTraits(target.ref);
    if (traits.encrypted) continue;
    if (other) {
      const o = other.source;
      if (o.jsonPath || o.flattened || o.designType !== source.designType) continue;
      const otherTraits = host.fieldTraits(other.ref);
      if (otherTraits.encrypted || otherTraits.compare !== traits.compare) continue;
    } else if (!literalMatches(comp.right, source.designType)) {
      continue;
    }
    pinned.add(source.column);
  }
  return keySets.some((set) => set.length > 0 && set.every((column) => pinned.has(column)));
}

/** The precomputed, query-independent part of a view's pruning. */
interface TPrunerState {
  /** Scopes every read keeps: the entry, the view filter's, every non-droppable join's. */
  base: Set<string>;
  joins: Array<{ join: TViewJoin; droppable: boolean; refs: Set<string> }>;
  /** Scopes each mapping reads (a computed column: its operands', transitively). */
  columnScopes: Map<TViewColumnMapping, Set<string>>;
  byColumn: Map<string, TViewColumnMapping>;
  columns: TViewColumnMapping[];
}

function prunerState(host: TViewPrunerHost): TPrunerState | undefined {
  const plan = host.viewPlan;
  if (plan.materialized || !plan.joins.some((j) => j.kind === "left")) return undefined;
  const columns = host.getViewColumnMappings();
  // Grouped views (v1): every row feeds a group, keep the definition as is
  if (columns.some((c) => c.aggFn)) return undefined;

  const joins = plan.joins.map((join) => {
    const refs = predicateScopes(host, join.condition, new Set());
    for (const { ref } of join.first?.order ?? []) refs.add(host.resolveRefSource(ref).table);
    refs.delete(join.scope);
    return { join, droppable: atMostOneMatch(host, join), refs };
  });
  if (!joins.some((j) => j.droppable)) return undefined;

  const base = new Set<string>([plan.entryTable]);
  if (plan.filter) predicateScopes(host, plan.filter, base);
  for (const j of joins) {
    if (!j.droppable) base.add(j.join.scope);
  }

  const byPath = new Map(columns.map((c) => [c.viewPath, c]));
  const columnScopes = new Map<TViewColumnMapping, Set<string>>();
  const scopesOf = (c: TViewColumnMapping): Set<string> => {
    let scopes = columnScopes.get(c);
    if (scopes) return scopes;
    scopes = new Set<string>();
    columnScopes.set(c, scopes);
    if (c.expr === undefined) {
      scopes.add(c.sourceTable);
    } else {
      const out = scopes;
      walkViewExpr(c.expr, (path) => {
        const leaf = byPath.get(path);
        // The mapping builder rejects an unknown operand; keep everything if one slipped through
        if (!leaf) {
          for (const j of joins) out.add(j.join.scope);
          return;
        }
        for (const scope of scopesOf(leaf)) out.add(scope);
      });
    }
    return scopes;
  };
  for (const c of columns) scopesOf(c);

  return {
    base,
    joins,
    columnScopes,
    byColumn: new Map(columns.map((c) => [c.viewColumn, c])),
    columns,
  };
}

/**
 * The read planner of one managed view: memoised per dropped-join set.
 * @since 0.1.153
 */
export class ViewReadPlanner {
  private _state?: TPrunerState | null;
  private readonly _variants = new Map<string, TViewReadPlan>();

  constructor(private readonly _host: TViewPrunerHost) {}

  /** Whether any join of the view can ever be dropped. */
  get prunable(): boolean {
    return this._getState() !== undefined;
  }

  private _getState(): TPrunerState | undefined {
    if (this._state === undefined) {
      try {
        this._state = prunerState(this._host) ?? null;
      } catch {
        // A view whose refs do not resolve fails where it is created / read —
        // never prune it.
        this._state = null;
      }
    }
    return this._state ?? undefined;
  }

  /** The mappings a needed (physical) name reads: exact, or a document path above / below it. */
  private _matching(state: TPrunerState, name: string): TViewColumnMapping[] {
    const exact = state.byColumn.get(name);
    if (exact) return [exact];
    return state.columns.filter(
      (c) => name.startsWith(`${c.viewColumn}.`) || c.viewColumn.startsWith(`${name}.`),
    );
  }

  plan(needed: Iterable<string> | undefined): TViewReadPlan | undefined {
    const state = this._getState();
    if (!state) return undefined;
    const keep = new Set(state.base);
    const read =
      needed === undefined ? state.columns : [...needed].flatMap((n) => this._matching(state, n));
    for (const c of read) {
      for (const scope of state.columnScopes.get(c)!) keep.add(scope);
    }
    // Reverse pass: a join's ON references only the entry and EARLIER joins,
    // so one pass from the last join reaches the fixpoint.
    const dropped: string[] = [];
    for (let i = state.joins.length - 1; i >= 0; i--) {
      const { join, droppable, refs } = state.joins[i];
      if (droppable && !keep.has(join.scope)) {
        dropped.push(join.scope);
      } else {
        for (const scope of refs) keep.add(scope);
      }
    }
    if (dropped.length === 0) return undefined;
    dropped.reverse();
    const key = dropped.join("\u0000");
    let variant = this._variants.get(key);
    if (!variant) {
      const gone = new Set(dropped);
      const plan = this._host.viewPlan;
      const columns: TViewColumnMapping[] = [];
      const droppedColumns: string[] = [];
      for (const c of state.columns) {
        const reads = state.columnScopes.get(c)!;
        if ([...reads].some((scope) => gone.has(scope))) droppedColumns.push(c.viewColumn);
        else columns.push(c);
      }
      variant = {
        plan: { ...plan, joins: plan.joins.filter((j) => !gone.has(j.scope)) },
        columns,
        dropped,
        droppedColumns,
        key,
      };
      this._variants.set(key, variant);
    }
    return variant;
  }
}
