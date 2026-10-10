import type { TJsonCopyTarget } from "@atscript/db";

import type { SqlDialect } from "./dialect";

/**
 * `UPDATE` copying the JSON values of the text column `source` into
 * `targets` (`BaseDbAdapter.copyFromJsonColumn`, since 0.1.155): each target
 * reads its path with the dialect's {@link SqlDialect.jsonExtractText} (a
 * `boolean` target with `jsonExtract(…, "boolean")`, a `json` one with
 * {@link SqlDialect.jsonExtractValue}), passed through `cast` (the
 * adapter's conversion to the column type). Only rows where `source` holds
 * a value and every target is NULL are touched, so a re-run never
 * overwrites values written since.
 */
export function buildJsonColumnCopy(
  dialect: SqlDialect,
  table: string,
  source: string,
  targets: readonly TJsonCopyTarget[],
  cast: (expr: string, target: TJsonCopyTarget) => string = (expr) => expr,
): string {
  if (!dialect.jsonExtractText || !dialect.jsonExtractValue || !dialect.jsonExtract) {
    throw new Error("Copying JSON values into columns is not supported by this adapter");
  }
  const src = dialect.quoteIdentifier(source);
  const sets: string[] = [];
  const empty: string[] = [];
  for (const target of targets) {
    const col = dialect.quoteIdentifier(target.column);
    const expr =
      target.kind === "json"
        ? dialect.jsonExtractValue(src, target.path)
        : target.kind === "boolean"
          ? dialect.jsonExtract(src, target.path, "boolean")
          : dialect.jsonExtractText(src, target.path);
    sets.push(`${col} = ${cast(expr, target)}`);
    empty.push(`${col} IS NULL`);
  }
  return `UPDATE ${dialect.quoteTable(table)} SET ${sets.join(", ")} WHERE ${src} IS NOT NULL AND ${empty.join(" AND ")}`;
}

/**
 * `UPDATE` rewriting the text column `column` as JSON text
 * (`BaseDbAdapter.jsonifyTextColumn`, since 0.1.155): valid JSON stays, other
 * text becomes a JSON string — see {@link SqlDialect.jsonFromText}.
 */
export function buildJsonifyText(dialect: SqlDialect, table: string, column: string): string {
  if (!dialect.jsonFromText) {
    throw new Error("Converting text values to JSON is not supported by this adapter");
  }
  const col = dialect.quoteIdentifier(column);
  return `UPDATE ${dialect.quoteTable(table)} SET ${col} = ${dialect.jsonFromText(col)} WHERE ${col} IS NOT NULL`;
}
