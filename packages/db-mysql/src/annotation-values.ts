/**
 * `@db.mysql.onUpdate` values MySQL accepts in `ON UPDATE`:
 * `CURRENT_TIMESTAMP` / `LOCALTIMESTAMP` / `LOCALTIME` with optional
 * parentheses, or `NOW()`, each with an optional precision 0–6
 * (group 1 or 2).
 */
export const MYSQL_ON_UPDATE_RE =
  /^(?:(?:current_timestamp|localtimestamp|localtime)(?:\(\s*([0-6])?\s*\))?|now\(\s*([0-6])?\s*\))$/i;

/** An engine / character-set / collation name: what `@db.mysql.*` may put into DDL unquoted. */
export const MYSQL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * `name` when it is a bare MySQL name ({@link MYSQL_NAME_RE}), else an error
 * naming `annotation` — the compiler refuses such a value; this guards
 * metadata built without it.
 */
export function mysqlName(annotation: string, name: string): string {
  if (!MYSQL_NAME_RE.test(name)) {
    throw new Error(`${annotation} "${name}" is not a MySQL name (letters, digits, _)`);
  }
  return name;
}

/**
 * The `ON UPDATE` expression for `@db.mysql.onUpdate` `expr` on a column of
 * type `sqlType`: `CURRENT_TIMESTAMP(n)` as written when it names a
 * precision, else `columnDefault` (the column's own precision — MySQL
 * requires them to match). Any other expression throws (the compiler refuses
 * it; nothing else reaches the DDL).
 */
export function mysqlOnUpdateExpr(expr: string, columnDefault: string): string {
  const match = MYSQL_ON_UPDATE_RE.exec(expr.trim());
  if (!match) {
    throw new Error(`@db.mysql.onUpdate "${expr}" is not CURRENT_TIMESTAMP[(n)]`);
  }
  const fsp = match[1] ?? match[2];
  return fsp === undefined ? columnDefault : `CURRENT_TIMESTAMP(${fsp})`;
}
