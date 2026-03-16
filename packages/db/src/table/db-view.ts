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
import { AtscriptDbReadable } from "./db-readable";
import type { TViewPlan, TViewJoin } from "../query/query-tree";

export interface TViewColumnMapping {
  viewColumn: string;
  sourceTable: string;
  sourceColumn: string;
  /** Aggregate function name ('sum'|'avg'|'count'|'min'|'max') if this is an aggregate column. */
  aggFn?: string;
  /** Source field for the aggregate function ('*' for COUNT(*)). */
  aggField?: string;
}

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
  FlatType = FlatOf<T>,
  A extends BaseDbAdapter = BaseDbAdapter,
  IdType = PrimaryKeyOf<T>,
  OwnProps = OwnPropsOf<T>,
  NavType extends Record<string, unknown> = NavPropsOf<T>,
> extends AtscriptDbReadable<T, DataType, FlatType, A, IdType, OwnProps, NavType> {
  private _viewPlan?: TViewPlan;

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
    const entryTable =
      (entryTypeResolved?.metadata?.get("db.table") as string) || entryTypeResolved?.id || "";

    // Resolve joins from @db.view.joins (array of { target: AtscriptRef, condition: AtscriptQueryNode })
    const rawJoins = metadata.get("db.view.joins") as
      | Array<{ target: AtscriptRef; condition: AtscriptQueryNode }>
      | undefined;

    const joins: TViewJoin[] = [];
    if (rawJoins) {
      for (const join of rawJoins) {
        const targetRef = join.target;
        const targetType = typeof targetRef === "function" ? targetRef : targetRef.type;
        const targetTypeResolved = targetType();
        const targetTable =
          (targetTypeResolved?.metadata?.get("db.table") as string) || targetTypeResolved?.id || "";

        joins.push({
          targetType: targetType,
          targetTable,
          condition: join.condition,
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

  /**
   * Resolves a query field ref to a quoted `table.column` SQL fragment.
   *
   * @param ref - The field reference from the query tree.
   * @param qi - Identifier quoting function (e.g. backtick for MySQL, double-quote for SQLite).
   *             Defaults to double-quote wrapping for backwards compatibility.
   */
  resolveFieldRef(
    ref: AtscriptQueryFieldRef,
    qi: (name: string) => string = (n) => `"${n}"`,
  ): string {
    if (!ref.type) {
      // Unqualified — resolve against entry table
      const plan = this.viewPlan;
      return `${qi(plan.entryTable)}.${qi(ref.field)}`;
    }
    const resolved = ref.type();
    const table = (resolved?.metadata?.get("db.table") as string) || resolved?.id || "";
    return `${qi(table)}.${qi(ref.field)}`;
  }

  /**
   * Maps each view field to its source table and column via ref chain.
   * Fields without refs (inline definitions) map to the entry table with the same name.
   */
  getViewColumnMappings(): TViewColumnMapping[] {
    const plan = this.viewPlan;
    const mappings: TViewColumnMapping[] = [];

    if (this._type.type.kind !== "object") {
      return mappings;
    }

    const aggKeys = [
      "db.agg.sum",
      "db.agg.avg",
      "db.agg.count",
      "db.agg.min",
      "db.agg.max",
    ] as const;

    for (const [fieldName, fieldType] of this._type.type.props.entries()) {
      // Detect aggregate annotations on this field
      let aggFn: string | undefined;
      let aggField: string | undefined;
      for (const key of aggKeys) {
        const val = fieldType.metadata?.get(key as any);
        if (val !== undefined) {
          aggFn = key.split(".")[2]; // 'sum', 'avg', 'count', 'min', 'max'
          aggField = typeof val === "string" ? val : "*"; // COUNT(*) when val is true
          break;
        }
      }

      if (fieldType.ref) {
        const resolved = fieldType.ref.type();
        const sourceTable = (resolved?.metadata?.get("db.table") as string) || resolved?.id || "";
        const sourceColumn = fieldType.ref.field || fieldName;
        mappings.push({ viewColumn: fieldName, sourceTable, sourceColumn, aggFn, aggField });
      } else {
        // No ref — assume entry table, same column name
        const sourceColumn = aggField && aggField !== "*" ? aggField : fieldName;
        mappings.push({
          viewColumn: fieldName,
          sourceTable: plan.entryTable,
          sourceColumn,
          aggFn,
          aggField,
        });
      }
    }

    return mappings;
  }
}
