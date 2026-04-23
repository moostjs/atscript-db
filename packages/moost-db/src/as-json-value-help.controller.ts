import type { TAtscriptAnnotatedType, TAtscriptDataType } from "@atscript/typescript/utils";
import type { FilterExpr } from "@atscript/db";
import { Inherit, Moost } from "moost";

import { AsValueHelpController, type ValueHelpQuery } from "./as-value-help.controller";

/**
 * Concrete value-help controller backed by a static in-memory array. Provides
 * filter/sort/search/paginate over the provided rows, respecting the
 * `@ui.dict.*` capability annotations on the bound interface.
 *
 * **Semantics:**
 * - Filter is interpreted as a subset of MongoDB-style comparison operators
 *   (`$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$regex`) and
 *   logical combinators (`$and`, `$or`, `$not`, `$nor`). Unknown operators
 *   fall through to strict equality.
 * - Sort is stable, multi-key, lexicographic. Direction via `-` prefix on the
 *   field name or `{ [field]: 'asc' | 'desc' }`.
 * - Search is case-insensitive substring matching across every field listed in
 *   {@link searchableFields}.
 * - Type coercion: comparisons compare raw JS values (no implicit string-to-
 *   number coercion); strings are compared case-insensitively only for
 *   `$search`, not for filter operators.
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

  constructor(boundType: T, rows: DataType[], app: Moost, controllerName?: string) {
    const name =
      controllerName || (boundType.metadata.get("db.table") as string | undefined) || "value-help";
    super(boundType, name, app);
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

    if (controls.filter && Object.keys(controls.filter).length > 0) {
      rows = rows.filter((row) => matchFilter(row, controls.filter));
    }

    const search = controls.controls.$search as string | undefined;
    if (search) {
      const needle = search.toLowerCase();
      const fields = this.searchableFields;
      rows = rows.filter((row) => {
        for (const field of fields) {
          const v = (row as Record<string, unknown>)[field];
          if (typeof v === "string" && v.toLowerCase().includes(needle)) {
            return true;
          }
        }
        return false;
      });
    }

    if (controls.controls.$sort) {
      rows = sortRows(rows, controls.controls.$sort);
    }

    const total = rows.length;
    const skip = Math.max(0, Number(controls.controls.$skip ?? 0));
    const limit = Math.max(0, Number(controls.controls.$limit ?? total - skip));
    const page = rows.slice(skip, skip + limit);

    const data = applySelect(page, controls.controls.$select as string[] | undefined);

    return { data, count: total };
  }

  protected async getOne(id: string | number): Promise<DataType | null> {
    return this._pkIndex?.get(String(id)) ?? null;
  }
}

// ── Helpers (filter / sort / projection) ────────────────────────────────

function matchFilter(row: unknown, filter: FilterExpr): boolean {
  if (!filter || typeof filter !== "object") {
    return true;
  }
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and") {
      if (!Array.isArray(value)) continue;
      if (!value.every((clause) => matchFilter(row, clause as FilterExpr))) return false;
      continue;
    }
    if (key === "$or") {
      if (!Array.isArray(value)) continue;
      if (!value.some((clause) => matchFilter(row, clause as FilterExpr))) return false;
      continue;
    }
    if (key === "$nor") {
      if (!Array.isArray(value)) continue;
      if (value.some((clause) => matchFilter(row, clause as FilterExpr))) return false;
      continue;
    }
    if (key === "$not") {
      if (matchFilter(row, value as FilterExpr)) return false;
      continue;
    }
    if (key.startsWith("$")) {
      // Unknown top-level control operator — skip.
      continue;
    }
    const fieldValue = (row as Record<string, unknown>)[key];
    if (!matchFieldPredicate(fieldValue, value)) {
      return false;
    }
  }
  return true;
}

function matchFieldPredicate(fieldValue: unknown, predicate: unknown): boolean {
  if (predicate === null || typeof predicate !== "object" || Array.isArray(predicate)) {
    return fieldValue === predicate;
  }
  for (const [op, operand] of Object.entries(predicate as Record<string, unknown>)) {
    switch (op) {
      case "$eq":
        if (fieldValue !== operand) return false;
        break;
      case "$ne":
        if (fieldValue === operand) return false;
        break;
      case "$in":
        if (!Array.isArray(operand) || !operand.includes(fieldValue as never)) return false;
        break;
      case "$nin":
        if (!Array.isArray(operand) || operand.includes(fieldValue as never)) return false;
        break;
      case "$gt":
        if (!((fieldValue as never) > (operand as never))) return false;
        break;
      case "$gte":
        if (!((fieldValue as never) >= (operand as never))) return false;
        break;
      case "$lt":
        if (!((fieldValue as never) < (operand as never))) return false;
        break;
      case "$lte":
        if (!((fieldValue as never) <= (operand as never))) return false;
        break;
      case "$regex": {
        const re = operand instanceof RegExp ? operand : new RegExp(String(operand));
        if (typeof fieldValue !== "string" || !re.test(fieldValue)) return false;
        break;
      }
      default:
        if (fieldValue !== operand) return false;
    }
  }
  return true;
}

function sortRows<T>(rows: T[], sort: unknown): T[] {
  const keys: Array<{ name: string; dir: 1 | -1 }> = [];
  const push = (name: string, explicit?: 1 | -1) => {
    const clean = name.replace(/^[-+]/, "");
    const dir: 1 | -1 = explicit ?? (name.startsWith("-") ? -1 : 1);
    if (clean) keys.push({ name: clean, dir });
  };
  if (typeof sort === "string") {
    for (const part of sort.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [name, dir] = trimmed.split(":");
      push(name, dir === "desc" ? -1 : dir === "asc" ? 1 : undefined);
    }
  } else if (Array.isArray(sort)) {
    for (const entry of sort) {
      if (typeof entry === "string") {
        push(entry);
      } else if (entry && typeof entry === "object") {
        for (const [name, d] of Object.entries(entry)) {
          push(name, d === "desc" || d === -1 ? -1 : 1);
        }
      }
    }
  } else if (sort && typeof sort === "object") {
    for (const [name, d] of Object.entries(sort as Record<string, unknown>)) {
      push(name, d === "desc" || d === -1 ? -1 : 1);
    }
  }
  if (keys.length === 0) return rows;

  // Array.prototype.sort is stable in ES2019+ — cloning once to preserve the input.
  const out = rows.slice();
  out.sort((a, b) => {
    for (const { name, dir } of keys) {
      const av = (a as Record<string, unknown>)[name];
      const bv = (b as Record<string, unknown>)[name];
      if (av === bv) continue;
      if (av === undefined || av === null) return -1 * dir;
      if (bv === undefined || bv === null) return 1 * dir;
      if ((av as never) < (bv as never)) return -1 * dir;
      if ((av as never) > (bv as never)) return 1 * dir;
    }
    return 0;
  });
  return out;
}

function applySelect<T>(rows: T[], select?: string[]): T[] {
  if (!select?.length) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of select) {
      out[key] = (row as Record<string, unknown>)[key];
    }
    return out as T;
  });
}
