import { describe, it, expect, beforeAll } from "vite-plus/test";

import { BaseDbAdapter, DbSpace } from "../index";
import { SchemaSync, planSchema, type SyncEntry } from "../sync";
import type {
  DbQuery,
  FilterExpr,
  TColumnDiff,
  TDbDeleteResult,
  TDbFieldMeta,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbUpdateResult,
  TExistingColumn,
  TSyncColumnResult,
} from "../types";

import { deleteRowsWhere, prepareFixtures, updateRowsWhere } from "./test-utils";

// Schema sync of `@db.column.derived` columns (since 0.1.141): add-later,
// expression / type / kind changes as drop + add (indexes dropped first),
// rename, removal, safe mode (skipped + hash withheld), and document
// adapters (snapshot diff) never touching a derived field.

let fx: Record<string, any>;

// ── One in-memory "database" shared by every adapter of a space ──────────

let ddl: string[] = [];
let columns = new Map<string, TExistingColumn[]>();
let rows = new Map<string, Array<Record<string, unknown>>>();
let created = new Set<string>();

/** A relational-style adapter that introspects columns and records DDL. */
class SqlishAdapter extends BaseDbAdapter {
  private _rows(): Array<Record<string, unknown>> {
    const name = this._table.tableName;
    if (!rows.has(name)) rows.set(name, []);
    return rows.get(name)!;
  }
  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    this._rows().push(data);
    return { insertedId: data._id ?? data.id ?? this._rows().length };
  }
  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    for (const row of data) await this.insertOne(row);
    return { insertedCount: data.length, insertedIds: data.map((d) => d._id ?? d.id) };
  }
  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    const filter = (query.filter ?? {}) as Record<string, any>;
    return (
      this._rows().find((row) =>
        Object.entries(filter).every(
          ([k, v]) => row[k] === (v && typeof v === "object" && "$eq" in v ? v.$eq : v),
        ),
      ) ?? null
    );
  }
  async findMany(): Promise<Array<Record<string, unknown>>> {
    return this._rows();
  }
  async count(): Promise<number> {
    return this._rows().length;
  }
  async replaceOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    const pk = this._table.primaryKeys[0] as string;
    const idx = this._rows().findIndex((r) => r[pk] === (filter as any)[pk]);
    if (idx >= 0) this._rows()[idx] = data;
    return { matchedCount: idx >= 0 ? 1 : 0, modifiedCount: idx >= 0 ? 1 : 0 };
  }
  async updateOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    return this.replaceOne(filter, data);
  }
  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    const pk = this._table.primaryKeys[0] as string;
    const idx = this._rows().findIndex((r) => r[pk] === (filter as any)[pk]);
    if (idx >= 0) this._rows().splice(idx, 1);
    return { deletedCount: idx >= 0 ? 1 : 0 };
  }
  async updateMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    return updateRowsWhere(this._rows(), filter, data);
  }
  async replaceMany(): Promise<TDbUpdateResult> {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    return deleteRowsWhere(this._rows(), filter);
  }
  typeMapper(field: TDbFieldMeta): string {
    return field.designType.toUpperCase();
  }
  private _column(field: TDbFieldMeta): TExistingColumn {
    const column: TExistingColumn = {
      name: field.physicalName,
      type: this.typeMapper(field),
      notnull: !field.optional && !field.derived,
      pk: field.isPrimaryKey,
    };
    if (field.derived) column.generated = true;
    return column;
  }
  async ensureTable(): Promise<void> {
    const name = this._table.tableName;
    if (name === "__atscript_control") return;
    ddl.push(`create ${name}`);
    columns.set(
      name,
      this._table.fieldDescriptors.filter((f) => !f.ignored).map((f) => this._column(f)),
    );
  }
  async getExistingColumns(): Promise<TExistingColumn[]> {
    return columns.get(this._table.tableName) ?? [];
  }
  async syncColumns(diff: TColumnDiff): Promise<TSyncColumnResult> {
    const live = columns.get(this._table.tableName)!;
    const renamed: string[] = [];
    for (const { field, oldName } of diff.renamed) {
      ddl.push(`rename ${oldName} → ${field.physicalName}`);
      const col = live.find((c) => c.name === oldName)!;
      col.name = field.physicalName;
      renamed.push(field.physicalName);
    }
    const added: string[] = [];
    for (const field of diff.added) {
      ddl.push(`add ${field.physicalName}${field.derived ? " generated" : ""}`);
      live.push(this._column(field));
      added.push(field.physicalName);
    }
    return { added, renamed };
  }
  async dropIndexesForColumns(names: string[]): Promise<void> {
    ddl.push(`drop indexes of ${names.join(",")}`);
  }
  async dropColumns(names: string[]): Promise<void> {
    ddl.push(`drop ${names.join(",")}`);
    columns.set(
      this._table.tableName,
      columns.get(this._table.tableName)!.filter((c) => !names.includes(c.name)),
    );
  }
  async syncIndexes(): Promise<void> {
    ddl.push(`indexes ${this._table.tableName}`);
  }
}

/** A document-style adapter (snapshot-based column diff, no introspection). */
class DocAdapter extends SqlishAdapter {
  override supportsNestedObjects(): boolean {
    return true;
  }
  override async ensureTable(): Promise<void> {
    if (this._table.tableName === "__atscript_control") return;
    ddl.push(`create ${this._table.tableName}`);
    created.add(this._table.tableName);
  }
  override async tableExists(): Promise<boolean> {
    return created.has(this._table.tableName);
  }
  override async syncColumns(diff: TColumnDiff): Promise<TSyncColumnResult> {
    for (const field of diff.added) ddl.push(`add ${field.physicalName}`);
    return { added: diff.added.map((f) => f.physicalName), renamed: [] };
  }
  override async dropColumns(names: string[]): Promise<void> {
    ddl.push(`unset ${names.join(",")}`);
  }
}

// No introspection → Path B (stored snapshot)
(DocAdapter.prototype as { getExistingColumns?: unknown }).getExistingColumns = undefined;

function freshSpace(Adapter: new () => BaseDbAdapter): DbSpace {
  ddl = [];
  columns = new Map();
  rows = new Map();
  created = new Set();
  return new DbSpace(() => new Adapter());
}

const entry = (result: { entries: SyncEntry[] }, name = "dv_sync") =>
  result.entries.find((e) => e.name === name)!;
const storedHash = () =>
  rows.get("__atscript_control")?.find((r) => r._id === "schema_version")?.value as
    | string
    | undefined;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/derived.as");
});

describe("SchemaSync — derived columns on a relational adapter", () => {
  it("add-later: the column is added as generated, a second sync is in sync", async () => {
    const space = freshSpace(SqlishAdapter);
    const first = await new SchemaSync(space).run([fx.DvSyncV0], { force: true });
    expect(entry(first).status).toBe("create");

    ddl = [];
    const plan = await planSchema(space, [fx.DvSyncV1]);
    expect(entry(plan).columnsToAdd.map((c) => c.physicalName)).toEqual(["customerId"]);
    expect(entry(plan).print("plan").join("\n")).toContain("+ customerId (string) derived — add");
    const second = await new SchemaSync(space).run([fx.DvSyncV1]);
    expect(second.status).toBe("synced");
    expect(entry(second)).toMatchObject({ status: "alter", columnsAdded: ["customerId"] });
    expect(ddl).toEqual(["add customerId generated", "indexes dv_sync"]);
    expect(columns.get("dv_sync")!.find((c) => c.name === "customerId")).toMatchObject({
      generated: true,
      notnull: false,
    });

    const third = await new SchemaSync(space).run([fx.DvSyncV1]);
    expect(third.status).toBe("up-to-date");
    const forced = await new SchemaSync(space).run([fx.DvSyncV1], { force: true });
    expect(entry(forced).status).toBe("in-sync");
  });

  it("an expression change (source path) and a leaf type change drop + add the column, indexes first", async () => {
    const space = freshSpace(SqlishAdapter);
    await new SchemaSync(space).run([fx.DvSyncV1], { force: true });

    ddl = [];
    const plan = await planSchema(space, [fx.DvSyncV2]);
    expect(entry(plan).derivedChanges).toEqual([
      { column: "customerId", reason: "expression", derived: true },
    ]);
    expect(entry(plan).print("plan").join("\n")).toContain(
      "~ customerId — derived column (expression changed) — drop + add",
    );
    expect(entry(plan).destructive).toBe(false);
    const changed = await new SchemaSync(space).run([fx.DvSyncV2]);
    expect(entry(changed)).toMatchObject({
      status: "alter",
      derivedChanges: entry(plan).derivedChanges,
    });
    expect(entry(changed).print("result").join("\n")).toContain(
      "~ customerId — derived column (expression changed) — rebuilt",
    );
    expect(ddl).toEqual([
      "drop indexes of customerId",
      "drop customerId",
      "add customerId generated",
      "indexes dv_sync",
    ]);
    expect((await new SchemaSync(space).run([fx.DvSyncV2])).status).toBe("up-to-date");

    // Leaf type: the mapped type differs too
    ddl = [];
    const typed = await new SchemaSync(space).run([fx.DvSyncV3]);
    expect(entry(typed).derivedChanges).toEqual([
      { column: "customerId", reason: "expression", derived: true },
    ]);
    expect(ddl).toEqual([
      "drop indexes of customerId",
      "drop customerId",
      "add customerId generated",
      "indexes dv_sync",
    ]);
    expect(columns.get("dv_sync")!.find((c) => c.name === "customerId")!.type).toBe("NUMBER");
    expect((await new SchemaSync(space).run([fx.DvSyncV3])).status).toBe("up-to-date");
  });

  it("a type drift of the live column (no snapshot expression change) is a 'type' rebuild", async () => {
    const space = freshSpace(SqlishAdapter);
    await new SchemaSync(space).run([fx.DvSyncV1], { force: true });
    columns.get("dv_sync")!.find((c) => c.name === "customerId")!.type = "BLOB";
    const plan = await planSchema(space, [fx.DvSyncV1], { force: true });
    expect(entry(plan).derivedChanges).toEqual([
      { column: "customerId", reason: "type", derived: true },
    ]);
  });

  it("kind changes go both ways as drop + add (column-drop policy), and are destructive", async () => {
    const space = freshSpace(SqlishAdapter);
    await new SchemaSync(space).run([fx.DvSyncK], { force: true });
    expect(columns.get("dv_sync")!.find((c) => c.name === "customerId")!.generated).toBeUndefined();

    ddl = [];
    const toDerived = await planSchema(space, [fx.DvSyncV1]);
    expect(entry(toDerived).derivedChanges).toEqual([
      { column: "customerId", reason: "kind", derived: true },
    ]);
    expect(entry(toDerived).destructive).toBe(true);
    expect(entry(toDerived).print("plan").join("\n")).toContain(
      "! customerId — derived column (regular → derived) — drop + add",
    );
    await new SchemaSync(space).run([fx.DvSyncV1]);
    expect(ddl).toEqual([
      "drop indexes of customerId",
      "drop customerId",
      "add customerId generated",
      "indexes dv_sync",
    ]);

    ddl = [];
    const back = await new SchemaSync(space).run([fx.DvSyncK]);
    expect(entry(back).derivedChanges).toEqual([
      { column: "customerId", reason: "kind", derived: false },
    ]);
    expect(ddl).toEqual([
      "drop indexes of customerId",
      "drop customerId",
      "add customerId",
      "indexes dv_sync",
    ]);
    expect(columns.get("dv_sync")!.find((c) => c.name === "customerId")!.generated).toBeUndefined();
    expect((await new SchemaSync(space).run([fx.DvSyncK])).status).toBe("up-to-date");
  });

  it("safe mode skips the rebuild, reports it, and withholds the hash", async () => {
    const space = freshSpace(SqlishAdapter);
    await new SchemaSync(space).run([fx.DvSyncV1], { force: true });
    const hashBefore = storedHash();

    ddl = [];
    const plan = await planSchema(space, [fx.DvSyncV2], { safe: true });
    expect(entry(plan).skipped).toEqual(["derived"]);
    expect(entry(plan).print("plan").join("\n")).toContain(
      "! customerId — derived column (expression changed) — skipped (safe mode)",
    );
    const result = await new SchemaSync(space).run([fx.DvSyncV2], { safe: true });
    expect(result.status).toBe("synced");
    expect(entry(result)).toMatchObject({ status: "alter", skipped: ["derived"], pending: true });
    expect(entry(result).print("result").join("\n")).toContain("skipped (safe mode)");
    expect(ddl).toEqual(["indexes dv_sync"]);
    expect(storedHash()).toBe(hashBefore);

    // The next run without safe applies it, no force needed
    ddl = [];
    const applied = await new SchemaSync(space).run([fx.DvSyncV2]);
    expect(applied.status).toBe("synced");
    expect(ddl).toEqual([
      "drop indexes of customerId",
      "drop customerId",
      "add customerId generated",
      "indexes dv_sync",
    ]);
    expect(storedHash()).not.toBe(hashBefore);
  });

  it("rename and removal follow the regular column rules", async () => {
    const space = freshSpace(SqlishAdapter);
    await new SchemaSync(space).run([fx.DvSyncV1], { force: true });
    ddl = [];
    const renamed = await new SchemaSync(space).run([fx.DvSyncV4]);
    expect(entry(renamed).columnsRenamed).toEqual(["custId"]);
    expect(ddl).toEqual(["rename customerId → custId", "indexes dv_sync"]);
    expect(columns.get("dv_sync")!.find((c) => c.name === "custId")!.generated).toBe(true);

    ddl = [];
    const removed = await new SchemaSync(space).run([fx.DvSyncV0]);
    expect(entry(removed).columnsDropped).toEqual(["custId"]);
    expect(ddl).toEqual(["drop indexes of custId", "drop custId", "indexes dv_sync"]);
    expect((await new SchemaSync(space).run([fx.DvSyncV0])).status).toBe("up-to-date");
  });
});

describe("SchemaSync — derived columns on a document adapter (snapshot diff)", () => {
  it("never adds, unsets or backfills a derived field; the snapshot still tracks it", async () => {
    const space = freshSpace(DocAdapter);
    const first = await new SchemaSync(space).run([fx.DvSyncV0], { force: true });
    expect(entry(first).status).toBe("create");

    ddl = [];
    const plan = await planSchema(space, [fx.DvSyncV1]);
    expect(entry(plan).columnsToAdd).toEqual([]);
    // The index over the source path is new, so the hash changes
    expect(plan.status).toBe("changes-needed");
    const added = await new SchemaSync(space).run([fx.DvSyncV1]);
    expect(added.status).toBe("synced");
    expect(ddl).toEqual(["indexes dv_sync"]);
    expect((await new SchemaSync(space).run([fx.DvSyncV1])).status).toBe("up-to-date");

    // Expression change: nothing to do but the snapshot (the index moves)
    ddl = [];
    const changed = await new SchemaSync(space).run([fx.DvSyncV2]);
    expect(entry(changed).derivedChanges).toEqual([]);
    expect(entry(changed).columnsToAdd).toEqual([]);
    expect(entry(changed).columnsDropped).toEqual([]);
    expect(ddl).toEqual(["indexes dv_sync"]);

    // Removal: the source leaf must never be unset
    ddl = [];
    const removed = await new SchemaSync(space).run([fx.DvSyncV0]);
    expect(entry(removed).columnsDropped).toEqual([]);
    expect(ddl.some((d) => d.startsWith("unset"))).toBe(false);
    expect((await new SchemaSync(space).run([fx.DvSyncV0])).status).toBe("up-to-date");
  });

  it("a fresh create never lists the derived field as a column to add", async () => {
    const space = freshSpace(DocAdapter);
    const plan = await planSchema(space, [fx.DvSyncV1]);
    // Nested leaves are listed as usual; the derived field is not
    expect(entry(plan).columnsToAdd.map((c) => c.physicalName)).toEqual([
      "id",
      "payload",
      "payload.customer",
      "payload.customer.id",
      "payload.customer.n",
      "payload.code",
    ]);
  });
});
