import type { TDbCollation, TDbFieldMeta, TDbForeignKey, TFieldOps } from "@atscript/db";
import type { DbControls, TResolvedBucket } from "@atscript/db";
import type { AtscriptQueryFieldRef, TViewColumnMapping, TViewPlan } from "@atscript/db";
import type { SqlDialect, TGeoCircle, TSqlFragment } from "@atscript/db-sql-tools";
import {
  buildInsert as _buildInsert,
  buildInsertMany as _buildInsertMany,
  buildSelect as _buildSelect,
  buildUpdate as _buildUpdate,
  buildDelete as _buildDelete,
  buildCreateView as _buildCreateView,
  buildAggregateSelect as _buildAggregateSelect,
  buildAggregateCount as _buildAggregateCount,
  toSqlValue,
  sqlStringLiteral,
  sqlTimeZoneLiteral,
  refActionToSql,
  defaultValueForType,
  defaultValueToSqlLiteral,
  parseRegexString,
} from "@atscript/db-sql-tools";
import { BUCKET_MAX_INSTANT, BUCKET_MIN_INSTANT } from "@uniqu/core";

// Re-export shared utilities for consumers that import from this package
export { sqlStringLiteral, refActionToSql, defaultValueForType, defaultValueToSqlLiteral };

// ── MySQL table options (passed to buildCreateTable) ─────────────────────────

export interface TMysqlTableOptions {
  engine?: string;
  charset?: string;
  collation?: string;
  autoIncrementStart?: number;
  incrementFields?: ReadonlySet<string>;
  onUpdateFields?: ReadonlyMap<string, string>;
  /** Adapter type mapper (vector/encrypted folding). Falls back to `mysqlTypeFromField`. */
  typeMapper?: (field: TDbFieldMeta) => string;
  /**
   * Target tables whose inline FOREIGN KEY constraints are omitted (added by
   * `syncForeignKeys` once every member of a foreign-key cycle exists).
   * @since 0.1.128
   */
  deferForeignKeysTo?: ReadonlySet<string>;
}

// ── Column definitions (since 0.1.128) ──────────────────────────────────────

export interface TMysqlColumnContext {
  /** Physical names of `@db.default.increment` columns (→ AUTO_INCREMENT). */
  incrementFields?: ReadonlySet<string>;
  /** Physical name → ON UPDATE expression (`@db.mysql.onUpdate`). */
  onUpdateFields?: ReadonlyMap<string, string>;
  /** Adapter type mapper. Falls back to `mysqlTypeFromField`. */
  typeMapper?: (field: TDbFieldMeta) => string;
  /**
   * - `create`: column of a CREATE TABLE (PRIMARY KEY implies NOT NULL);
   * - `add`: ALTER TABLE … ADD COLUMN — never `AUTO_INCREMENT` (MySQL requires
   *   a key in the same statement; the primary-key rebuild re-declares the
   *   column with it); a required column without a model default gets an
   *   invented type default so existing rows can be filled
   *   (`inventedDefault: true`; the caller drops it right after);
   * - `modify`: ALTER TABLE … MODIFY COLUMN — the full definition, so
   *   DEFAULT / COLLATE / ON UPDATE / AUTO_INCREMENT are never lost.
   */
  purpose: "create" | "add" | "modify";
}

export interface TMysqlColumnDefinition {
  /** `` `name` TYPE [AUTO_INCREMENT] NULL|NOT NULL [DEFAULT …] [COLLATE …] [ON UPDATE …] `` */
  def: string;
  /** A type default was invented for a required, default-less column (`purpose: "add"`). */
  inventedDefault: boolean;
}

/** TEXT / BLOB families (`TINYTEXT` … `LONGBLOB`). */
const TEXT_BLOB_RE = /^(TINY|MEDIUM|LONG)?(TEXT|BLOB)\b/i;

/** Spatial types (`POINT SRID 4326`, `GEOMETRY`, `MULTI*`, …). */
const GEOMETRY_RE =
  /^(GEOMETRY|POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i;

/** TEXT/BLOB/JSON/GEOMETRY families only accept the expression form `DEFAULT (expr)` (MySQL ≥ 8.0.13). */
function needsExpressionDefault(sqlType: string): boolean {
  return TEXT_BLOB_RE.test(sqlType) || /^JSON\b/i.test(sqlType) || GEOMETRY_RE.test(sqlType);
}

/**
 * Renders a model value default for a column of `sqlType`: the SQL literal,
 * wrapped in the expression form for the types that require it.
 */
export function mysqlDefaultLiteral(sqlType: string, designType: string, value: string): string {
  const literal = defaultValueToSqlLiteral(designType, value);
  return needsExpressionDefault(sqlType) ? `(${literal})` : literal;
}

/**
 * Type-aware fallback value for a column that must get a value it has no
 * model default for (invented ADD default, NULL backfill before NOT NULL).
 * Every value is legal for its type under strict `sql_mode`.
 */
export function mysqlTypeDefault(sqlType: string, field: TDbFieldMeta): string {
  const type = sqlType.toUpperCase();
  if (type.startsWith("JSON")) {
    return "('{}')";
  }
  if (GEOMETRY_RE.test(type)) {
    return "(ST_SRID(POINT(0, 0), 4326))";
  }
  if (/^(TIMESTAMP|DATETIME)/.test(type)) {
    return "CURRENT_TIMESTAMP";
  }
  if (/^DATE\b/.test(type)) {
    return "'1970-01-01'";
  }
  if (/^YEAR\b/.test(type)) {
    return "1970";
  }
  if (/^TIME\b/.test(type)) {
    return "'00:00:00'";
  }
  if (TEXT_BLOB_RE.test(type)) {
    return "('')";
  }
  if (/^(VARCHAR|CHAR|VARBINARY|BINARY|ENUM|SET)\b/.test(type)) {
    return "''";
  }
  if (
    /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DOUBLE|FLOAT|DECIMAL|NUMERIC|REAL|BIT|BOOL)/.test(
      type,
    )
  ) {
    return "0";
  }
  return defaultValueForType(field.designType);
}

// ── Index key-length prefixes (since 0.1.128) ──────────────────────────────

/** InnoDB maximum index key part in bytes (ROW_FORMAT=DYNAMIC/COMPRESSED, the default since 5.7.7). */
export const MYSQL_MAX_KEY_PART_BYTES = 3072;

/** Prefix used for TEXT/BLOB key parts — unchanged from earlier releases so existing indexes keep their definition. */
export const MYSQL_TEXT_PREFIX = 255;

/** Bytes per character of a table charset (unknown charsets assume the widest, 4). */
export function mysqlBytesPerChar(charset: string | undefined): number {
  switch ((charset ?? "utf8mb4").toLowerCase()) {
    case "utf8mb4": {
      return 4;
    }
    case "utf8":
    case "utf8mb3": {
      return 3;
    }
    case "latin1":
    case "ascii":
    case "binary": {
      return 1;
    }
    default: {
      return 4;
    }
  }
}

/** Declared character length of a `CHAR(n)` / `VARCHAR(n)` mapped type, else `undefined`. */
export function mysqlCharLength(mappedType: string): number | undefined {
  const m = /^(?:VAR)?CHAR\((\d+)\)/i.exec(mappedType.trim());
  return m ? Number(m[1]) : undefined;
}

/**
 * Key-length prefix a plain/unique index needs for a column of `mappedType`:
 * - `CHAR(n)` / `VARCHAR(n)` within the key-part limit (3072 bytes ÷ bytes per
 *   char: 768 chars on utf8mb4) → no prefix; longer → the full limit (a
 *   shorter constant would needlessly weaken uniqueness);
 * - `BINARY(n)` / `VARBINARY(n)` → same rule with 1 byte per char;
 * - TEXT / BLOB families → 255 (a prefix is mandatory);
 * - everything else (numeric, ENUM, JSON, VECTOR, geometry, …) → never.
 */
export function mysqlIndexPrefix(mappedType: string, bytesPerChar: number): number | undefined {
  const type = mappedType.trim().toUpperCase();
  const chars = mysqlCharLength(type);
  if (chars !== undefined) {
    const limit = Math.floor(MYSQL_MAX_KEY_PART_BYTES / bytesPerChar);
    return chars <= limit ? undefined : limit;
  }
  const bin = /^(?:VAR)?BINARY\((\d+)\)/.exec(type);
  if (bin) {
    return Number(bin[1]) <= MYSQL_MAX_KEY_PART_BYTES ? undefined : MYSQL_MAX_KEY_PART_BYTES;
  }
  if (TEXT_BLOB_RE.test(type)) {
    return MYSQL_TEXT_PREFIX;
  }
  return undefined;
}

/**
 * The ONE column-definition renderer for CREATE TABLE, ADD COLUMN and MODIFY
 * COLUMN. Rules:
 * 1. type from the adapter mapper (vector/encrypted folding);
 * 2. `AUTO_INCREMENT` for `@db.default.increment` columns on `create` and
 *    `modify` — never on `add` (ER 1075 without a key; `rebuildPrimaryKey`
 *    owns the columns entering the key and re-declares them);
 * 3. nullability — `create`: as MySQL infers it (PRIMARY KEY / AUTO_INCREMENT
 *    imply NOT NULL); `add`/`modify`: always explicit (`NULL` matters for
 *    TIMESTAMP under `explicit_defaults_for_timestamp=OFF`, and MySQL rejects
 *    an explicit `NULL` on a key column, so key columns say NOT NULL);
 * 4. DEFAULT — a model default only; NEVER `DEFAULT NULL` (it is the implicit
 *    default of a nullable column, and `NOT NULL DEFAULT NULL` is ER 1067);
 *    expression form for TEXT/BLOB/JSON/GEOMETRY; invented type default for a
 *    required default-less column on `add`;
 * 5. COLLATE (native `@db.mysql.collate` or portable `@db.column.collate`);
 * 6. ON UPDATE.
 */
export function buildColumnDefinition(
  field: TDbFieldMeta,
  ctx: TMysqlColumnContext,
): TMysqlColumnDefinition {
  const sqlType = ctx.typeMapper?.(field) ?? mysqlTypeFromField(field);
  const increment =
    ctx.purpose !== "add" && (ctx.incrementFields?.has(field.physicalName) ?? false);
  let def = `${qi(field.physicalName)} ${sqlType}`;

  if (increment) {
    def += " AUTO_INCREMENT";
  }

  if (ctx.purpose === "create") {
    if (!field.optional && !field.isPrimaryKey && !increment) {
      def += " NOT NULL";
    }
  } else {
    def += !field.optional || field.isPrimaryKey || increment ? " NOT NULL" : " NULL";
  }

  let inventedDefault = false;
  if (field.defaultValue?.kind === "value") {
    def += ` DEFAULT ${mysqlDefaultLiteral(sqlType, field.designType, field.defaultValue.value)}`;
  } else if (field.defaultValue?.kind === "fn") {
    // DB-level defaults for uuid and now; increment is AUTO_INCREMENT above
    if (field.defaultValue.fn === "uuid") {
      def += " DEFAULT (UUID())";
    } else if (field.defaultValue.fn === "now") {
      def += " DEFAULT CURRENT_TIMESTAMP";
    }
  } else if (
    ctx.purpose === "add" &&
    !field.optional &&
    !field.isPrimaryKey &&
    !increment &&
    !/^VECTOR\b/i.test(sqlType)
  ) {
    def += ` DEFAULT ${mysqlTypeDefault(sqlType, field)}`;
    inventedDefault = true;
  }

  const nativeCollate = field.type?.metadata?.get("db.mysql.collate") as string | undefined;
  if (nativeCollate) {
    def += ` COLLATE ${nativeCollate}`;
  } else if (field.collate) {
    def += ` COLLATE ${collationToMysql(field.collate)}`;
  }

  const onUpdate = ctx.onUpdateFields?.get(field.physicalName);
  if (onUpdate) {
    def += ` ON UPDATE ${onUpdate}`;
  }

  return { def, inventedDefault };
}

// ── Identifier quoting ──────────────────────────────────────────────────────

/** Escapes a MySQL identifier by doubling backticks. */
export function esc(name: string): string {
  return name.replace(/`/g, "``");
}

/** Backtick-quotes a single identifier. */
export function qi(name: string): string {
  return `\`${esc(name)}\``;
}

/**
 * Backtick-quotes a table name, handling `schema.table` format.
 * Input is a raw name like `mydb.users` or just `users`.
 */
export function quoteTableName(name: string): string {
  const dot = name.indexOf(".");
  if (dot >= 0) {
    return `${qi(name.slice(0, dot))}.${qi(name.slice(dot + 1))}`;
  }
  return qi(name);
}

// ── MySQL dialect ───────────────────────────────────────────────────────────

export const mysqlDialect: SqlDialect = {
  quoteIdentifier(name: string) {
    return qi(name);
  },
  quoteTable(name: string) {
    return quoteTableName(name);
  },
  unlimitedLimit: "18446744073709551615",
  toValue: toSqlValue,
  toParam(value: unknown) {
    if (value === undefined) {
      return null;
    }
    return typeof value === "boolean" ? (value ? 1 : 0) : value;
  },
  regex(quotedCol: string, value: unknown): TSqlFragment {
    // Flags are ignored — MySQL REGEXP case-sensitivity is determined by column collation
    const { pattern } = parseRegexString(value);
    return { sql: `${quotedCol} REGEXP ?`, params: [pattern] };
  },
  // Spherical circle search on a POINT SRID 4326 column. POINT(x, y) builds
  // the query point in MySQL's internal axis order (x=lng, y=lat — the SRS
  // lat-lng axis order applies only to WKT/WKB import/export).
  geoWithin(quotedCol: string, circle: TGeoCircle): TSqlFragment {
    const dist = mysqlGeoDistanceExpr(quotedCol, circle.center);
    return { sql: `${dist.sql} <= ?`, params: [...dist.params, circle.radius] };
  },
  calendarBucket: mysqlCalendarBucket,
  // Why MySQL needs it: see `SqlDialect.bucketAliasInHaving`.
  bucketAliasInHaving: true,
  createViewPrefix: "CREATE OR REPLACE VIEW",
};

// ── Calendar buckets ────────────────────────────────────────────────────────

/**
 * Whether a field is stored as a native MySQL `TIMESTAMP`: a `number` with
 * `@db.default.now`. The adapter writes such values as UTC
 * `'YYYY-MM-DD HH:MM:SS'` strings and reads them back as epoch ms; every other
 * numeric timestamp is a DOUBLE / BIGINT epoch-ms column.
 */
export function isMysqlTimestampColumn(fd: TDbFieldMeta): boolean {
  return (
    fd.designType === "number" && fd.defaultValue?.kind === "fn" && fd.defaultValue.fn === "now"
  );
}

/** `'1970-01-01 00:00:00'` as a DATETIME: the base for epoch arithmetic free of the session zone. */
const MYSQL_EPOCH = "CAST('1970-01-01 00:00:00' AS DATETIME)";

/**
 * Calendar-bucket label: TEXT `'YYYY-MM-DD'` — the local date of the
 * bucket's first day in `b.tz` — or NULL for a NULL source or one outside
 * `[BUCKET_MIN_INSTANT, BUCKET_MAX_INSTANT)`.
 *
 * The source's UTC wall time `U` (a DATETIME) depends on storage:
 * - DOUBLE / BIGINT epoch ms: `epoch + INTERVAL FLOOR(col / 1000) SECOND`
 *   (never `FROM_UNIXTIME`, which converts to the session zone);
 * - native `TIMESTAMP` ({@link isMysqlTimestampColumn}): `CAST(col AS DATETIME)`
 *   — the session-zone rendering, which is exactly the UTC string the adapter
 *   wrote and parses back on read, so the label agrees with the value reads
 *   return whatever the server's session zone is (`UNIX_TIMESTAMP(col)` would
 *   agree only under a UTC session zone).
 *
 * The local date is `DATE(CONVERT_TZ(U, '+00:00', '<tz>'))`, or `DATE(U)` for
 * `UTC` (no time zone tables needed). Truncation is calendar arithmetic on
 * that date. `CONVERT_TZ` returns NULL when the zone is unknown to the
 * server and its input unchanged outside its range — `MysqlAdapter` probes
 * each zone before running the query (`BUCKET_TZ_UNAVAILABLE`).
 *
 * Parameter-free (the zone is an inlined, charset-checked literal), so the
 * SELECT and GROUP BY renderings are identical (`ONLY_FULL_GROUP_BY`).
 */
export function mysqlCalendarBucket(quotedCol: string, b: TResolvedBucket): string {
  let utc: string;
  let inRange: string;
  if (isMysqlTimestampColumn(b.fd)) {
    utc = `CAST(${quotedCol} AS DATETIME)`;
    // TIMESTAMP storage ends in 2038, far below BUCKET_MAX_INSTANT.
    inRange = `${utc} >= '1970-01-02 00:00:00'`;
  } else {
    utc = `(${MYSQL_EPOCH} + INTERVAL FLOOR(${quotedCol} / 1000) SECOND)`;
    inRange = `${quotedCol} >= ${BUCKET_MIN_INSTANT} AND ${quotedCol} < ${BUCKET_MAX_INSTANT}`;
  }
  const local =
    b.tz === "UTC"
      ? `DATE(${utc})`
      : `DATE(CONVERT_TZ(${utc}, '+00:00', ${sqlTimeZoneLiteral(b.tz)}))`;
  let first: string;
  switch (b.unit) {
    case "day": {
      first = local;
      break;
    }
    case "week": {
      // WEEKDAY: 0 = Monday, so WEEKDAY + 1 is the ISO weekday
      first = `DATE_SUB(${local}, INTERVAL ((WEEKDAY(${local}) + 1 - ${b.weekStartIso} + 7) % 7) DAY)`;
      break;
    }
    case "month": {
      first = `DATE_SUB(${local}, INTERVAL DAYOFMONTH(${local}) - 1 DAY)`;
      break;
    }
    case "quarter": {
      first = `(MAKEDATE(YEAR(${local}), 1) + INTERVAL (QUARTER(${local}) - 1) QUARTER)`;
      break;
    }
    default: {
      // year
      first = `MAKEDATE(YEAR(${local}), 1)`;
    }
  }
  return `CASE WHEN ${inRange} THEN DATE_FORMAT(${first}, '%Y-%m-%d') END`;
}

// ── Geo helpers (native POINT SRID 4326) ────────────────────────────────────

/**
 * Spherical distance in meters from a POINT column to a query point.
 * Used as the `distExpr` of the shared geo search builder.
 */
export function mysqlGeoDistanceExpr(quotedCol: string, point: [number, number]): TSqlFragment {
  return {
    sql: `ST_Distance_Sphere(${quotedCol}, ST_SRID(POINT(?, ?), 4326))`,
    params: [point[0], point[1]],
  };
}

/**
 * Encodes a `[lng, lat]` tuple in MySQL's internal geometry format
 * (4-byte SRID LE + WKB point) — geometry columns accept it directly as a
 * binary parameter, bypassing the WKT/WKB axis-order pitfalls entirely.
 */
export function geoPointToMysqlInternal(point: [number, number]): Buffer {
  const buf = Buffer.alloc(25);
  buf.writeUInt32LE(4326, 0);
  buf.writeUInt8(1, 4); // little-endian flag
  buf.writeUInt32LE(1, 5); // geometry type: point
  buf.writeDoubleLE(point[0], 9); // x = longitude (internal storage order)
  buf.writeDoubleLE(point[1], 17); // y = latitude
  return buf;
}

/**
 * Decodes a geo read value back to `[lng, lat]`. The mysql2 driver parses
 * POINT columns to `{x, y}` objects (internal order: x=lng, y=lat); raw
 * internal-format buffers are handled for drivers that don't.
 */
export function mysqlGeoValueToPoint(value: unknown): [number, number] | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { x?: unknown }).x === "number" &&
    typeof (value as { y?: unknown }).y === "number"
  ) {
    return [(value as { x: number }).x, (value as { y: number }).y];
  }
  if (value instanceof Uint8Array && value.length >= 25) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const littleEndian = buf.readUInt8(4) === 1;
    const type = littleEndian ? buf.readUInt32LE(5) : buf.readUInt32BE(5);
    if ((type & 0xff) === 1) {
      const x = littleEndian ? buf.readDoubleLE(9) : buf.readDoubleBE(9);
      const y = littleEndian ? buf.readDoubleLE(17) : buf.readDoubleBE(17);
      return [x, y];
    }
  }
  return undefined;
}

// ── Pre-bound DML builders ──────────────────────────────────────────────────

/**
 * Builds an INSERT statement.
 */
export function buildInsert(table: string, data: Record<string, unknown>): TSqlFragment {
  return _buildInsert(mysqlDialect, table, data);
}

/** Multi-row INSERT over `columns` (a missing column → `DEFAULT`). */
export function buildInsertMany(
  table: string,
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): TSqlFragment {
  return _buildInsertMany(mysqlDialect, table, rows, columns);
}

/**
 * Builds a SELECT statement with optional sort, limit, offset, projection.
 */
export function buildSelect(
  table: string,
  where: TSqlFragment,
  controls?: DbControls,
): TSqlFragment {
  return _buildSelect(mysqlDialect, table, where, controls);
}

/**
 * Builds an UPDATE ... SET ... WHERE statement with optional LIMIT.
 */
export function buildUpdate(
  table: string,
  data: Record<string, unknown>,
  where: TSqlFragment,
  limit?: number,
  ops?: TFieldOps,
  versionColumn?: string,
  expectedVersion?: number,
): TSqlFragment {
  return _buildUpdate(mysqlDialect, table, data, where, limit, ops, versionColumn, expectedVersion);
}

/**
 * Builds a DELETE ... WHERE statement with optional LIMIT.
 */
export function buildDelete(table: string, where: TSqlFragment, limit?: number): TSqlFragment {
  return _buildDelete(mysqlDialect, table, where, limit);
}

/**
 * Builds a CREATE OR REPLACE VIEW statement from a view plan and column mappings.
 */
export function buildCreateView(
  viewName: string,
  plan: TViewPlan,
  columns: TViewColumnMapping[],
  resolveFieldRef: (ref: AtscriptQueryFieldRef) => string,
): string {
  return _buildCreateView(mysqlDialect, viewName, plan, columns, resolveFieldRef);
}

/**
 * Builds a SELECT ... GROUP BY statement with aggregate functions.
 */
export function buildAggregateSelect(
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  return _buildAggregateSelect(mysqlDialect, table, where, controls);
}

/**
 * Builds a COUNT query for the number of distinct groups.
 */
export function buildAggregateCount(
  table: string,
  where: TSqlFragment,
  controls: DbControls,
): TSqlFragment {
  return _buildAggregateCount(mysqlDialect, table, where, controls);
}

// ── MySQL-specific ──────────────────────────────────────────────────────────

/**
 * Maps portable collation values to MySQL collation names.
 */
export function collationToMysql(collation: TDbCollation): string {
  switch (collation) {
    case "binary": {
      return "utf8mb4_bin";
    }
    case "nocase": {
      return "utf8mb4_general_ci";
    }
    case "unicode": {
      return "utf8mb4_unicode_ci";
    }
    default: {
      return "utf8mb4_unicode_ci";
    }
  }
}

/**
 * Maps an Atscript field descriptor to a MySQL column type.
 *
 * Reads `designType`, primitive tags (via `type.type.tags`), and annotations
 * from field metadata to produce the most specific MySQL type.
 *
 * For FK fields, delegates to the target PK's type via `field.fkTargetField`
 * so the FK column type always matches the referenced column.
 */
/** Maps integer primitive tags to MySQL integer types. */
function intTypeFromTags(tags: Set<string> | undefined, unsigned: boolean): string {
  if (tags?.has("int8")) {
    return unsigned ? "TINYINT UNSIGNED" : "TINYINT";
  }
  if (tags?.has("uint8") || tags?.has("byte")) {
    return "TINYINT UNSIGNED";
  }
  if (tags?.has("int16")) {
    return unsigned ? "SMALLINT UNSIGNED" : "SMALLINT";
  }
  if (tags?.has("uint16") || tags?.has("port")) {
    return "SMALLINT UNSIGNED";
  }
  if (tags?.has("int32")) {
    return unsigned ? "INT UNSIGNED" : "INT";
  }
  if (tags?.has("uint32")) {
    return "INT UNSIGNED";
  }
  if (tags?.has("int64")) {
    return unsigned ? "BIGINT UNSIGNED" : "BIGINT";
  }
  if (tags?.has("uint64")) {
    return "BIGINT UNSIGNED";
  }
  return unsigned ? "INT UNSIGNED" : "INT";
}

export function mysqlTypeFromField(field: TDbFieldMeta): string {
  // FK fields inherit their DB type from the referenced target column
  if (field.fkTargetField) {
    return mysqlTypeFromField(field.fkTargetField);
  }

  const tags = field.type?.type?.tags as Set<string> | undefined;
  const metadata = field.type?.metadata;

  // MySQL-specific type override: @db.mysql.type "MEDIUMTEXT"
  const mysqlTypeOverride = metadata?.get("db.mysql.type") as string | undefined;
  if (mysqlTypeOverride) {
    return mysqlTypeOverride;
  }

  // db.geoPoint → native geographic point (encrypted geo keeps its envelope type)
  if (field.isGeoPoint && !field.encrypted) {
    return "POINT SRID 4326";
  }

  // Unsigned modifier: @db.mysql.unsigned
  const unsigned = metadata?.has("db.mysql.unsigned") ?? false;

  // Precision for decimals: @db.column.precision 10, 2
  const precision = metadata?.get("db.column.precision") as
    | { precision: number; scale: number }
    | undefined;

  switch (field.designType) {
    case "number": {
      if (precision) {
        return `DECIMAL(${precision.precision},${precision.scale})`;
      }
      // AUTO_INCREMENT requires an integer type — DOUBLE is invalid
      if (field.defaultValue?.kind === "fn" && field.defaultValue.fn === "increment") {
        return unsigned ? "BIGINT UNSIGNED" : "BIGINT";
      }
      // @db.default.now fields are timestamps, not floats
      if (isMysqlTimestampColumn(field)) {
        return "TIMESTAMP";
      }
      // number.int has designType "number" but carries the "int" tag —
      // delegate to integer type logic for sized int tags and unsigned
      if (tags?.has("int")) {
        return intTypeFromTags(tags, unsigned);
      }
      return "DOUBLE";
    }
    case "integer": {
      return intTypeFromTags(tags, unsigned);
    }
    case "decimal": {
      if (precision) {
        return `DECIMAL(${precision.precision},${precision.scale})`;
      }
      return "DECIMAL(10,2)";
    }
    case "boolean": {
      return "TINYINT(1)";
    }
    case "string": {
      // char primitive → CHAR(1)
      if (tags?.has("char")) {
        return "CHAR(1)";
      }
      // Check maxLength annotation to decide VARCHAR vs TEXT
      // Compiled format: { length: number; message?: string }
      const maxLen = (metadata?.get("expect.maxLength") as { length: number } | undefined)?.length;
      if (maxLen !== undefined && maxLen <= 65535) {
        return `VARCHAR(${maxLen})`;
      }
      if (maxLen !== undefined && maxLen > 65535) {
        return "LONGTEXT";
      }
      // MySQL requires VARCHAR for primary keys and columns with DEFAULT values
      if (field.isPrimaryKey || field.defaultValue) {
        return "VARCHAR(255)";
      }
      return "TEXT";
    }
    case "json":
    case "object":
    case "array": {
      return "JSON";
    }
    default: {
      if (field.isPrimaryKey || field.defaultValue) {
        return "VARCHAR(255)";
      }
      return "TEXT";
    }
  }
}

/**
 * Builds a CREATE TABLE IF NOT EXISTS statement with MySQL options.
 */
export function buildCreateTable(
  table: string,
  fields: readonly TDbFieldMeta[],
  foreignKeys?: ReadonlyMap<string, TDbForeignKey>,
  options?: TMysqlTableOptions,
): string {
  const primaryKeys = fields.filter((f) => f.isPrimaryKey);
  const ctx: TMysqlColumnContext = {
    incrementFields: options?.incrementFields,
    onUpdateFields: options?.onUpdateFields,
    typeMapper: options?.typeMapper,
    purpose: "create",
  };

  const colDefs = fields
    .filter((f) => !f.ignored)
    .map((f) => ({ name: f.physicalName, def: buildColumnDefinition(f, ctx).def }));
  const constraints: string[] = [];

  // Primary key constraint
  if (primaryKeys.length === 1) {
    const pk = colDefs.find((c) => c.name === primaryKeys[0].physicalName);
    if (pk) {
      pk.def += " PRIMARY KEY";
    }
  } else if (primaryKeys.length > 1) {
    const pkCols = primaryKeys.map((pk) => qi(pk.physicalName)).join(", ");
    constraints.push(`PRIMARY KEY (${pkCols})`);
  }

  // Foreign key constraints — members of a foreign-key cycle are created
  // without the inline constraints to each other (added by syncForeignKeys)
  if (foreignKeys) {
    for (const fk of foreignKeys.values()) {
      if (options?.deferForeignKeysTo?.has(fk.targetTable)) {
        continue;
      }
      const localCols = fk.fields.map((f) => qi(f)).join(", ");
      const targetCols = fk.targetFields.map((f) => qi(f)).join(", ");
      let constraint = `FOREIGN KEY (${localCols}) REFERENCES ${qi(fk.targetTable)} (${targetCols})`;
      if (fk.onDelete) {
        constraint += ` ON DELETE ${refActionToSql(fk.onDelete)}`;
      }
      if (fk.onUpdate) {
        constraint += ` ON UPDATE ${refActionToSql(fk.onUpdate)}`;
      }
      constraints.push(constraint);
    }
  }

  const body = [...colDefs.map((c) => c.def), ...constraints].join(", ");
  let sql = `CREATE TABLE IF NOT EXISTS ${quoteTableName(table)} (${body})`;

  // Table options
  const engine = options?.engine ?? "InnoDB";
  const charset = options?.charset ?? "utf8mb4";
  const collation = options?.collation ?? "utf8mb4_unicode_ci";
  sql += ` ENGINE=${engine} DEFAULT CHARSET=${charset} COLLATE=${collation}`;

  if (options?.autoIncrementStart !== undefined) {
    sql += ` AUTO_INCREMENT=${options.autoIncrementStart}`;
  }

  return sql;
}
