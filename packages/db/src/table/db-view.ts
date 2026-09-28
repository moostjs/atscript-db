import type {
  FlatOf,
  PrimaryKeyOf,
  OwnPropsOf,
  NavPropsOf,
  TAtscriptAnnotatedType,
  TAtscriptDataType,
  AtscriptRef,
  AtscriptQueryNode,
  AtscriptQueryFieldRef,
} from "@atscript/typescript/utils";

import type { BaseDbAdapter } from "../base-adapter";
import type { NullableOptional } from "../types";
import { AtscriptDbReadable } from "./db-readable";
import type { TViewPlan, TViewJoin } from "../query/query-tree";
import { SUPPORTED_AGGREGATE_FNS, type TDbAggregateFn } from "../query/aggregate-fns";
import { tableNameOf } from "../rel/relation-helpers";
import { resolveViewSource, type TViewSource } from "./view-source";

/** Primitive result type of a JSON-leaf extraction. */
export type TViewJsonType = "string" | "number" | "boolean";

export interface TViewColumnMapping {
  /**
   * The view's own physical column — its `@db.column` / flattened `__` name
   * on relational adapters, its document key on nested-object adapters.
   */
  viewColumn: string;
  /**
   * Logical view field path (`address.city` for a flattened object leaf) —
   * how `@db.view.having` refers to the column.
   * @since 0.1.136
   */
  viewPath: string;
  sourceTable: string;
  /** Physical source column (or document path). `"*"` for `COUNT(*)`. */
  sourceColumn: string;
  /**
   * Set when the source value may be missing for some row: an optional
   * source field, a leaf inside a JSON-stored value, an undeclared path, or a
   * column of a left-joined table. Document adapters coalesce such a source
   * to `null`; a required source is read as a plain path (index-friendly).
   * @since 0.1.136
   */
  nullable?: true;
  /**
   * Set when the source is a primitive leaf inside a JSON column
   * ({@link sourceColumn}): the path within it and the leaf's declared type.
   * @since 0.1.136
   */
  json?: { path: string[]; type: TViewJsonType };
  /**
   * Aggregate function name (`sum` | `avg` | `count` | `countDistinct` |
   * `min` | `max`) if this is an aggregate column.
   */
  aggFn?: string;
  /** Source field for the aggregate function ('*' for COUNT(*)). */
  aggField?: string;
  /**
   * Row predicate of a conditional aggregate — the `@db.agg.*` 2nd argument:
   * only rows where it holds are aggregated. Refs resolve like
   * `@db.view.filter` (entry table + joins). @since 0.1.136
   */
  aggFilter?: AtscriptQueryNode;
}

/** The `@db.agg.*` annotations, one per supported aggregate function. */
const AGG_KEYS = SUPPORTED_AGGREGATE_FNS.map((fn) => `db.agg.${fn}` as const);

/** An aggregate column's function, source field and (conditional) row predicate. */
interface TViewAgg {
  aggFn: TDbAggregateFn;
  aggField: string;
  aggFilter?: AtscriptQueryNode;
}

/**
 * Reads a view field's `@db.agg.*` annotation. The compiled value is
 * `{ field?, condition? }`; models compiled by older versions carry `true`
 * (bare `@db.agg.count`) or a string (the field), which are read the same way.
 * A missing field or `true` is `'*'` (COUNT(*)).
 */
function readViewAgg(
  metadata: TAtscriptAnnotatedType["metadata"] | undefined,
): TViewAgg | undefined {
  for (const key of AGG_KEYS) {
    const val = metadata?.get(key as any) as
      | true
      | string
      | { field?: string; condition?: AtscriptQueryNode }
      | undefined;
    if (val === undefined) continue;
    const aggFn = key.slice("db.agg.".length) as TDbAggregateFn;
    if (typeof val === "string") return { aggFn, aggField: val };
    if (val === null || typeof val !== "object") return { aggFn, aggField: "*" };
    return {
      aggFn,
      aggField: val.field ?? "*",
      ...(val.condition ? { aggFilter: val.condition } : {}),
    };
  }
  return undefined;
}

const JSON_LEAF_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean"]);

/**
 * Database view abstraction driven by Atscript `@db.view.*` annotations.
 *
 * Extends {@link AtscriptDbReadable} with view plan resolution — entry table,
 * joins, filter, and materialization flag. Read operations are inherited;
 * write operations are not available on views.
 *
 * ```typescript
 * const adapter = new SqliteAdapter(db)
 * const activeUsers = new AtscriptDbView(ActiveUsersType, adapter)
 * const users = await activeUsers.findMany({ filter: {}, controls: {} })
 * ```
 */
export class AtscriptDbView<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
  // Optional columns read back / filter as `null` too (since 0.1.128).
  FlatType = NullableOptional<FlatOf<T>>,
  A extends BaseDbAdapter = BaseDbAdapter,
  IdType = PrimaryKeyOf<T>,
  OwnProps = NullableOptional<OwnPropsOf<T>>,
  NavType extends Record<string, unknown> = NavPropsOf<T>,
> extends AtscriptDbReadable<T, DataType, FlatType, A, IdType, OwnProps, NavType> {
  private _viewPlan?: TViewPlan;
  private _columnMappings?: TViewColumnMapping[];

  override get isView(): boolean {
    return true;
  }

  /**
   * Whether this is an external view — declared with `@db.view` only,
   * without `@db.view.for`. External views reference pre-existing DB views
   * and are not managed (created/dropped) by schema sync.
   */
  get isExternal(): boolean {
    return !this._type.metadata.has("db.view.for");
  }

  /**
   * Lazily resolves the view plan from `@db.view.*` metadata.
   *
   * - `db.view.for` → entry type ref (required)
   * - `db.view.joins` → array of `{ target, condition }` (optional, multiple)
   * - `db.view.filter` → query tree (optional)
   * - `db.view.materialized` → boolean (optional)
   */
  get viewPlan(): TViewPlan {
    if (this._viewPlan) {
      return this._viewPlan;
    }

    if (this.isExternal) {
      throw new Error(
        `Cannot compute view plan for external view "${this.tableName}". ` +
          `External views (declared without @db.view.for) reference pre-existing DB views.`,
      );
    }

    const metadata = this._type.metadata;

    // Resolve entry type from @db.view.for (AtscriptRef)
    const forRef = metadata.get("db.view.for") as AtscriptRef;
    const entryType = typeof forRef === "function" ? forRef : forRef.type;
    const entryTypeResolved = entryType();
    const entryTable = tableNameOf(entryTypeResolved);

    // Resolve joins from @db.view.joins (array of { target: AtscriptRef, condition: AtscriptQueryNode })
    const rawJoins = metadata.get("db.view.joins") as
      | Array<{ target: AtscriptRef; condition: AtscriptQueryNode; kind?: "inner" | "left" }>
      | undefined;

    const joins: TViewJoin[] = [];
    if (rawJoins) {
      for (const join of rawJoins) {
        const targetRef = join.target;
        const targetType = typeof targetRef === "function" ? targetRef : targetRef.type;
        const targetTypeResolved = targetType();
        joins.push({
          targetType: targetType,
          targetTable: tableNameOf(targetTypeResolved),
          condition: join.condition,
          kind: join.kind === "left" ? "left" : "inner",
        });
      }
    }

    // Resolve filter from @db.view.filter
    const filter = metadata.get("db.view.filter") as AtscriptQueryNode | undefined;

    // Resolve having from @db.view.having
    const having = metadata.get("db.view.having") as AtscriptQueryNode | undefined;

    // Resolve materialized flag
    const materialized = metadata.has("db.view.materialized");

    this._viewPlan = {
      entryType,
      entryTable,
      joins,
      filter,
      having,
      materialized,
    };

    return this._viewPlan;
  }

  /** Whether the adapter stores nested objects natively (document paths, no JSON columns). */
  private get _nested(): boolean {
    return this.adapter.supportsNestedObjects();
  }

  /**
   * Resolves a view query field ref (join condition, `@db.view.filter`,
   * conditional-aggregate predicate) to its table name and PHYSICAL source on
   * this view's adapter — the column (or document path) with `TableMetadata`'s
   * layout rules, the path inside a JSON column, and whether the value may be
   * absent. An unqualified ref resolves against the entry table.
   * @throws for a ref without storage (`@db.ignore`, navigation relation) or
   *   inside an `@db.encrypted` field (relational adapters).
   * @since 0.1.136
   */
  resolveRefSource(ref: AtscriptQueryFieldRef): { table: string; source: TViewSource } {
    const type = ref.type ? ref.type() : this.viewPlan.entryType();
    return {
      table: tableNameOf(type),
      source: resolveViewSource(type, ref.field, this._nested),
    };
  }

  /**
   * Resolves a query field ref (join condition, `@db.view.filter`) to a
   * quoted `table.column` SQL fragment — the PHYSICAL column (flattened
   * `__` name, `@db.column` rename). An unqualified ref
   * resolves against the entry table.
   *
   * @param ref - The field reference from the query tree.
   * @param qi - Identifier quoting function (e.g. backtick for MySQL, double-quote for SQLite).
   *             Defaults to double-quote wrapping for backwards compatibility.
   * @throws when the ref reads inside a JSON column (not supported in view conditions).
   */
  resolveFieldRef(
    ref: AtscriptQueryFieldRef,
    qi: (name: string) => string = (n) => `"${n}"`,
  ): string {
    const { table, source } = this.resolveRefSource(ref);
    if (source.jsonPath) {
      throw new Error(
        `View "${this.tableName}": "${ref.field}" reads inside a JSON column — JSON paths are not supported in view conditions`,
      );
    }
    return `${qi(table)}.${qi(source.column)}`;
  }

  /**
   * Maps each view column to its source table and PHYSICAL source column.
   *
   * View fields resolve through their chain ref; fields without a ref read
   * the entry table under the same name; aggregates read their `@db.agg.*`
   * field from the entry table (or their ref). Source names are
   * physical (flattened `__` names, `@db.column`, document paths), `viewColumn`
   * is the view's own physical name, an object field whose source is a
   * flattened object expands to one mapping per leaf, and a primitive leaf
   * inside a JSON column carries `json` (rendered by adapters that support
   * JSON extraction).
   *
   * Computed once per view (the plan and the type are immutable).
   *
   * @throws for an object field over a JSON column without `@db.json` on the
   *   view field, a JSON leaf that is not a string / number / boolean, or an
   *   aggregate other than `count` over `'*'`.
   */
  getViewColumnMappings(): TViewColumnMapping[] {
    this._columnMappings ??= this._buildColumnMappings();
    return this._columnMappings;
  }

  private _buildColumnMappings(): TViewColumnMapping[] {
    const plan = this.viewPlan;
    const mappings: TViewColumnMapping[] = [];

    if (this._type.type.kind !== "object") {
      return mappings;
    }

    // `@db.ignore` fields exist on the type but have no column anywhere —
    // the same source of truth tables use (snapshot, column diff, DDL).
    // Iteration stays over `props`: view fields are top-level chain refs.
    const ignored = this.ignoredFields;
    const meta = this.getMetadata();
    const nested = this._nested;
    const viewName = (path: string): string | undefined =>
      nested ? meta.physicalPath(path) : meta.pathToPhysical.get(path);
    const fail = (field: string, message: string): never => {
      throw new Error(`View "${this.tableName}" field "${field}": ${message}`);
    };
    const leftJoined = new Set(
      plan.joins.filter((j) => j.kind === "left").map((j) => j.targetTable),
    );

    for (const [fieldName, fieldType] of this._type.type.props.entries()) {
      if (ignored.has(fieldName)) {
        continue;
      }
      // Aggregate annotation on this field (function, source field, condition)
      const agg = readViewAgg(fieldType.metadata);
      const aggField = agg?.aggField;
      // The one runtime check of the aggregate rules (the compiler reports
      // them too) — renderers rely on it.
      if (aggField === "*" && agg?.aggFn !== "count") {
        fail(fieldName, `aggregate "${agg?.aggFn}" needs a field — only count accepts *`);
      }

      // Source: the chain ref, else the aggregate's field, else the same name on the entry table
      let sourceType: TAtscriptAnnotatedType;
      let sourcePath: string;
      if (fieldType.ref) {
        sourceType = fieldType.ref.type();
        sourcePath = fieldType.ref.field || fieldName;
      } else {
        sourceType = plan.entryType();
        sourcePath = aggField && aggField !== "*" ? aggField : fieldName;
      }
      const sourceTable = tableNameOf(sourceType);
      const joinNullable = leftJoined.has(sourceTable);

      if (aggField === "*" && !fieldType.ref) {
        mappings.push({
          viewColumn: viewName(fieldName) ?? fieldName,
          viewPath: fieldName,
          sourceTable,
          sourceColumn: "*",
          ...agg,
        });
        continue;
      }

      const source = resolveViewSource(sourceType, sourcePath, nested);
      const ownColumn = viewName(fieldName);

      if (ownColumn === undefined && !nested) {
        // The view flattened this object field into one column per leaf.
        if (!source.flattened) {
          fail(fieldName, "source is a JSON column — add @db.json to the view field");
        }
        const prefix = `${fieldName}.`;
        for (const [viewPath, viewColumn] of meta.pathToPhysical) {
          if (!viewPath.startsWith(prefix) || ignored.has(viewPath)) continue;
          const leafPath = `${sourcePath}.${viewPath.slice(prefix.length)}`;
          const leaf = resolveViewSource(sourceType, leafPath, nested);
          mappings.push(this._leafMapping(viewPath, viewColumn, sourceTable, leaf, joinNullable));
        }
        continue;
      }

      if (source.flattened) {
        fail(fieldName, "source is a flattened object — remove @db.json from the view field");
      }
      const mapping = this._leafMapping(
        fieldName,
        ownColumn ?? fieldName,
        sourceTable,
        source,
        joinNullable,
      );
      mappings.push(agg ? { ...mapping, ...agg } : mapping);
    }

    return mappings;
  }

  /** One view column over one physical source (a column or a JSON leaf). */
  private _leafMapping(
    viewPath: string,
    viewColumn: string,
    sourceTable: string,
    source: TViewSource,
    joinNullable: boolean,
  ): TViewColumnMapping {
    const mapping: TViewColumnMapping = {
      viewColumn,
      viewPath,
      sourceTable,
      sourceColumn: source.column,
    };
    if (joinNullable || source.optional || source.designType === "unknown") {
      mapping.nullable = true;
    }
    if (source.jsonPath) {
      if (!JSON_LEAF_TYPES.has(source.designType)) {
        throw new Error(
          `View "${this.tableName}" field "${viewPath}": JSON extraction supports string, number and boolean leaves only`,
        );
      }
      mapping.json = { path: source.jsonPath, type: source.designType as TViewJsonType };
    }
    return mapping;
  }
}

/**
 * Structural type guard for views: `true` when the readable reports
 * `isView`, whether or not it is an `AtscriptDbView` instance of THIS copy
 * of `@atscript/db`. Adapters must use this (or `readable.isView`) instead of
 * `instanceof AtscriptDbView` — in a bundle that carries two copies of the
 * core (app bundle + external adapter), `instanceof` is false and the adapter
 * would create an empty physical table under the view's name.
 * @since 0.1.128
 */
export function isAtscriptDbView(
  readable: AtscriptDbReadable<any, any, any, any, any, any, any>,
): readable is AtscriptDbView<any, any, any, any, any, any, any> {
  return readable.isView;
}
