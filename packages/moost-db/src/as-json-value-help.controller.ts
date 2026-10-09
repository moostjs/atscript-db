import type { TAtscriptAnnotatedType, TAtscriptDataType } from "@atscript/typescript/utils";
import { buildMemoryPredicate, projectRow, sortRows } from "@atscript/db-memory";
import { Inherit, Moost } from "moost";

import { AsValueHelpController, type ValueHelpQuery } from "./as-value-help.controller";

/**
 * Concrete value-help controller backed by a static in-memory array. Provides
 * filter/sort/search/paginate over the provided rows, respecting the
 * `@ui.dict.*` capability annotations on the bound interface.
 *
 * Filter/sort/projection are delegated to the shared JS-native engine from
 * `@atscript/db-memory` (the same one every in-memory table uses) so a static
 * value-help source behaves identically to the SQL/Mongo adapters instead of
 * carrying a second, weaker implementation.
 *
 * **Semantics:**
 * - Filter is interpreted as a subset of MongoDB-style comparison operators
 *   (`$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$regex`,
 *   `$exists`) and logical combinators (`$and`, `$or`, `$not`). Field names may
 *   be dot-paths (`a.b.c`) that descend into nested objects. Any operator the
 *   engine does not implement raises `DbError('INVALID_QUERY')`, which the
 *   validation interceptor surfaces as HTTP 400 (it is NOT silently ignored).
 * - Null model is Mongo-like: `{ field: null }` / `$eq: null` matches an
 *   explicit `null` OR a missing field; `$ne: null` matches only a concrete,
 *   present, non-null value.
 * - `$regex` honours `/pattern/flags` literals, so `$regex: '/foo/i'` is a real
 *   case-insensitive match.
 * - Sort is stable, multi-key, lexicographic (insertion order preserved among
 *   ties). Direction via `-` prefix on the field name or `{ [field]: 'asc' |
 *   'desc' | 1 | -1 }`.
 * - Search is case-insensitive substring matching across every field listed in
 *   {@link searchableFields} that {@link hasField} keeps visible. This is
 *   value-help's own concern — the shared engine has no `$search`.
 * - Projection (`$select`) supports inclusion (`[fields]` / `{ f: 1 }`) and
 *   exclusion (`{ f: 0 }`) with dot-path nesting; the primary key is NOT auto-
 *   added (a value-help projection returns exactly the selected fields).
 *
 * **Constructor:**
 * ```ts
 * new AsJsonValueHelpController(StatusDict, [
 *   { id: 'active', label: 'Active' },
 *   { id: 'archived', label: 'Archived' },
 * ], app);
 * ```
 *
 * Register under a Moost path with `@Controller('/api/dicts/status')` or the
 * equivalent composition decorator.
 */
@Inherit()
export class AsJsonValueHelpController<
  T extends TAtscriptAnnotatedType = TAtscriptAnnotatedType,
  DataType = TAtscriptDataType<T>,
> extends AsValueHelpController<T, DataType> {
  protected rows: DataType[];

  private _pkIndex?: Map<string, DataType>;

  constructor(
    boundType: T,
    rows: DataType[],
    app: Moost,
    controllerName?: string,
    opts?: { canonical?: boolean },
  ) {
    const name =
      controllerName || (boundType.metadata.get("db.table") as string | undefined) || "value-help";
    super(boundType, name, app, opts);
    this.rows = rows;
    if (this.primaryKey) {
      const pk = this.primaryKey;
      const index = new Map<string, DataType>();
      for (const row of rows) {
        index.set(String((row as Record<string, unknown>)[pk]), row);
      }
      this._pkIndex = index;
    }
  }

  // ── Query implementation ──────────────────────────────────────────────

  protected async query(
    controls: ValueHelpQuery<DataType>,
  ): Promise<{ data: DataType[]; count: number }> {
    let rows: DataType[] = this.rows;

    // 1. $search — value-help's own case-insensitive substring match across the
    //    searchable fields (the shared engine has no `$search`). A field
    //    `hasField` hides never matches, so search can't probe its values.
    //    Runs before the filter (both keep order, so the result is the same)
    //    over all rows, where the lowercased values are cached by position.
    const search = controls.controls.$search as string | undefined;
    if (search) {
      const needle = search.toLowerCase();
      const columns = this.searchableFields
        .filter((field) => this.hasField(field))
        .map((field) => [field, this._lowercased(field)] as const);
      rows = rows.filter((row, i) => {
        for (const [field, column] of columns) {
          const v = (row as Record<string, unknown>)[field];
          if (typeof v !== "string") continue;
          let lower = column.lower[i];
          if (lower === undefined || column.src[i] !== v) {
            lower = v.toLowerCase();
            column.src[i] = v;
            column.lower[i] = lower;
          }
          if (lower.includes(needle)) return true;
        }
        return false;
      });
    }

    // 2. Filter — compile the FilterExpr into a predicate via the shared engine.
    //    Only build/apply when a filter is actually present (mirrors the old
    //    guard and keeps the no-filter path allocation-free).
    if (controls.filter && Object.keys(controls.filter).length > 0) {
      const predicate = buildMemoryPredicate(controls.filter);
      rows = rows.filter((row) => predicate(row as Record<string, unknown>));
    }

    // 3. Sort — normalize the flexible value-help `$sort` grammar to an ordered
    //    `{ field: 1 | -1 }` map, then hand comparison/ordering to the engine.
    const sort = this.normalizeSort(controls.controls.$sort);
    if (sort) {
      rows = sortRows(rows as Record<string, unknown>[], sort) as DataType[];
    }

    // 4. Paginate — total is the matched count BEFORE the window is applied.
    const total = rows.length;
    const skip = Math.max(0, Number(controls.controls.$skip ?? 0));
    const limit = Math.max(0, Number(controls.controls.$limit ?? total - skip));
    const page = rows.slice(skip, skip + limit);

    // 5. Project — normalize `$select` to a `{ path: 0 | 1 }` map and run each
    //    paged row through the engine (no PK auto-add, no deep clone).
    const projection = this.normalizeSelect(controls.controls.$select);
    const data = projection
      ? (page.map((row) =>
          projectRow(row as Record<string, unknown>, projection, { clone: false }),
        ) as DataType[])
      : page;

    return { data, count: total };
  }

  /**
   * `field`'s lowercased values by position in {@link rows} (the `$search`
   * haystack). An entry is used only while the row still holds the value it
   * was lowercased from (`src`), so rows edited in place stay correct.
   */
  private _lowercased(field: string): { src: unknown[]; lower: Array<string | undefined> } {
    let haystack = this._haystack;
    if (haystack?.rows !== this.rows) {
      haystack = this._haystack = { rows: this.rows, byField: new Map() };
    }
    let column = haystack.byField.get(field);
    if (!column) haystack.byField.set(field, (column = { src: [], lower: [] }));
    return column;
  }

  private _haystack?: {
    rows: readonly DataType[];
    byField: Map<string, { src: unknown[]; lower: Array<string | undefined> }>;
  };

  protected async getOne(id: string | number): Promise<DataType | null> {
    return this._pkIndex?.get(String(id)) ?? null;
  }

  // ── Control normalizers ────────────────────────────────────────────────

  /**
   * Ports the value-help `$sort` grammar to the shared engine's `{ field: 1 |
   * -1 }` shape (order-preserving for multi-key sorts). Accepts:
   * - a string `"field:asc,-other"` (comma-separated; `-` prefix or `:desc` → descending),
   * - an array of such strings / `{ field: dir }` objects,
   * - a `{ field: 'asc' | 'desc' | 1 | -1 }` object.
   * Returns `undefined` when nothing sortable was parsed (engine skips sorting).
   */
  private normalizeSort(sort: unknown): Partial<Record<string, 1 | -1>> | undefined {
    const out: Record<string, 1 | -1> = {};
    const push = (name: string, explicit?: 1 | -1) => {
      const clean = name.replace(/^[-+]/, "");
      const dir: 1 | -1 = explicit ?? (name.startsWith("-") ? -1 : 1);
      if (clean) out[clean] = dir;
    };
    if (typeof sort === "string") {
      for (const part of sort.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const [name, dir] = trimmed.split(":");
        push(name, dir === "desc" ? -1 : dir === "asc" ? 1 : undefined);
      }
    } else {
      // A top-level `{ field: dir }` object is treated as a one-element array so
      // the object-entry handling is written once (array and object forms share it).
      const entries = Array.isArray(sort) ? sort : sort && typeof sort === "object" ? [sort] : [];
      for (const entry of entries) {
        if (typeof entry === "string") {
          push(entry);
        } else if (entry && typeof entry === "object") {
          for (const [name, d] of Object.entries(entry)) {
            push(name, d === "desc" || d === -1 ? -1 : 1);
          }
        }
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
}
