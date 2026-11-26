import path from "path";

import { prepareFixtures as prepare } from "@atscript/typescript/test-utils";
import dbPlugin from "../plugin";
import type { FilterExpr } from "@uniqu/core";

import { BaseDbAdapter } from "../base-adapter";
import type {
  DbQuery,
  TDbFieldMeta,
  TResolvedWith,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbUpdateOptions,
  TDbDeleteResult,
} from "../types";

// ── Shared mock adapter (no native FK support) ──────────────────────────────

export class MockAdapter extends BaseDbAdapter {
  public calls: Array<{ method: string; args: any[] }> = [];
  public store = new Map<string, Array<Record<string, unknown>>>();

  protected record(method: string, ...args: any[]) {
    this.calls.push({ method, args });
  }

  protected _rows(): Array<Record<string, unknown>> {
    const name = this._table?.tableName ?? "";
    if (!this.store.has(name)) {
      this.store.set(name, []);
    }
    return this.store.get(name)!;
  }

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    this.record("insertOne", data);
    this._rows().push({ ...data });
    return { insertedId: data.id ?? data._id ?? 1 };
  }

  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    this.record("insertMany", data);
    for (const row of data) {
      this._rows().push({ ...row });
    }
    return { insertedCount: data.length, insertedIds: data.map((d) => d.id ?? d._id ?? 1) };
  }

  async replaceOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    this.record("replaceOne", filter, data);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: any,
    expectedVersion?: number,
    opts?: TDbUpdateOptions,
  ): Promise<TDbUpdateResult> {
    this.record("updateOne", filter, data, ops, expectedVersion, opts);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    this.record("deleteOne", filter);
    const rows = this._rows();
    const before = rows.length;
    const remaining = rows.filter((r) => !matchesFilter(r, filter));
    this.store.set(this._table.tableName, remaining);
    return { deletedCount: before - remaining.length };
  }

  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    this.record("findOne", query);
    return this._rows().find((r) => matchesFilter(r, query.filter)) ?? null;
  }

  async findMany(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    this.record("findMany", query);
    return this._rows().filter((r) => matchesFilter(r, query.filter));
  }

  async count(query: DbQuery): Promise<number> {
    this.record("count", query);
    return this._rows().filter((r) => matchesFilter(r, query.filter)).length;
  }

  async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: any,
    opts?: TDbUpdateOptions,
  ): Promise<TDbUpdateResult> {
    this.record("updateMany", filter, data, ops, opts);
    return updateRowsWhere(this._rows(), filter, data);
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    this.record("replaceMany", filter, data);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    this.record("deleteMany", filter);
    const rows = this._rows();
    const before = rows.length;
    const remaining = rows.filter((r) => !matchesFilter(r, filter));
    this.store.set(this._table.tableName, remaining);
    return { deletedCount: before - remaining.length };
  }

  public aggregateResult: Array<Record<string, unknown>> = [];

  async aggregate(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    this.record("aggregate", query);
    return this.aggregateResult;
  }

  async syncIndexes(): Promise<void> {}
  async ensureTable(): Promise<void> {}
}

/** Document-style mock: nested objects kept inline (no flattening, no physical-name mapping). */
export class NestedMockAdapter extends MockAdapter {
  override supportsNestedObjects(): boolean {
    return true;
  }
}

/** A mock that honours `$sort` / `$limit` on reads, like a real engine. */
export class OrderedMockAdapter extends MockAdapter {
  override async findMany(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    let rows = await super.findMany(query);
    const sort = query.controls?.$sort as Record<string, 1 | -1> | undefined;
    if (sort) {
      rows = rows.toSorted((a, b) => {
        for (const [k, dir] of Object.entries(sort)) {
          if (a[k] === b[k]) continue;
          return (a[k] as number) < (b[k] as number) ? -dir : dir;
        }
        return 0;
      });
    }
    const limit = query.controls?.$limit as number | undefined;
    return limit === undefined ? rows : rows.slice(0, limit);
  }
}

type TRow = Record<string, unknown>;

/**
 * An adapter that reads `$with` relations inside the read
 * (`supportsWithInRead()`), like a remote service returning the related rows
 * in the same response. It applies each entry's filter, `$sort`, `$select`
 * and nested entries as given, and correlates rows with
 * `links["<table>.<nav>"](parent, child)` (physical rows) — the core hands it
 * no join keys. Booleans are stored as `1` / `0` (`formatValue`).
 */
export class InReadMockAdapter extends MockAdapter {
  /** The `$with` entries each read received (root reads and nested levels alike). */
  public entries: TResolvedWith[][] = [];
  /** Relations this adapter leaves out of its rows (a defective adapter). */
  public omit = new Set<string>();

  constructor(public links: Record<string, (parent: TRow, child: TRow) => boolean> = {}) {
    super();
  }

  override supportsWithInRead(): boolean {
    return true;
  }

  formatValue(fd: TDbFieldMeta) {
    if (fd.designType !== "boolean") return undefined;
    return {
      toStorage: (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v),
      fromStorage: (v: unknown) => v === 1,
    };
  }

  override async findOne(query: DbQuery): Promise<TRow | null> {
    return (await this.findMany(query))[0] ?? null;
  }

  override async findMany(query: DbQuery): Promise<TRow[]> {
    this.record("findMany", query);
    return (await this.readRows(query)).map((row) => project(row, query));
  }

  /** Matching rows (copies) with their relations attached, not yet projected. */
  async readRows(query: DbQuery): Promise<TRow[]> {
    const rows = this._rows()
      .filter((r) => matchesFilter(r, query.filter))
      .map((r) => ({ ...r }));
    const sort = query.controls?.$sort as Record<string, 1 | -1> | undefined;
    if (sort) {
      rows.sort((a, b) => {
        for (const [k, dir] of Object.entries(sort)) {
          if (a[k] !== b[k]) return (a[k] as number) < (b[k] as number) ? -dir : dir;
        }
        return 0;
      });
    }
    const entries = query.controls?.$with;
    if (!entries) return rows;
    this.entries.push(entries);
    for (const entry of entries) {
      const target = entry.target.adapter as InReadMockAdapter;
      const related = await target.readRows(entry.query);
      const link = this.links[`${this._table.tableName}.${entry.nav}`]!;
      for (const row of rows) {
        if (this.omit.has(entry.nav)) continue;
        const mine = related
          .filter((child) => link(row, child))
          .map((child) => project(child, entry.query));
        row[entry.nav] = entry.isArray ? mine : (mine[0] ?? null);
      }
    }
    return rows;
  }
}

/** `row` with the fields of `query`'s `$select` (and its relations) only. */
function project(row: TRow, query: DbQuery): TRow {
  const fields = query.controls?.$select?.asArray;
  if (!fields) return row;
  const out: TRow = {};
  for (const key of [...fields, ...(query.controls.$with ?? []).map((e) => e.nav)]) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

/**
 * Simple filter matching for tests — supports exact match (`null` matches a
 * missing value), $in, $eq, $lt, $and and $or.
 */
export function matchesFilter(row: Record<string, unknown>, filter: FilterExpr): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$or" || key === "$and") {
      const clauses = value as Array<Record<string, unknown>>;
      const test = (clause: Record<string, unknown>) => matchesFilter(row, clause);
      if (!(key === "$or" ? clauses.some(test) : clauses.every(test))) {
        return false;
      }
      continue;
    }
    const ops = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    if (ops && "$in" in ops) {
      const inValues = ops.$in as unknown[];
      if (!inValues.includes(row[key])) {
        return false;
      }
    } else if (ops && "$eq" in ops) {
      if (row[key] !== ops.$eq) {
        return false;
      }
    } else if (ops && "$lt" in ops) {
      if (!((row[key] as number) < (ops.$lt as number))) {
        return false;
      }
    } else if ((row[key] ?? null) !== (value ?? null)) {
      return false;
    }
  }
  return true;
}

/** `updateMany` over an in-memory row array (in place): merges `data` into every match. */
export function updateRowsWhere(
  rows: Array<Record<string, unknown>>,
  filter: FilterExpr,
  data: Record<string, unknown>,
): TDbUpdateResult {
  let matched = 0;
  for (const row of rows) {
    if (matchesFilter(row, filter)) {
      Object.assign(row, data);
      matched++;
    }
  }
  return { matchedCount: matched, modifiedCount: matched };
}

/** `deleteMany` over an in-memory row array (in place, keeping the array's identity). */
export function deleteRowsWhere(
  rows: Array<Record<string, unknown>>,
  filter: FilterExpr,
): TDbDeleteResult {
  let deleted = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (matchesFilter(rows[i]!, filter)) {
      rows.splice(i, 1);
      deleted++;
    }
  }
  return { deletedCount: deleted };
}

// ── Fixture preparation ─────────────────────────────────────────────────────

export async function prepareFixtures() {
  const fixturesDir = path.join(path.dirname(import.meta.url.slice(7)), "fixtures");
  await prepare({
    rootDir: fixturesDir,
    plugins: [dbPlugin()],
  });
}
