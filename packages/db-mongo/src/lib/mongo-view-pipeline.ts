import {
  isFieldRef,
  translateQueryTree,
  type AtscriptDbView,
  type AtscriptQueryFieldRef,
  type AtscriptQueryNode,
  type TViewColumnMapping,
  type TViewJoin,
} from "@atscript/db";
import type { Document } from "mongodb";

import { buildAccumulator, distinctCountExpr } from "./mongo-accumulator";
import { buildMongoFilter } from "./mongo-filter";
import { JOINED_PREFIX } from "./mongo-types";
import { orNull, queryNodeToExpr } from "./mongo-view-expr";

/** Where a joined table's document lands (`$lookup.as`, then unwound). */
function joinedAs(table: string): string {
  return `${JOINED_PREFIX}${table}`;
}

/**
 * Builds the aggregation pipeline of a managed MongoDB view (created with
 * `viewOn: <entry collection>`):
 *
 * 1. per join, in declaration order: `$lookup` + `$unwind` (inner joins drop
 *    unmatched documents, left joins keep them — `preserveNullAndEmptyArrays`);
 * 2. `@db.view.filter` → `$match`;
 * 3. aggregates → `$group` (+ `$addFields` turning `countDistinct` sets into
 *    their sizes, + `@db.view.having` → `$match`) + `$project`, otherwise a
 *    flat `$project`. A conditional aggregate's predicate reads the same
 *    pipeline paths (SQL null semantics — `queryNodeToExpr`).
 *
 * All field paths are PHYSICAL document paths (`@db.column` renames), joined
 * tables live under `__joined_<table>`. A column whose source may be missing
 * (`nullable` mapping) reads as null; every other column is a plain path, so
 * a `$match` / `$sort` on the view can still push down to an index.
 * @since 0.1.136
 */
export function buildViewPipeline(view: AtscriptDbView): Document[] {
  const plan = view.viewPlan;
  const columns = view.getViewColumnMappings();
  const pipeline: Document[] = [];

  // Path prefix of each table's fields in the pipeline document: `""` for
  // the entry, `__joined_<table>.` once a join has run
  const prefixes = new Map<string, string>([[plan.entryTable, ""]]);
  const pathOf = (ref: AtscriptQueryFieldRef): string => {
    const { table, source } = view.resolveRefSource(ref);
    const prefix = prefixes.get(table);
    if (prefix === undefined) {
      throw new Error(`View "${view.tableName}": "${table}" is not joined before it is referenced`);
    }
    return prefix + source.column;
  };

  for (const join of plan.joins) {
    pipeline.push(buildLookup(view, join, prefixes));
    pipeline.push({
      $unwind: {
        path: `$${joinedAs(join.targetTable)}`,
        preserveNullAndEmptyArrays: join.kind === "left",
      },
    });
    prefixes.set(join.targetTable, `${joinedAs(join.targetTable)}.`);
  }

  // $match for view filter (query-operator semantics: `!=` also matches null / missing)
  if (plan.filter) {
    pipeline.push({ $match: viewMatch(plan.filter, pathOf) });
  }

  /** A column's source field as an aggregation operand. */
  const colSourceField = (col: TViewColumnMapping) =>
    `$${prefixes.get(col.sourceTable) ?? ""}${col.sourceColumn}`;
  // A source that may be missing (a left join, an optional field, a JSON
  // leaf) projects as null — like SQL, where every view column exists; as a
  // `$group` key it merges missing with null into ONE group.
  const colValue = (col: TViewColumnMapping): unknown =>
    col.nullable ? orNull(colSourceField(col)) : colSourceField(col);

  if (columns.some((c) => c.aggFn)) {
    // $group stage — dimension columns into _id, aggregates as accumulators
    const group: Record<string, unknown> = { _id: {} };
    const project: Record<string, unknown> = { _id: 0 };

    const distinctSizes: Record<string, unknown> = {};
    for (const col of columns) {
      if (col.aggFn) {
        const predicate = col.aggFilter
          ? queryNodeToExpr(col.aggFilter, (ref) => `$${pathOf(ref)}`)
          : undefined;
        // `'*'` is count's only (validated where the mapping is built)
        group[col.viewColumn] = buildAccumulator(
          col.aggFn,
          col.aggField === "*" ? "*" : colSourceField(col),
          predicate,
          col.viewColumn,
        );
        project[col.viewColumn] = `$${col.viewColumn}`;
        if (col.aggFn === "countDistinct") {
          distinctSizes[col.viewColumn] = distinctCountExpr(`$${col.viewColumn}`);
        }
      } else {
        (group._id as Record<string, unknown>)[col.viewColumn] = colValue(col);
        project[col.viewColumn] = `$_id.${col.viewColumn}`;
      }
    }

    pipeline.push({ $group: group });
    // countDistinct sets → their sizes, BEFORE the HAVING `$match` (which
    // would otherwise compare an array)
    if (Object.keys(distinctSizes).length > 0) {
      pipeline.push({ $addFields: distinctSizes });
    }

    // HAVING → $match (post-group filter): aggregates are top-level, dimensions under _id
    if (plan.having) {
      pipeline.push({ $match: havingMatch(plan.having, columns) });
    }

    pipeline.push({ $project: project });
  } else {
    const project: Record<string, unknown> = { _id: 0 };
    for (const col of columns) {
      project[col.viewColumn] = colValue(col);
    }
    pipeline.push({ $project: project });
  }

  return pipeline;
}

/**
 * One join's `$lookup`.
 *
 * The simple `localField` / `foreignField` form is used whenever it is exact:
 * a single `=` between a field of the joined table and a field of an outer
 * table (the entry or an earlier join), with the joined field REQUIRED — the
 * simple form matches a null / missing local value to null / missing foreign
 * values, which a required foreign field can never hold. It is kept (rather
 * than always using the pipeline form) because it can use an index on the
 * foreign field on every MongoDB version; the pipeline form's `$expr` match
 * can't before MongoDB 5.0. Everything else uses the pipeline form (`let` +
 * `$match: { $expr }`, SQL null semantics).
 */
function buildLookup(
  view: AtscriptDbView,
  join: TViewJoin,
  outer: ReadonlyMap<string, string>,
): Document {
  const as = joinedAs(join.targetTable);

  const simple = simpleJoinFields(view, join, outer);
  if (simple) {
    return { $lookup: { from: join.targetTable, ...simple, as } };
  }

  const letVars: Record<string, string> = {};
  const varByPath = new Map<string, string>();
  const pathOf = (ref: AtscriptQueryFieldRef): string => {
    const { table, source } = view.resolveRefSource(ref);
    if (table === join.targetTable) {
      return `$${source.column}`;
    }
    const prefix = outer.get(table);
    if (prefix === undefined) {
      throw new Error(
        `View "${view.tableName}": the join on "${join.targetTable}" references "${table}", which is not joined before it`,
      );
    }
    const outerPath = prefix + source.column;
    let varName = varByPath.get(outerPath);
    if (!varName) {
      varName = `v${varByPath.size}`;
      varByPath.set(outerPath, varName);
      letVars[varName] = `$${outerPath}`;
    }
    return `$$${varName}`;
  };

  const expr = queryNodeToExpr(join.condition, pathOf);
  return {
    $lookup: {
      from: join.targetTable,
      ...(varByPath.size > 0 ? { let: letVars } : {}),
      pipeline: [{ $match: { $expr: expr } }],
      as,
    },
  };
}

/** `{ localField, foreignField }` when the simple `$lookup` form is exact, else `undefined`. */
function simpleJoinFields(
  view: AtscriptDbView,
  join: TViewJoin,
  outer: ReadonlyMap<string, string>,
): { localField: string; foreignField: string } | undefined {
  let node = join.condition;
  if ("$and" in node) {
    const children = (node as { $and: AtscriptQueryNode[] }).$and;
    if (children.length !== 1) return undefined;
    node = children[0];
  }
  if ("$or" in node || "$not" in node || "$and" in node) return undefined;
  const comp = node as { left: AtscriptQueryFieldRef; op: string; right?: unknown };
  if (comp.op !== "$eq" || !isFieldRef(comp.right)) return undefined;

  const left = view.resolveRefSource(comp.left);
  const right = view.resolveRefSource(comp.right);
  let target: typeof left;
  let local: typeof left;
  if (left.table === join.targetTable && right.table !== join.targetTable) {
    target = left;
    local = right;
  } else if (right.table === join.targetTable && left.table !== join.targetTable) {
    target = right;
    local = left;
  } else {
    return undefined;
  }
  const localPrefix = outer.get(local.table);
  if (localPrefix === undefined) return undefined;

  const foreign = target.source;
  const foreignRequired =
    !foreign.optional && foreign.designType !== "union" && foreign.designType !== "unknown";
  if (!foreignRequired) return undefined;

  return { localField: localPrefix + local.source.column, foreignField: foreign.column };
}

/**
 * A view predicate (`@db.view.filter`, `@db.view.having`) as a `$match`
 * over pipeline paths: the shared query translation (`translateQueryTree` →
 * `buildMongoFilter`), so operators mean what they mean in queries (`exists`
 * = holds a value, `matches` takes `/re/flags`); a field-to-field comparison
 * becomes `$expr`.
 */
function viewMatch(node: AtscriptQueryNode, pathOf: (ref: AtscriptQueryFieldRef) => string) {
  return buildMongoFilter(translateQueryTree(node, pathOf), { fieldOperands: true });
}

/**
 * `@db.view.having` as a `$match` after `$group`: refs name view fields —
 * aggregates are top-level, dimensions under `_id`.
 */
function havingMatch(node: AtscriptQueryNode, columns: TViewColumnMapping[]): Document {
  const colMap = new Map(columns.map((c) => [c.viewPath, c]));
  return viewMatch(node, (ref) => {
    const col = ref.type ? undefined : colMap.get(ref.field);
    if (!col) return ref.field;
    return col.aggFn ? col.viewColumn : `_id.${col.viewColumn}`;
  });
}
