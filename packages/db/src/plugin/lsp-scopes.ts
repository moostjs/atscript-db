import { isRef } from "@atscript/core";
import type {
  SemanticNode,
  TAnnotationArgument,
  TAnnotationTokens,
  Token,
  TQueryScope,
} from "@atscript/core";

import {
  getAnnotationAlias,
  getDbTableOwner,
  getNavTargetTypeName,
} from "../shared/annotation-utils";
import {
  earlierJoinTargets,
  isAliasDecl,
  isDbSourceDecl,
  viewJoins,
  viewScopeTypes,
} from "../shared/validation-utils";

/**
 * Editor scopes of the `@db.*` query / field-path arguments and the type
 * filters of the ref arguments — one function per rule. The validators in
 * `annotations/*` derive their in-scope types from these SAME functions, so a
 * diagnostic and what the editor completes, hovers and jumps to never diverge.
 * @since 0.1.141
 */

/** The `@db.view.for` entry name of a view node. */
function viewEntry(view: SemanticNode): string | undefined {
  return getAnnotationAlias(view, "db.view.for");
}

/**
 * `@db.view.filter` — and a conditional `@db.agg.*` of the same view: the
 * entry table and every `@db.view.joins` target (`@db.alias` names included),
 * in declaration order; an unqualified field belongs to the entry.
 */
export function viewFilterScope(view: SemanticNode): TQueryScope | undefined {
  const entry = viewEntry(view);
  return entry ? { allowedTypes: viewScopeTypes(view), unqualifiedTarget: entry } : undefined;
}

/**
 * `@db.view.joins` condition: the join target, the entry table and the joins
 * declared before this one (chained joins — `earlier`, computed from the
 * view's {@link viewJoins} when the caller has not); an unqualified field
 * belongs to the entry.
 */
export function viewJoinScope(
  view: SemanticNode,
  join: TAnnotationTokens,
  earlier: string[] = earlierJoinTargets(viewJoins(view), join),
): TQueryScope | undefined {
  const entry = viewEntry(view);
  const target = join.args[0]?.text;
  if (!entry || !target) {
    return undefined;
  }
  return { allowedTypes: [target, entry, ...earlier], unqualifiedTarget: entry };
}

/** `@db.view.having`: the view's own fields, unqualified — no source type is in scope. */
export function viewHavingScope(view: SemanticNode): TQueryScope | undefined {
  return view.id ? { allowedTypes: [], unqualifiedTarget: view.id } : undefined;
}

/** The condition of a `@db.agg.*` on a view field: the scope of the view's `@db.view.filter`. */
export function aggConditionScope(propToken: Token): TQueryScope | undefined {
  const view = getDbTableOwner(propToken);
  return view ? viewFilterScope(view) : undefined;
}

/**
 * The field of a `@db.agg.*` (`'amount'`, `'settings.level'`): a field path
 * of the prop's chain-ref type, else of the view's `@db.view.for` entry —
 * where the runtime reads the aggregate's source column from.
 */
export function aggFieldScope(propToken: Token): TQueryScope | undefined {
  const def = propToken.parentNode?.getDefinition();
  const refType = def && isRef(def) && def.hasChain ? def.id : undefined;
  const view = refType ? undefined : getDbTableOwner(propToken);
  const target = refType ?? (view ? viewEntry(view) : undefined);
  return target ? { allowedTypes: [], unqualifiedTarget: target } : undefined;
}

/**
 * `@db.rel.filter` on a navigational field: the related type (`Post` of
 * `posts: Post[]`) and, for `@db.rel.via`, the junction table; an
 * unqualified field belongs to the related type.
 */
export function relFilterScope(field: SemanticNode): TQueryScope | undefined {
  const target = getNavTargetTypeName(field);
  if (!target) {
    return undefined;
  }
  const junction = getAnnotationAlias(field, "db.rel.via");
  return { allowedTypes: junction ? [target, junction] : [target], unqualifiedTarget: target };
}

type TFieldScopeHook = NonNullable<TAnnotationArgument["fieldScope"]>;

/** The `fieldScope` hooks (argument token → scope) the annotation specs declare. */
export const fieldScopes = {
  viewFilter: (arg) => (arg.parentNode ? viewFilterScope(arg.parentNode) : undefined),
  viewJoin: (arg) => {
    const view = arg.parentNode;
    const joins = view ? viewJoins(view) : [];
    const join = joins.find((a) => a.args.includes(arg));
    return view && join ? viewJoinScope(view, join, earlierJoinTargets(joins, join)) : undefined;
  },
  viewHaving: (arg) => (arg.parentNode ? viewHavingScope(arg.parentNode) : undefined),
  aggCondition: aggConditionScope,
  aggField: aggFieldScope,
  relFilter: (arg) => (arg.parentNode ? relFilterScope(arg.parentNode) : undefined),
} satisfies Record<string, TFieldScopeHook>;

// The `refFilter` predicates of the ref arguments — the validators pass the
// same predicate to `validateRefArgument` (`accept`). `@db.view.for` and
// `@db.alias` accept a view source (`isDbSourceDecl`: a `@db.table` or a
// `@db.view`, managed or external).

/** `refFilter` of the `@db.view.joins` target: a view source or a `@db.alias` of one. */
export function isJoinTarget(decl: SemanticNode): boolean {
  return isDbSourceDecl(decl) || isAliasDecl(decl);
}

/** `refFilter` of `@db.rel.via`: a `@db.table`. */
export function isDbTable(decl: SemanticNode): boolean {
  return decl.countAnnotations("db.table") > 0;
}
