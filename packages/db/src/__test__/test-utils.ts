import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import { build } from "@atscript/core";
import { tsPlugin as ts } from "@atscript/typescript";
import dbPlugin from "../plugin";
import type { FilterExpr } from "@uniqu/core";

import { BaseDbAdapter } from "../base-adapter";
import type {
  DbQuery,
  TDbInsertResult,
  TDbInsertManyResult,
  TDbUpdateResult,
  TDbDeleteResult,
} from "../types";

// ── Shared mock adapter (no native FK support) ──────────────────────────────

export class MockAdapter extends BaseDbAdapter {
  public calls: Array<{ method: string; args: any[] }> = [];
  public store = new Map<string, Array<Record<string, unknown>>>();

  private record(method: string, ...args: any[]) {
    this.calls.push({ method, args });
  }

  private _rows(): Array<Record<string, unknown>> {
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

  async updateOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    this.record("updateOne", filter, data);
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

  async updateMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    this.record("updateMany", filter, data);
    let modified = 0;
    for (const row of this._rows()) {
      if (matchesFilter(row, filter)) {
        Object.assign(row, data);
        modified++;
      }
    }
    return { matchedCount: modified, modifiedCount: modified };
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

/** Simple filter matching for tests — supports exact match, $in, and $or */
export function matchesFilter(row: Record<string, unknown>, filter: FilterExpr): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$or") {
      const clauses = value as Array<Record<string, unknown>>;
      if (!clauses.some((clause) => matchesFilter(row, clause))) {
        return false;
      }
      continue;
    }
    if (value && typeof value === "object" && "$in" in (value as Record<string, unknown>)) {
      const inValues = (value as Record<string, unknown>).$in as unknown[];
      if (!inValues.includes(row[key])) {
        return false;
      }
    } else if (row[key] !== value) {
      return false;
    }
  }
  return true;
}

// ── Fixture preparation ─────────────────────────────────────────────────────

export async function prepareFixtures() {
  const wd = path.join(path.dirname(import.meta.url.slice(7)), "fixtures");
  const repo = await build({
    rootDir: wd,
    include: ["**/*.as"],
    plugins: [ts(), dbPlugin()],
  });
  const out = await repo.generate({
    outDir: ".",
    format: "js",
  });
  const outDts = await repo.generate({
    outDir: ".",
    format: "dts",
  });
  for (const file of [...out, ...outDts]) {
    if (existsSync(file.target)) {
      const content = readFileSync(file.target).toString();
      if (content !== file.content) {
        writeFileSync(file.target, file.content);
      }
    } else {
      writeFileSync(file.target, file.content);
    }
  }
}
