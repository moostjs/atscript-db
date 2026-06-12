import type { TMetadataMap } from "@atscript/typescript/utils";
import { BaseDbAdapter, AtscriptDbView, DbError } from "@atscript/db";
import type { TFieldOps } from "@atscript/db";
import type {
  TDbDeleteResult,
  TDbFieldMeta,
  TDbIndex,
  TDbInsertManyResult,
  TDbInsertResult,
  TDbUpdateResult,
  TExistingColumn,
  TColumnDiff,
  TSyncColumnResult,
  TSearchIndexInfo,
  TValueFormatterPair,
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
  similarityToVecMetric,
  sqliteTypeFromDesignType,
  thresholdToVecDistance,
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

  // ── Vector search state ─────────────────────────────────────────────────
  /** Whether the SQLite connection has the sqlite-vec extension loaded. */
  private _supportsVector: boolean | undefined;
  /** Vector fields: field path → { dimensions, similarity, indexName }. */
  private _vectorFields = new Map<
    string,
    { dimensions: number; similarity: string; indexName: string }
  >();
  /** Default similarity thresholds per vector index (from @db.search.vector.threshold). */
  private _vectorThresholds = new Map<string, number>();
  /** Partition filter fields per vector index (from @db.search.filter). Field paths. */
  private _vectorPartitionFields = new Map<string, string[]>();

  constructor(protected readonly driver: TSqliteDriver) {
    super();
    this.driver.exec("PRAGMA foreign_keys = ON");
  }

  override onFieldScanned(
    field: string,
    _type: unknown,
    metadata: TMetadataMap<AtscriptMetadata>,
  ): void {
    const vectorMeta = metadata.get("db.search.vector") as
      | { dimensions: number; similarity?: string; indexName?: string }
      | undefined;
    if (vectorMeta) {
      const indexName = vectorMeta.indexName || field;
      this._vectorFields.set(field, {
        dimensions: vectorMeta.dimensions,
        similarity: vectorMeta.similarity || "cosine",
        indexName,
      });
      const threshold = metadata.get("db.search.vector.threshold") as number | undefined;
      if (threshold !== undefined) {
        this._vectorThresholds.set(indexName, threshold);
      }
    }
    // @db.search.filter (generic) — each entry is a plain string (the index name)
    for (const indexName of metadata.get("db.search.filter") || []) {
      const list = this._vectorPartitionFields.get(indexName);
      if (list) {
        list.push(field);
      } else {
        this._vectorPartitionFields.set(indexName, [field]);
      }
    }
  }

  override formatValue(field: TDbFieldMeta): TValueFormatterPair | undefined {
    if (!this._vectorFields.has(field.path)) {
      return undefined;
    }
    if (this._detectVectorSupport()) {
      return {
        toStorage: (value: unknown) =>
          Array.isArray(value) ? Buffer.from(new Float32Array(value as number[]).buffer) : value,
        fromStorage: (value: unknown) => {
          if (value instanceof Buffer || value instanceof Uint8Array) {
            const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const arr = new Float32Array(
              buf.buffer,
              buf.byteOffset,
              Math.floor(buf.byteLength / 4),
            );
            return Array.from(arr);
          }
          return value;
        },
      };
    }
    return {
      toStorage: (value: unknown) => (Array.isArray(value) ? JSON.stringify(value) : value),
      fromStorage: (value: unknown) => {
        if (typeof value === "string") {
          try {
            return JSON.parse(value);
          } catch {
            return value;
          }
        }
        return value;
      },
    };
  }

  override isVectorSearchable(): boolean {
    if (this._vectorFields.size === 0) {
      return false;
    }
    return this._detectVectorSupport();
  }

  private _detectVectorSupport(): boolean {
    if (this._supportsVector !== undefined) {
      return this._supportsVector;
    }
    // Prefer the driver's authoritative capability flag; fall back to a probe for drivers
    // that don't expose `hasVectorExt`.
    if (this.driver.hasVectorExt !== undefined) {
      this._supportsVector = this.driver.hasVectorExt;
    } else {
      try {
        this.driver.get("SELECT vec_version()");
        this._supportsVector = true;
      } catch {
        this._supportsVector = false;
      }
    }
    if (!this._supportsVector && this._vectorFields.size > 0) {
      this._log(
        "[atscript-db-sqlite] sqlite-vec extension not available — vector fields will be stored as JSON TEXT (no similarity search).",
      );
    }
    return this._supportsVector;
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

  async updateOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
    expectedVersion?: number,
  ): Promise<TDbUpdateResult> {
    const where = buildWhere(filter);
    const tableName = this.resolveTableName();
    const versionColumn = this._table.versionColumn;
    const limitedWhere = {
      sql: `rowid = (SELECT rowid FROM "${esc(tableName)}" WHERE ${where.sql} LIMIT 1)`,
      params: where.params,
    };
    const { sql, params } = buildUpdate(
      tableName,
      data,
      limitedWhere,
      ops,
      versionColumn,
      expectedVersion,
    );
    this._log(sql, params);
    const result = this._wrapConstraintError(() => this.driver.run(sql, params));
    return { matchedCount: result.changes, modifiedCount: result.changes };
  }

  async updateMany(
    filter: FilterExpr,
    data: Record<string, unknown>,
    ops?: TFieldOps,
  ): Promise<TDbUpdateResult> {
    const where = buildWhere(filter);
    const versionColumn = this._table.versionColumn;
    const { sql, params } = buildUpdate(this.resolveTableName(), data, where, ops, versionColumn);
    this._log(sql, params);
    const result = this._wrapConstraintError(() => this.driver.run(sql, params));
    return { matchedCount: result.changes, modifiedCount: result.changes };
  }

  // ── CRUD: Replace ──────────────────────────────────────────────────────────

  async replaceOne(
    filter: FilterExpr,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<TDbUpdateResult> {
    const where = buildWhere(filter);
    const tableName = this.resolveTableName();
    const versionColumn = this._table.versionColumn;
    // Use UPDATE (set all columns) instead of DELETE+INSERT to avoid triggering CASCADE deletes
    const limitedWhere = {
      sql: `rowid = (SELECT rowid FROM "${esc(tableName)}" WHERE ${where.sql} LIMIT 1)`,
      params: where.params,
    };
    const { sql, params } = buildUpdate(
      tableName,
      data,
      limitedWhere,
      undefined,
      versionColumn,
      expectedVersion,
    );
    this._log(sql, params);
    const result = this._wrapConstraintError(() => this.driver.run(sql, params));
    return { matchedCount: result.changes, modifiedCount: result.changes };
  }

  async replaceMany(filter: FilterExpr, data: Record<string, unknown>): Promise<TDbUpdateResult> {
    // For replaceMany we do a full UPDATE (set all columns)
    const where = buildWhere(filter);
    const versionColumn = this._table.versionColumn;
    const { sql, params } = buildUpdate(
      this.resolveTableName(),
      data,
      where,
      undefined,
      versionColumn,
    );
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
      { typeMapper: (field) => this.typeMapper(field) },
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

    // Drop FTS / vec shadow tables before rebuild — syncIndexes() will recreate them
    this._dropAllFtsTables(tableName);
    this._dropAllVecTables(tableName);

    // Disable FK checks during recreation — referenced tables may be mid-sync
    this.driver.exec("PRAGMA foreign_keys = OFF");
    this.driver.exec("PRAGMA legacy_alter_table = ON");
    try {
      // 1. Create new table with temp name
      const createSql = buildCreateTable(
        tempName,
        this._table.fieldDescriptors,
        this._table.foreignKeys,
        { typeMapper: (field) => this.typeMapper(field) },
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
    this._dropAllVecTables(tableName);
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

  async dropIndexesForColumns(columns: string[]): Promise<void> {
    const tableName = this.resolveTableName();
    const dropped = new Set(columns);
    const indexes = this.driver
      .all<{ name: string }>(`PRAGMA index_list("${esc(tableName)}")`)
      .filter((i) => i.name.startsWith("atscript__"));
    for (const index of indexes) {
      const cols = this.driver.all<{ name: string | null }>(
        `PRAGMA index_info("${esc(index.name)}")`,
      );
      if (cols.some((c) => c.name !== null && dropped.has(c.name))) {
        const sql = `DROP INDEX IF EXISTS "${esc(index.name)}"`;
        this._log(sql);
        this.driver.exec(sql);
      }
    }

    // FTS5 shadow tables: their sync triggers reference indexed columns as
    // new."col"/old."col", which makes SQLite reject the column drop. Drop
    // any FTS artifacts touching a dropped column — _syncFtsIndexes recreates
    // (and rebuilds) whatever the model still declares.
    for (const name of this._listShadowTables(tableName, "fts")) {
      const cols = this.driver.all<{ name: string }>(`PRAGMA table_info("${esc(name)}")`);
      if (cols.some((c) => dropped.has(c.name))) {
        this._dropFtsTable(name);
      }
    }

    // vec0 shadow tables: same trigger problem. The source column appears only
    // in the trigger SQL (the vec table's own column is always "embedding"),
    // so match against the AFTER INSERT trigger body.
    for (const name of this._listShadowTables(tableName, "vec")) {
      const trigger = this.driver.all<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?`,
        [`${name}__ai`],
      );
      const triggerSql = trigger[0]?.sql ?? "";
      if (columns.some((c) => triggerSql.includes(`"${esc(c)}"`))) {
        this._dropVecTable(name);
      }
    }
  }

  async dropTableByName(tableName: string): Promise<void> {
    this._dropAllFtsTables(tableName);
    this._dropAllVecTables(tableName);
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

  typeMapper(field: TDbFieldMeta): string {
    if (field.encrypted) {
      // Ciphertext envelope: unbounded text, plaintext-length-dependent.
      return "TEXT";
    }
    if (this._vectorFields.has(field.path)) {
      return this._detectVectorSupport() ? "BLOB" : "TEXT";
    }
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
          .filter((i) => !i.name.startsWith("sqlite_"))
          .map((i) => ({
            name: i.name,
            columns: this.driver
              .all<{ name: string | null }>(`PRAGMA index_info("${esc(i.name)}")`)
              .map((c) => c.name)
              .filter((n): n is string => n !== null),
          })),
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
      // Geo indexes are MongoDB-only in v1 (geo-index spec §5.2) — declared
      // models stay portable; sync warns and skips instead of erroring.
      warnUnsupportedTypes: { adapter: "sqlite", types: ["geo"] },
    });

    // Sync FTS5 virtual tables for fulltext indexes
    this._syncFtsIndexes(tableName);

    this._syncVecIndexes(tableName);
  }

  // ── FTS5 Full-Text Search ─────────────────────────────────────────────────

  override getSearchIndexes(): TSearchIndexInfo[] {
    const indexes: TSearchIndexInfo[] = [];
    for (const idx of this._getFulltextIndexes()) {
      indexes.push({
        name: idx.name,
        description: `FTS5 index (${idx.fields.map((f) => f.name).join(", ")})`,
        type: "text",
      });
    }
    for (const [field, vec] of this._vectorFields) {
      indexes.push({
        name: vec.indexName,
        description: `vec0 index on ${field} (${vec.dimensions}, ${vec.similarity})`,
        type: "vector",
      });
    }
    return indexes;
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

  /** Lists FTS5/vec0 shadow virtual tables for a content table. */
  private _listShadowTables(tableName: string, kind: "fts" | "vec"): string[] {
    return this.driver
      .all<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE ?`,
        [`${tableName}__${kind}__%`],
      )
      .filter((r) => r.sql.startsWith("CREATE VIRTUAL TABLE"))
      .map((r) => r.name);
  }

  /** Drops all FTS virtual tables and triggers for a content table. */
  private _dropAllFtsTables(tableName: string): void {
    for (const name of this._listShadowTables(tableName, "fts")) {
      this._dropFtsTable(name);
    }
  }

  // ── Vector search ─────────────────────────────────────────────────────────

  // vec0 only filters natively on partition keys; residual filters and the
  // threshold are applied after the KNN window, so over-fetch candidates to
  // refill page slots that post-filtering drops. Approximate count carries
  // the same caveat (mirrors pgvector).
  private static readonly _RESIDUAL_OVERFETCH = 4;

  override async vectorSearch(
    vector: number[],
    query: DbQuery,
    indexName?: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (!this._detectVectorSupport()) {
      throw new Error(
        "Vector search requires the sqlite-vec extension. Construct BetterSqlite3Driver with { vector: true }.",
      );
    }
    const base = this._buildVectorSearchBase(vector, query, indexName);
    return this._runVectorSearch(base);
  }

  override async vectorSearchWithCount(
    vector: number[],
    query: DbQuery,
    indexName?: string,
  ): Promise<{ data: Array<Record<string, unknown>>; count: number }> {
    if (!this._detectVectorSupport()) {
      throw new Error(
        "Vector search requires the sqlite-vec extension. Construct BetterSqlite3Driver with { vector: true }.",
      );
    }
    const base = this._buildVectorSearchBase(vector, query, indexName);
    const data = this._runVectorSearch(base);
    const countSql = `SELECT COUNT(*) AS cnt ${base.fromWhere}`;
    this._log(countSql, base.params);
    const row = this.driver.get<{ cnt: number }>(countSql, base.params);
    return { data, count: row?.cnt ?? 0 };
  }

  private _runVectorSearch(base: {
    fromWhere: string;
    params: unknown[];
    limit: number;
    skip: number;
  }): Array<Record<string, unknown>> {
    let sql = `SELECT * ${base.fromWhere} ORDER BY _distance ASC LIMIT ?`;
    const params = [...base.params, base.limit];
    if (base.skip > 0) {
      sql += ` OFFSET ?`;
      params.push(base.skip);
    }
    this._log(sql, params);
    return this.driver.all(sql, params);
  }

  /** Resolves a vector index (by name or first available) and its partition fields. */
  private _resolveVectorIndex(indexName?: string): {
    field: string;
    vec: { dimensions: number; similarity: string; indexName: string };
    partitionPhysicalNames: Set<string>;
  } {
    let entry: [string, { dimensions: number; similarity: string; indexName: string }] | undefined;
    if (indexName) {
      for (const [f, v] of this._vectorFields) {
        if (v.indexName === indexName) {
          entry = [f, v];
          break;
        }
      }
      if (!entry) {
        throw new Error(`Vector index "${indexName}" not found`);
      }
    } else {
      const first = this._vectorFields.entries().next();
      if (first.done) {
        throw new Error("No vector fields defined");
      }
      entry = first.value;
    }
    const [field, vec] = entry;
    const partitionPhysicalNames = new Set<string>();
    for (const logicalPath of this._vectorPartitionFields.get(vec.indexName) ?? []) {
      const descriptor = this._table.fieldDescriptors.find((f) => f.path === logicalPath);
      partitionPhysicalNames.add(descriptor?.physicalName ?? logicalPath);
    }
    return { field, vec, partitionPhysicalNames };
  }

  /** Query-time `$threshold` overrides the schema-level threshold (mirrors postgres precedence). */
  private _resolveVectorThreshold(
    controls: Record<string, unknown>,
    indexName: string,
  ): number | undefined {
    const queryThreshold = controls.$threshold as number | undefined;
    if (queryThreshold !== undefined) {
      return queryThreshold;
    }
    return this._vectorThresholds.get(indexName);
  }

  /**
   * Splits the (already physical-name) filter into partition equality push-down
   * vs. residual filter. Only top-level primitive equality is pushed down.
   */
  private _splitVectorFilter(
    filter: FilterExpr,
    partitionPhysicalNames: Set<string>,
  ): { partition: Array<{ name: string; value: unknown }>; residual: FilterExpr } {
    const partition: Array<{ name: string; value: unknown }> = [];
    const residual: Record<string, unknown> = {};
    if (!filter || typeof filter !== "object") {
      return { partition, residual: filter };
    }
    for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
      const isPushable =
        partitionPhysicalNames.has(key) &&
        value !== null &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "bigint");
      if (isPushable) {
        partition.push({ name: key, value });
      } else {
        residual[key] = value;
      }
    }
    return { partition, residual: residual as FilterExpr };
  }

  /**
   * Builds the shared FROM+WHERE fragment for vec0 KNN queries (without ORDER/LIMIT).
   * Both `vectorSearch` and `vectorSearchWithCount` reuse this — the former appends
   * ORDER BY + LIMIT/OFFSET, the latter wraps it in a COUNT(*).
   */
  private _buildVectorSearchBase(
    vector: number[],
    query: DbQuery,
    indexName?: string,
  ): { fromWhere: string; params: unknown[]; limit: number; skip: number } {
    const { vec, partitionPhysicalNames } = this._resolveVectorIndex(indexName);
    if (vector.length !== vec.dimensions) {
      throw new Error(
        `Vector dimension mismatch: index "${vec.indexName}" expects ${vec.dimensions}, got ${vector.length}`,
      );
    }
    const vecBuf = Buffer.from(new Float32Array(vector).buffer);

    const controls = (query.controls || {}) as Record<string, unknown>;
    const limit = (controls.$limit as number | undefined) ?? 20;
    const skip = (controls.$skip as number | undefined) ?? 0;
    const threshold = this._resolveVectorThreshold(controls, vec.indexName);

    const { partition, residual } = this._splitVectorFilter(query.filter, partitionPhysicalNames);
    const residualWhere = buildPrefixedWhere("_vs", residual);
    const hasResidual = residualWhere.sql !== "1=1";
    const hasThreshold = threshold !== undefined;

    const k =
      (limit + skip) * (hasResidual || hasThreshold ? SqliteAdapter._RESIDUAL_OVERFETCH : 1);

    const tableName = this.resolveTableName();
    const vecTable = this._vecTableName(vec.indexName);

    const innerWhereParts = ["v.embedding MATCH ?", "v.k = ?"];
    const params: unknown[] = [vecBuf, k];
    for (const p of partition) {
      innerWhereParts.push(`v."${esc(p.name)}" = ?`);
      params.push(p.value);
    }

    const inner = `SELECT t.*, v.distance AS _distance FROM "${esc(vecTable)}" v JOIN "${esc(tableName)}" t ON t.rowid = v.rowid WHERE ${innerWhereParts.join(" AND ")}`;
    let fromWhere = `FROM (${inner}) _vs`;

    const outerWhereParts: string[] = [];
    if (hasThreshold) {
      outerWhereParts.push(`_distance <= ?`);
      params.push(thresholdToVecDistance(threshold, vec.similarity));
    }
    if (hasResidual) {
      outerWhereParts.push(`(${residualWhere.sql})`);
      params.push(...residualWhere.params);
    }
    if (outerWhereParts.length > 0) {
      fromWhere += ` WHERE ${outerWhereParts.join(" AND ")}`;
    }

    return { fromWhere, params, limit, skip };
  }

  // ── Vector search internals ───────────────────────────────────────────────

  /** Builds vec0 shadow table name from index name: `<table>__vec__<indexName>`. */
  private _vecTableName(indexName: string): string {
    return `${this.resolveTableName()}__vec__${indexName}`;
  }

  /**
   * Creates/drops vec0 virtual shadow tables and sync triggers to match desired vector fields.
   */
  private _syncVecIndexes(tableName: string): void {
    if (this._vectorFields.size === 0) {
      return;
    }
    if (!this._detectVectorSupport()) {
      this._log(
        "[atscript-db-sqlite] sqlite-vec not available, skipping vec0 shadow table sync (vector fields stored as JSON)",
      );
      return;
    }

    const desiredVecTables = new Map<
      string,
      { field: string; meta: { dimensions: number; similarity: string; indexName: string } }
    >();
    for (const [fieldPath, meta] of this._vectorFields.entries()) {
      desiredVecTables.set(this._vecTableName(meta.indexName), { field: fieldPath, meta });
    }

    const existingVec = this.driver
      .all<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE ?`,
        [`${tableName}__vec__%`],
      )
      .filter((r) => r.sql.startsWith("CREATE VIRTUAL TABLE"))
      .map((r) => r.name);

    for (const name of existingVec) {
      if (!desiredVecTables.has(name)) {
        this._dropVecTable(name);
      }
    }

    const existingSet = new Set(existingVec);
    for (const [vecTable, { field, meta }] of desiredVecTables.entries()) {
      if (!existingSet.has(vecTable)) {
        this._createVecTable(tableName, vecTable, field, meta);
      }
    }
  }

  /** Creates a vec0 virtual shadow table with sync triggers and seeds it from existing rows. */
  private _createVecTable(
    tableName: string,
    vecTable: string,
    field: string,
    vec: { dimensions: number; similarity: string; indexName: string },
  ): void {
    const metric = similarityToVecMetric(vec.similarity);

    const embeddingDescriptor = this._table.fieldDescriptors.find((f) => f.path === field);
    const embeddingCol = embeddingDescriptor?.physicalName ?? field;

    const partitionFieldPaths = this._vectorPartitionFields.get(vec.indexName) ?? [];
    const partitionCols: Array<{ physicalName: string; sqlType: string }> = [];
    for (const logicalPath of partitionFieldPaths) {
      const descriptor = this._table.fieldDescriptors.find((f) => f.path === logicalPath);
      if (!descriptor) {
        this._log(
          `[atscript-db-sqlite] vec0 partition field "${logicalPath}" not found for index "${vec.indexName}", defaulting to TEXT`,
        );
        partitionCols.push({ physicalName: logicalPath, sqlType: "TEXT" });
      } else {
        partitionCols.push({
          physicalName: descriptor.physicalName,
          sqlType: this.typeMapper(descriptor),
        });
      }
    }

    // vec0's DDL parser rejects double-quoted partition column names, so they
    // must be emitted bare. Validate as a safe identifier here — `@db.column`
    // accepts arbitrary strings upstream, and bare interpolation would otherwise
    // open a SQL-injection hole on this one path.
    for (const c of partitionCols) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.physicalName)) {
        throw new Error(
          `vec0 partition column name "${c.physicalName}" is not a safe identifier (only [A-Za-z_][A-Za-z0-9_]* is allowed for @db.search.filter fields on SQLite).`,
        );
      }
    }
    const partitionDefs = partitionCols
      .map((c) => `${c.physicalName} ${c.sqlType} partition key`)
      .join(", ");
    const ddlCols = [partitionDefs, `embedding float[${vec.dimensions}] distance_metric=${metric}`]
      .filter(Boolean)
      .join(", ");

    const createSql = `CREATE VIRTUAL TABLE IF NOT EXISTS "${esc(vecTable)}" USING vec0(${ddlCols})`;
    this._log(createSql);
    this.driver.exec(createSql);

    const partCols = partitionCols.map((c) => `"${esc(c.physicalName)}"`);
    const embCol = `"${esc(embeddingCol)}"`;
    const insertCols = ["rowid", ...partCols, "embedding"].join(", ");
    const insertNewVals = [
      "new.rowid",
      ...partitionCols.map((c) => `new."${esc(c.physicalName)}"`),
      `new.${embCol}`,
    ].join(", ");
    const seedColList = ["rowid", ...partCols, embCol].join(", ");

    const ev = esc(vecTable);
    const et = esc(tableName);

    const aiSql = `CREATE TRIGGER IF NOT EXISTS "${esc(vecTable + "__ai")}" AFTER INSERT ON "${et}" WHEN new.${embCol} IS NOT NULL BEGIN INSERT INTO "${ev}"(${insertCols}) VALUES(${insertNewVals}); END`;
    this._log(aiSql);
    this.driver.exec(aiSql);

    const adSql = `CREATE TRIGGER IF NOT EXISTS "${esc(vecTable + "__ad")}" AFTER DELETE ON "${et}" BEGIN DELETE FROM "${ev}" WHERE rowid = old.rowid; END`;
    this._log(adSql);
    this.driver.exec(adSql);

    // vec0 lacks upsert, so AFTER UPDATE does delete-then-insert
    const auSql = `CREATE TRIGGER IF NOT EXISTS "${esc(vecTable + "__au")}" AFTER UPDATE ON "${et}" BEGIN DELETE FROM "${ev}" WHERE rowid = old.rowid; INSERT INTO "${ev}"(${insertCols}) SELECT ${insertNewVals} WHERE new.${embCol} IS NOT NULL; END`;
    this._log(auSql);
    this.driver.exec(auSql);

    const seedSql = `INSERT INTO "${ev}"(${insertCols}) SELECT ${seedColList} FROM "${et}" WHERE ${embCol} IS NOT NULL`;
    this._log(seedSql);
    this.driver.exec(seedSql);
  }

  /** Drops a vec0 virtual table and its sync triggers. */
  private _dropVecTable(vecTable: string): void {
    for (const suffix of ["__ai", "__ad", "__au"]) {
      this.driver.exec(`DROP TRIGGER IF EXISTS "${esc(vecTable + suffix)}"`);
    }
    const sql = `DROP TABLE IF EXISTS "${esc(vecTable)}"`;
    this._log(sql);
    this.driver.exec(sql);
  }

  /** Drops all vec0 virtual shadow tables and triggers for a content table. */
  private _dropAllVecTables(tableName: string): void {
    for (const name of this._listShadowTables(tableName, "vec")) {
      this._dropVecTable(name);
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
