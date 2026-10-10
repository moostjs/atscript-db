import type { AtscriptDbTable } from "../table/db-table";
import { isDbFieldOp } from "../ops";
import { TOP_LEVEL_ARRAY_TAG } from "./patch-decomposer";

type TWalk = "none" | "exempt" | "versioned";

/**
 * Whether a logical (pre-decomposition) patch writes ONLY version-exempt
 * fields (`@db.column.version.exempt`). `data` has nav fields, filter keys and
 * derived fields removed and `$cas` separated. Mirrors `flattenPatchPayload`
 * (keep the two side by side): PK keys and `@db.onUpdate.now` fields are
 * skipped; an exempt path (or one under an exempt ancestor) is covered
 * whatever its value (scalar, field op, array ops, object); a non-exempt
 * merge-strategy object recurses (only the supplied children are written);
 * anything else is a non-exempt write.
 * True iff at least one key is covered and none is not.
 * @since 0.1.150
 */
export function isVersionExemptPatch(
  data: Record<string, unknown>,
  table: AtscriptDbTable,
): boolean {
  const meta = table.getMetadata();
  if (meta.versionExemptPaths.size === 0) return false;
  // Metadata read once per patch, not per key.
  const primaryKeys = meta.primaryKeys;
  const flatMap = meta.flatMap;
  // The SDK's own `@db.onUpdate.now` stamps neither make nor break exemption.
  const stamps = meta.onUpdateNow;

  const walk = (obj: Record<string, unknown>, prefix: string): TWalk => {
    let result: TWalk = "none";
    for (const [k, value] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (primaryKeys.includes(key) || stamps.has(key)) continue;
      if (meta.isVersionExemptPath(key)) {
        result = "exempt";
        continue;
      }
      const flatType = flatMap.get(key);
      const isObjectValue = typeof value === "object" && value !== null && !Array.isArray(value);
      if (
        isObjectValue &&
        !isDbFieldOp(value) &&
        !flatType?.metadata?.get(TOP_LEVEL_ARRAY_TAG) &&
        !flatType?.metadata?.has("db.json") &&
        flatType?.metadata?.get("db.patch.strategy") === "merge"
      ) {
        const inner = walk(value as Record<string, unknown>, key);
        if (inner === "versioned") return "versioned";
        if (inner === "exempt") result = "exempt";
        continue;
      }
      return "versioned";
    }
    return result;
  };

  return walk(data, "") === "exempt";
}
