import { BaseDbAdapter, AtscriptDbView, DbError } from "@atscript/db";
import type {
  TDbDeleteResult,
  TDbIndex,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbUpdateResult,
  TExistingColumn,
  TColumnDiff,
  TSyncColumnResult,
  TSearchIndexInfo,
} from "@atscript/db";
import type { DbQuery, FilterExpr } from "@atscript/db";

import { buildWhere, buildPrefixedWhere } from "./filter-builder";
import {
  buildAggregateCount,
  buildAggregateSelect,
  buildCreateTable,
  buildCreateView,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  defaultValueForType,
  defaultValueToSqlLiteral,
  esc,
  toSqliteValue,
  sqliteTypeFromDesignType,
} from "./sql-builder";
import type { TSqliteDriver } from "./types";

/**
 * SQLite adapter for {@link AtscriptDbTable}.
 *
 * Accepts any {@link TSqliteDriver} implementation — the actual SQLite engine
 * is fully swappable (better-sqlite3, node:sqlite, sql.js, etc.).
 *
 * Usage:
 * ```typescript
 * import { BetterSqlite3Driver } from '@atscript/db-sqlite'
 *
 * const driver = new BetterSqlite3Driver(':memory:')
 * const adapter = new SqliteAdapter(driver)
 * const users = new AtscriptDbTable(UsersType, adapter)
 * ```
 */
export class SqliteAdapter extends BaseDbAdapter {
  override supportsNativeValueDefaults(): boolean {
    return true;
  }

  constructor(protected readonly driver: TSqliteDriver) {
    super();
    this.driver.exec("PRAGMA foreign_keys = ON");
  }

  // ── Transaction primitives ────────────────────────────────────────────────

  protected override async _beginTransaction(): Promise<unknown> {
    this._log("BEGIN");
    this.driver.exec("BEGIN");
    return undefined;
  }

  protected override async _commitTransaction(): Promise<void> {
    this._log("COMMIT");
    this.driver.exec("COMMIT");
  }

  protected override async _rollbackTransaction(): Promise<void> {
    this._log("ROLLBACK");
    this.driver.exec("ROLLBACK");
  }

  /** SQLite does not use schemas — override to always exclude schema. */
  override resolveTableName(): string {
    return super.resolveTableName(false);
  }

  /** SQLite enforces FK constraints natively via PRAGMA foreign_keys. */
  override supportsNativeForeignKeys(): boolean {
    return true;
  }

  // ── ID preparation ─────────────────────────────────────────────────────────

  override prepareId(id: unknown, _fieldType: unknown): unknown {
    // SQLite uses integer or text PKs — no transformation needed
    return id;
  }

  /**
   * Wraps a write operation to catch native SQLite constraint errors
   * and rethrow as structured `DbError`.
   */
  private _wrapConstraintError<R>(fn: () => R): R {
    try {
      return fn();
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.includes("FOREIGN KEY constraint failed")) {
          throw new DbError("FK_VIOLATION", [{ path: "", message: error.message }]);
        }
        const uniqueMatch = error.message.match(/UNIQUE constraint failed:\s*\S+\.(\S+)/);
        if (uniqueMatch) {
          throw new DbError("CONFLICT", [{ path: uniqueMatch[1], message: error.message }]);
        }
        if (error.message.includes("UNIQUE constraint failed")) {
          throw new DbError("CONFLICT", [{ path: "", message: error.message }]);
        }
      }
      throw error;
    }
  }

  // ── CRUD: Insert ───────────────────────────────────────────────────────────

  async insertOne(data: Record<string, unknown>): Promise<TDbInsertResult> {
    const { sql, params } = buildInsert(this.resolveTableName(), data);
    this._log(sql, params);
    const result = this._wrapConstraintError(() => this.driver.run(sql, params));
    return { insertedId: this._resolveInsertedId(data, result.lastInsertRowid) };
  }

  async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    return this.withTransaction(async () => {
      const ids: unknown[] = [];
      for (const row of data) {
        const { sql, params } = buildInsert(this.resolveTableName(), row);
        this._log(sql, params);
        const result = this._wrapConstraintError(() => this.driver.run(sql, params));
        ids.push(this._resolveInsertedId(row, result.lastInsertRowid));
      }
      return { insertedCount: ids.length, insertedIds: ids };
    });
  }

  // ── CRUD: Read ─────────────────────────────────────────────────────────────

  async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    const where = buildWhere(query.filter);
    const controls = { ...query.controls, $limit: 1 };
    const { sql, params } = buildSelect(this.resolveTableName(), where, controls);
    this._log(sql, params);
    return this.driver.get(sql, params);
  }

  async findMany(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    const where = buildWhere(query.filter);
    const { sql, params } = buildSelect(this.resolveTableName(), where, query.controls);
    this._log(sql, params);
    return this.driver.all(sql, params);
  }

  async count(query: DbQuery): Promise<number> {
    const where = buildWhere(query.filter);
    const tableName = this.resolveTableName();
    const sql = `SELECT COUNT(*) as cnt FROM "${esc(tableName)}" WHERE ${where.sql}`;
    this._log(sql, where.params);
    const row = this.driver.get<{ cnt: number }>(sql, where.params);
    return row?.cnt ?? 0;
  }

  async aggregate(query: DbQuery): Promise<Array<Record<string, unknown>>> {
    const where = buildWhere(query.filter);
    const tableName = this.resolveTableName();

    if (query.controls.$count) {
      const { sql, params } = buildAggregateCount(tableName, where, query.controls);
      this._log(sql, params);
      const row = this.driver.get<{ count: number }>(sql, params);
      return [{ count: row?.count ?? 0 }];
    }

    const { sql, params } = buildAggregateSelect(tableName, where, query.controls);
    this._log(sql, params);
    return this.driver.all(sql, params);
  }

  // ── CRUD: Update ───────────────────────────────────────────────────────────

  async updateOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    // SQLite doesn't support UPDATE ... LIMIT 1 directly.
    // Use a subquery on rowid to target one row.
    const where = buildWhere(filter);
    const tableName = this.resolveTableName();
    const setClauses: string[] = [];
    const setParams: unknown[] = [];

    for (const [key, value] of Object.entries(data)) {
      setClauses.push(`"${esc(key)}" = ?`);
      setParams.push(toSqliteValue(value));
    }

    const sql = `UPDATE "${esc(tableName)}" SET ${setClauses.join(", ")} WHERE rowid = (SELECT rowid FROM "${esc(tableName)}" WHERE ${where.sql} LIMIT 1)`;
    const allParams = [...setParams, ...where.params];
    this._log(sql, allParams);
    const result = this._wrapConstraintError(() => this.driver.run(sql, allParams));
    return { matchedCount: result.changes, modifiedCount: result.changes };
  }

  async updateMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    const where = buildWhere(filter);
    const { sql, params } = buildUpdate(this.resolveTableName(), data, where);
    this._log(sql, params);
    const result = this._wrapConstraintError(() => this.driver.run(sql, params));
    return { matchedCount: result.changes, modifiedCount: result.changes };
  }

  // ── CRUD: Replace ──────────────────────────────────────────────────────────

  async replaceOne(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    const where = buildWhere(filter);
    const tableName = this.resolveTableName();
    // Use UPDATE (set all columns) instead of DELETE+INSERT to avoid triggering CASCADE deletes
    const limitedWhere = {
      sql: `rowid = (SELECT rowid FROM "${esc(tableName)}" WHERE ${where.sql} LIMIT 1)`,
      params: where.params,
    };
    const { sql, params } = buildUpdate(tableName, data, limitedWhere);
    this._log(sql, params);
    const result = this._wrapConstraintError(() => this.driver.run(sql, params));
    return { matchedCount: result.changes, modifiedCount: result.changes };
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    // For replaceMany we do a full UPDATE (set all columns)
    const where = buildWhere(filter);
    const { sql, params } = buildUpdate(this.resolveTableName(), data, where);
    this._log(sql, params);
    const result = this._wrapConstraintError(() => this.driver.run(sql, params));
    return { matchedCount: result.changes, modifiedCount: result.changes };
  }

  // ── CRUD: Delete ───────────────────────────────────────────────────────────

  async deleteOne(filter: FilterExpr): Promise<TDbDeleteResult> {
    const where = buildWhere(filter);
    const tableName = this.resolveTableName();
    const sql = `DELETE FROM "${esc(tableName)}" WHERE rowid = (SELECT rowid FROM "${esc(tableName)}" WHERE ${where.sql} LIMIT 1)`;
    this._log(sql, where.params);
    const result = this._wrapConstraintError(() => this.driver.run(sql, where.params));
    return { deletedCount: result.changes };
  }

  async deleteMany(filter: FilterExpr): Promise<TDbDeleteResult> {
    const where = buildWhere(filter);
    const { sql, params } = buildDelete(this.resolveTableName(), where);
    this._log(sql, params);
    const result = this._wrapConstraintError(() => this.driver.run(sql, params));
    return { deletedCount: result.changes };
  }

  // ── Schema ─────────────────────────────────────────────────────────────────

  async ensureTable(): Promise<void> {
    if (this._table instanceof AtscriptDbView) {
      return this.ensureView();
    }
    const sql = buildCreateTable(
      this.resolveTableName(),
      this._table.fieldDescriptors,
      this._table.foreignKeys,
    );
    this._log(sql);
    this.driver.exec(sql);

    // Seed sqlite_sequence for @db.default.increment with start value
    this._seedIncrementStart();
  }

  private _incrementSeeded = false;

  /**
   * Seeds the sqlite_sequence table for auto-increment fields that have a start value.
   * Only applies once per adapter instance (idempotent via INSERT OR IGNORE + flag).
   */
  private _seedIncrementStart(): void {
    if (this._incrementSeeded) {
      return;
    }
    this._incrementSeeded = true;
    const tableName = this.resolveTableName();
    for (const def of this._table.defaults.values()) {
      if (def.kind === "fn" && def.fn === "increment" && typeof def.start === "number") {
        const seedSql = `INSERT OR IGNORE INTO sqlite_sequence(name, seq) VALUES(?, ?)`;
        const params = [tableName, def.start - 1];
        this._log(seedSql, params);
        this.driver.run(seedSql, params);
        break; // Only one auto-increment PK per table
      }
    }
  }

  async ensureView(): Promise<void> {
    const view = this._table as AtscriptDbView;
    const sql = buildCreateView(
      this.resolveTableName(),
      view.viewPlan,
      view.getViewColumnMappings(),
      (ref) => view.resolveFieldRef(ref),
    );
    this._log(sql);
    this.driver.exec(sql);
  }

  async getExistingColumns(): Promise<TExistingColumn[]> {
    return this.getExistingColumnsForTable(this.resolveTableName());
  }

  async syncColumns(diff: TColumnDiff): Promise<TSyncColumnResult> {
    const tableName = this.resolveTableName();
    const added: string[] = [];
    const renamed: string[] = [];

    // Renames first (before adds, in case a renamed column is referenced)
    for (const { field, oldName } of diff.renamed ?? []) {
      const ddl = `ALTER TABLE "${esc(tableName)}" RENAME COLUMN "${esc(oldName)}" TO "${esc(field.physicalName)}"`;
      this._log(ddl);
      this.driver.exec(ddl);
      renamed.push(field.physicalName);
    }

    // Adds
    for (const field of diff.added) {
      const sqlType = this.typeMapper(field);
      let ddl = `ALTER TABLE "${esc(tableName)}" ADD COLUMN "${esc(field.physicalName)}" ${sqlType}`;
      if (!field.optional && !field.isPrimaryKey) {
        ddl += " NOT NULL";
      }
      // SQLite ADD COLUMN with NOT NULL requires a DEFAULT; also emit explicit @db.default
      if (field.defaultValue?.kind === "value") {
        ddl += ` DEFAULT ${defaultValueToSqlLiteral(field.designType, field.defaultValue.value)}`;
      } else if (!field.optional && !field.isPrimaryKey) {
        ddl += ` DEFAULT ${defaultValueForType(field.designType)}`;
      }
      if (field.collate) {
        ddl += ` COLLATE ${field.collate.toUpperCase()}`;
      }
      this._log(ddl);
      this.driver.exec(ddl);
      added.push(field.physicalName);
    }

    return { added, renamed };
  }

  async recreateTable(): Promise<void> {
    const tableName = this.resolveTableName();
    const tempName = `${tableName}__tmp_${Date.now()}`;

    // Drop FTS tables before rebuild — syncIndexes() will recreate them
    this._dropAllFtsTables(tableName);

    // Disable FK checks during recreation — referenced tables may be mid-sync
    this.driver.exec("PRAGMA foreign_keys = OFF");
    this.driver.exec("PRAGMA legacy_alter_table = ON");
    try {
      // 1. Create new table with temp name
      const createSql = buildCreateTable(
        tempName,
        this._table.fieldDescriptors,
        this._table.foreignKeys,
      );
      this._log(createSql);
      this.driver.exec(createSql);

      // 2. Get columns that exist in both old and new
      const oldCols = (await this.getExistingColumns()).map((c) => c.name);
      const newCols = this._table.fieldDescriptors
        .filter((f) => !f.ignored)
        .map((f) => f.physicalName);
      const oldColSet = new Set(oldCols);
      const commonCols = newCols.filter((c) => oldColSet.has(c));

      if (commonCols.length > 0) {
        // 3. Copy data — use COALESCE for columns that became NOT NULL
        const fieldsByName = new Map(this._table.fieldDescriptors.map((f) => [f.physicalName, f]));
        const colNames = commonCols.map((c) => `"${esc(c)}"`).join(", ");
        const selectExprs = commonCols
          .map((c) => {
            const field = fieldsByName.get(c);
            if (field && !field.optional && !field.isPrimaryKey) {
              const fallback =
                field.defaultValue?.kind === "value"
                  ? defaultValueToSqlLiteral(field.designType, field.defaultValue.value)
                  : defaultValueForType(field.designType);
              return `COALESCE("${esc(c)}", ${fallback}) AS "${esc(c)}"`;
            }
            return `"${esc(c)}"`;
          })
          .join(", ");
        const copySql = `INSERT INTO "${esc(tempName)}" (${colNames}) SELECT ${selectExprs} FROM "${esc(tableName)}"`;
        this._log(copySql);
        this.driver.exec(copySql);
      }

      // 4. Rename old table out of the way, rename new into place, drop old
      const oldName = `${tableName}__old_${Date.now()}`;
      this.driver.exec(`ALTER TABLE "${esc(tableName)}" RENAME TO "${esc(oldName)}"`);
      this.driver.exec(`ALTER TABLE "${esc(tempName)}" RENAME TO "${esc(tableName)}"`);
      this.driver.exec(`DROP TABLE IF EXISTS "${esc(oldName)}"`);
    } finally {
      this.driver.exec("PRAGMA legacy_alter_table = OFF");
      this.driver.exec("PRAGMA foreign_keys = ON");
    }
  }

  async dropTable(): Promise<void> {
    const tableName = this.resolveTableName();
    this._dropAllFtsTables(tableName);
    const ddl = `DROP TABLE IF EXISTS "${esc(tableName)}"`;
    this._log(ddl);
    this.driver.exec(ddl);
  }

  async dropColumns(columns: string[]): Promise<void> {
    await this.withTransaction(async () => {
      const tableName = this.resolveTableName();
      for (const col of columns) {
        const ddl = `ALTER TABLE "${esc(tableName)}" DROP COLUMN "${esc(col)}"`;
        this._log(ddl);
        this.driver.exec(ddl);
      }
    });
  }

  async dropTableByName(tableName: string): Promise<void> {
    this._dropAllFtsTables(tableName);
    const ddl = `DROP TABLE IF EXISTS "${esc(tableName)}"`;
    this._log(ddl);
    this.driver.exec(ddl);
  }

  async dropViewByName(viewName: string): Promise<void> {
    const ddl = `DROP VIEW IF EXISTS "${esc(viewName)}"`;
    this._log(ddl);
    this.driver.exec(ddl);
  }

  async renameTable(oldName: string): Promise<void> {
    const newName = this.resolveTableName();
    const ddl = `ALTER TABLE "${esc(oldName)}" RENAME TO "${esc(newName)}"`;
    this._log(ddl);
    this.driver.exec(ddl);
  }

  typeMapper(field: { designType: string; isPrimaryKey: boolean }): string {
    // Numeric primary keys must be INTEGER (not REAL) for SQLite rowid alias
    if (field.isPrimaryKey && (field.designType === "number" || field.designType === "integer")) {
      return "INTEGER";
    }
    return sqliteTypeFromDesignType(field.designType);
  }

  async getExistingColumnsForTable(tableName: string): Promise<TExistingColumn[]> {
    const rows = this.driver.all<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>(`PRAGMA table_info("${esc(tableName)}")`);
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      notnull: r.notnull === 1,
      pk: r.pk > 0,
      dflt_value: normalizeSqliteDefault(r.dflt_value),
    }));
  }

  async syncIndexes(): Promise<void> {
    const tableName = this.resolveTableName();

    await this.syncIndexesWithDiff({
      listExisting: async () =>
        this.driver
          .all<{ name: string }>(`PRAGMA index_list("${esc(tableName)}")`)
          .filter((i) => !i.name.startsWith("sqlite_")),
      createIndex: async (index: TDbIndex) => {
        const unique = index.type === "unique" ? "UNIQUE " : "";
        // Field names are already resolved to physical names by the generic layer
        const cols = index.fields
          .map((f) => `"${esc(f.name)}" ${f.sort === "desc" ? "DESC" : "ASC"}`)
          .join(", ");
        const sql = `CREATE ${unique}INDEX IF NOT EXISTS "${esc(index.key)}" ON "${esc(tableName)}" (${cols})`;
        this._log(sql);
        this.driver.exec(sql);
      },
      dropIndex: async (name: string) => {
        const sql = `DROP INDEX IF EXISTS "${esc(name)}"`;
        this._log(sql);
        this.driver.exec(sql);
      },
      shouldSkipType: (type) => type === "fulltext",
    });

    // Sync FTS5 virtual tables for fulltext indexes
    this._syncFtsIndexes(tableName);
  }

  // ── FTS5 Full-Text Search ─────────────────────────────────────────────────

  override getSearchIndexes(): TSearchIndexInfo[] {
    return this._getFulltextIndexes().map((idx) => ({
      name: idx.name,
      description: `FTS5 index (${idx.fields.map((f) => f.name).join(", ")})`,
      type: "text" as const,
    }));
  }

  override async search(
    text: string,
    query: DbQuery,
    indexName?: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (!text.trim()) {
      return [];
    }
    const base = this._buildFtsBase(text, query.filter, indexName);
    const controls = query.controls || {};

    // Projection
    let cols = "t.*";
    if (controls.$select?.asArray?.length) {
      cols = controls.$select.asArray.map((c: string) => `t."${esc(c)}"`).join(", ");
    }

    let sql = `SELECT ${cols} ${base.fromWhere}`;
    const params = [...base.params];

    // Sort
    if (controls.$sort) {
      const orderParts: string[] = [];
      for (const [col, dir] of Object.entries(controls.$sort)) {
        orderParts.push(`t."${esc(col)}" ${dir === -1 ? "DESC" : "ASC"}`);
      }
      if (orderParts.length > 0) {
        sql += ` ORDER BY ${orderParts.join(", ")}`;
      }
    }

    // Limit / Offset
    if (controls.$limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(controls.$limit);
    }
    if (controls.$skip !== undefined) {
      if (controls.$limit === undefined) {
        sql += ` LIMIT -1`;
      }
      sql += ` OFFSET ?`;
      params.push(controls.$skip);
    }

    this._log(sql, params);
    return this.driver.all(sql, params);
  }

  override async searchWithCount(
    text: string,
    query: DbQuery,
    indexName?: string,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    if (!text.trim()) {
      return { data: [], count: 0 };
    }
    const data = await this.search(text, query, indexName);

    // Count query reuses the same FROM+WHERE base, without limit/skip
    const base = this._buildFtsBase(text, query.filter, indexName);
    const countSql = `SELECT COUNT(*) as cnt ${base.fromWhere}`;
    this._log(countSql, base.params);
    const row = this.driver.get<{ cnt: number }>(countSql, base.params);
    return { data, count: row?.cnt ?? 0 };
  }

  // ── FTS5 internals ────────────────────────────────────────────────────────

  /** Builds FTS table name from index name: `<table>__fts__<indexName>`. */
  private _ftsTableName(indexName: string): string {
    return `${this.resolveTableName()}__fts__${indexName}`;
  }

  /** Returns fulltext indexes from table metadata. */
  private _getFulltextIndexes(): TDbIndex[] {
    const result: TDbIndex[] = [];
    for (const index of this._table.indexes.values()) {
      if (index.type === "fulltext") {
        result.push(index);
      }
    }
    return result;
  }

  /** Resolves a fulltext index by name, or returns the first available. */
  private _resolveFtsIndex(indexName?: string): TDbIndex {
    const ftIndexes = this._getFulltextIndexes();
    if (ftIndexes.length === 0) {
      throw new Error("No search index available");
    }
    if (indexName) {
      const found = ftIndexes.find((idx) => idx.name === indexName);
      if (!found) {
        throw new Error(`Search index "${indexName}" not found`);
      }
      return found;
    }
    return ftIndexes[0];
  }

  /**
   * Builds the shared FROM+JOIN+WHERE fragment for FTS5 queries.
   * Both data and count queries reuse this to avoid duplicating index resolution and filter translation.
   */
  private _buildFtsBase(
    text: string,
    filter: FilterExpr,
    indexName?: string,
  ): { fromWhere: string; params: unknown[] } {
    const ftsIndex = this._resolveFtsIndex(indexName);
    const ftsTable = this._ftsTableName(ftsIndex.name);
    const tableName = this.resolveTableName();
    const where = buildPrefixedWhere("t", filter);

    let fromWhere = `FROM "${esc(tableName)}" AS t`;
    fromWhere += ` JOIN "${esc(ftsTable)}" AS fts ON t.rowid = fts.rowid`;
    fromWhere += ` WHERE fts."${esc(ftsTable)}" MATCH ?`;
    const params: unknown[] = [text];

    if (where.sql !== "1=1") {
      fromWhere += ` AND (${where.sql})`;
      params.push(...where.params);
    }

    return { fromWhere, params };
  }

  /**
   * Creates/drops FTS5 virtual tables and sync triggers to match desired fulltext indexes.
   */
  private _syncFtsIndexes(tableName: string): void {
    const ftIndexes = this._getFulltextIndexes();
    const desiredFtsTables = new Set(ftIndexes.map((idx) => this._ftsTableName(idx.name)));

    // List existing FTS virtual tables for this content table (exclude shadow tables like _data, _idx)
    const existingFts = this.driver
      .all<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE ?`,
        [`${tableName}__fts__%`],
      )
      .filter((r) => r.sql.startsWith("CREATE VIRTUAL TABLE"))
      .map((r) => r.name);

    // Drop stale FTS tables
    for (const name of existingFts) {
      if (!desiredFtsTables.has(name)) {
        this._dropFtsTable(name);
      }
    }

    // Create missing FTS tables
    const existingSet = new Set(existingFts);
    for (const index of ftIndexes) {
      const ftsTable = this._ftsTableName(index.name);
      if (!existingSet.has(ftsTable)) {
        this._createFtsTable(tableName, ftsTable, index);
      }
    }
  }

  /** Creates an FTS5 virtual table with sync triggers and rebuilds the index. */
  private _createFtsTable(tableName: string, ftsTable: string, index: TDbIndex): void {
    const fieldNames = index.fields.map((f) => `"${esc(f.name)}"`);
    const fieldList = fieldNames.join(", ");

    // Create external-content FTS5 virtual table
    const createSql = `CREATE VIRTUAL TABLE IF NOT EXISTS "${esc(ftsTable)}" USING fts5(${fieldList}, content='${tableName.replace(/'/g, "''")}', content_rowid='rowid')`;
    this._log(createSql);
    this.driver.exec(createSql);

    // Create sync triggers
    const newFields = index.fields.map((f) => `new."${esc(f.name)}"`).join(", ");
    const oldFields = index.fields.map((f) => `old."${esc(f.name)}"`).join(", ");
    const ef = esc(ftsTable);

    // AFTER INSERT
    const aiSql = `CREATE TRIGGER IF NOT EXISTS "${esc(ftsTable + "__ai")}" AFTER INSERT ON "${esc(tableName)}" BEGIN INSERT INTO "${ef}"(rowid, ${fieldList}) VALUES (new.rowid, ${newFields}); END`;
    this._log(aiSql);
    this.driver.exec(aiSql);

    // AFTER DELETE
    const adSql = `CREATE TRIGGER IF NOT EXISTS "${esc(ftsTable + "__ad")}" AFTER DELETE ON "${esc(tableName)}" BEGIN INSERT INTO "${ef}"("${ef}", rowid, ${fieldList}) VALUES ('delete', old.rowid, ${oldFields}); END`;
    this._log(adSql);
    this.driver.exec(adSql);

    // AFTER UPDATE
    const auSql = `CREATE TRIGGER IF NOT EXISTS "${esc(ftsTable + "__au")}" AFTER UPDATE ON "${esc(tableName)}" BEGIN INSERT INTO "${ef}"("${ef}", rowid, ${fieldList}) VALUES ('delete', old.rowid, ${oldFields}); INSERT INTO "${ef}"(rowid, ${fieldList}) VALUES (new.rowid, ${newFields}); END`;
    this._log(auSql);
    this.driver.exec(auSql);

    // Rebuild index to pick up any existing rows
    const rebuildSql = `INSERT INTO "${ef}"("${ef}") VALUES ('rebuild')`;
    this._log(rebuildSql);
    this.driver.exec(rebuildSql);
  }

  /** Drops an FTS5 virtual table and its sync triggers. */
  private _dropFtsTable(ftsTable: string): void {
    for (const suffix of ["__ai", "__ad", "__au"]) {
      this.driver.exec(`DROP TRIGGER IF EXISTS "${esc(ftsTable + suffix)}"`);
    }
    const sql = `DROP TABLE IF EXISTS "${esc(ftsTable)}"`;
    this._log(sql);
    this.driver.exec(sql);
  }

  /** Drops all FTS virtual tables and triggers for a content table. */
  private _dropAllFtsTables(tableName: string): void {
    const ftsTables = this.driver
      .all<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE ?`,
        [`${tableName}__fts__%`],
      )
      .filter((r) => r.sql.startsWith("CREATE VIRTUAL TABLE"));
    for (const { name } of ftsTables) {
      this._dropFtsTable(name);
    }
  }
}

/** Normalizes SQLite PRAGMA dflt_value to match serialized format.
 *  PRAGMA returns `'active'` (SQL-quoted), we store `active` (raw). */
function normalizeSqliteDefault(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  // Strip enclosing single quotes from string literals
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
