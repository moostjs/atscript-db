import type {
  TAtscriptAnnotatedType,
  TAtscriptTypeArray,
  TValidatorPlugin,
  TValidatorPluginContext,
} from "@atscript/typescript/utils";

import { isDbFieldOp } from "./ops";
import { getKeyProps } from "./patch/patch-types";

export interface DbValidationContext {
  mode: "insert" | "replace" | "patch";
  /** Flat map from the table — used to check if an array is a top-level array. */
  flatMap?: Map<string, TAtscriptAnnotatedType>;
  /** Precomputed nav field names — used to skip field-op validation inside TO/FROM/VIA relations. */
  navFields?: ReadonlySet<string>;
}

/** Set of recognised array‑patch operator keys. */
const PATCH_OPS = new Set(["$replace", "$insert", "$upsert", "$update", "$remove"]);

/**
 * Returns `true` when `value` looks like a patch‑operator object
 * (at least one key is a recognised operator and no unknown keys).
 */
function isPatchOperatorObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return false;
  }
  return keys.every((k) => PATCH_OPS.has(k));
}

/**
 * Validator plugin for database operations.
 *
 * Handles navigation field constraints and delegates to the standard validator
 * for type checking. The annotated type tree already includes nav fields with
 * their full target types — this plugin controls WHEN recursion is allowed
 * based on the operation mode (insert/replace/patch).
 *
 * Replaces the old `navFieldsValidatorPlugin` (which blindly skipped all nav
 * fields) and `_checkNavProps()` (which validated constraints separately).
 */
export function createDbValidatorPlugin(): TValidatorPlugin {
  return (ctx, def, value) => {
    const dbCtx = ctx.context as DbValidationContext | undefined;
    if (!dbCtx) {
      return undefined;
    }

    // ── Nav field handling ──────────────────────────────────────────────────
    const isTo = def.metadata.has("db.rel.to");
    const isFrom = def.metadata.has("db.rel.from");
    const isVia = def.metadata.has("db.rel.via");

    if (isTo || isFrom || isVia) {
      return handleNavField(ctx, def, value, dbCtx, isTo, isFrom, isVia);
    }

    // ── Patch-only checks ───────────────────────────────────────────────────
    if (dbCtx.mode === "patch") {
      // Field operation handling ($inc / $dec / $mul)
      if (isDbFieldOp(value)) {
        // Context check first: @db.json, non-merge objects, nav field passthrough
        if (dbCtx.flatMap && !isFieldOpAllowed(ctx.path, dbCtx.flatMap, dbCtx.navFields)) {
          ctx.error(
            'Field operations ($inc/$dec/$mul) are not supported inside @db.json fields or nested objects without @db.patch.strategy "merge"',
          );
          return false;
        }
        // Type check: field ops only make sense on numeric scalar fields
        const isNumeric =
          def.type.kind === "" && (def.type as { designType?: string }).designType === "number";
        if (!isNumeric) {
          ctx.error("Field operations ($inc/$dec/$mul) can only be applied to numeric fields");
          return false;
        }
        return true;
      }

      // Top-level array patch handling
      if (def.type.kind === "array" && dbCtx.flatMap) {
        const flatEntry = dbCtx.flatMap.get(ctx.path);
        if (flatEntry?.metadata?.has("db.__topLevelArray") && !flatEntry.metadata.has("db.json")) {
          return handleArrayPatch(ctx, def as TAtscriptAnnotatedType<TAtscriptTypeArray>, value);
        }
      }
    }

    // ── All other fields: fallthrough to default validation ─────────────────
    return undefined;
  };
}

/**
 * Checks whether a field op is valid at `path`.
 *
 * Rejects when:
 * - The field itself is `@db.json` (ops on opaque blobs are meaningless).
 * - Any ancestor is `@db.json`.
 * - Any ancestor is a nested object without `@db.patch.strategy "merge"`.
 *
 * Accepts immediately when an ancestor is a navigation field (TO/FROM/VIA) —
 * the nested data is extracted and validated against its own table separately.
 */
function isFieldOpAllowed(
  path: string,
  flatMap: Map<string, TAtscriptAnnotatedType>,
  navFields?: ReadonlySet<string>,
): boolean {
  // Reject ops directly on @db.json fields (even if the underlying type is numeric)
  const field = flatMap.get(path);
  if (field?.metadata.has("db.json")) {
    return false;
  }

  // Walk ancestors
  let pos = path.length;
  while ((pos = path.lastIndexOf(".", pos - 1)) !== -1) {
    const ancestor = path.slice(0, pos);
    // Nav field ancestor — ops inside are valid (validated by the related table)
    if (navFields?.has(ancestor)) {
      return true;
    }
    const entry = flatMap.get(ancestor);
    if (!entry) continue;
    if (entry.metadata.has("db.json")) return false;
    if (entry.type.kind === "object" && entry.metadata.get("db.patch.strategy") !== "merge") {
      return false;
    }
  }
  return true;
}

// ── Nav field handler ─────────────────────────────────────────────────────────

function handleNavField(
  ctx: TValidatorPluginContext,
  def: TAtscriptAnnotatedType,
  value: unknown,
  dbCtx: DbValidationContext,
  isTo: boolean,
  isFrom: boolean,
  isVia: boolean,
): boolean | undefined {
  const dotIdx = ctx.path.lastIndexOf(".");
  const fieldName = dotIdx === -1 ? ctx.path : ctx.path.slice(dotIdx + 1);

  // Null nav prop is always an error
  if (value === null) {
    ctx.error(`Cannot process null navigation property '${fieldName}'`);
    return false;
  }

  // Absent nav prop is always OK (nav fields are optional)
  if (value === undefined) {
    return true;
  }

  // Patch mode: FROM/VIA require explicit patch operator object
  if (dbCtx.mode === "patch") {
    if (isFrom || isVia) {
      // Patch operator object → validate operators against array element type
      if (isPatchOperatorObject(value)) {
        return validateNavPatchOps(ctx, def, value, fieldName);
      }
      // Plain arrays and anything else → reject (require explicit operator)
      const relType = isFrom ? "1:N" : "M:N";
      ctx.error(
        `Cannot patch ${relType} relation '${fieldName}' with a plain value — use patch operators ({ $insert, $remove, $replace, $update, $upsert })`,
      );
      return false;
    }
    // TO in patch: fall through → validates nested data with deep partial
  }

  // VIA items can be references (ID only) or new objects — skip validation
  if (isVia) {
    return true;
  }

  // TO and FROM with present nav data: fall through → validator
  // recurses into the nav field's target type naturally
  return undefined;
}

/**
 * Validates patch operator values against the nav field's target array type.
 * Each operator's items are validated against the element type.
 */
function validateNavPatchOps(
  ctx: TValidatorPluginContext,
  def: TAtscriptAnnotatedType,
  ops: Record<string, unknown>,
  fieldName: string,
): boolean {
  // Nav fields with relations should have array type
  if (def.type.kind !== "array") {
    ctx.error(`Cannot use patch operators on non-array relation '${fieldName}'`);
    return false;
  }

  const arrayDef = def as TAtscriptAnnotatedType<TAtscriptTypeArray>;

  // $replace / $insert / $upsert → validate as full array
  for (const op of ["$replace", "$insert", "$upsert"] as const) {
    if (ops[op] !== undefined) {
      if (!ctx.validateAnnotatedType(arrayDef, ops[op])) {
        return false;
      }
    }
  }

  // $update / $remove → validate each item as element type
  // Nav field $update is always partial — execution calls targetTable.bulkUpdate which is partial
  for (const op of ["$update", "$remove"] as const) {
    if (ops[op] !== undefined) {
      if (!validatePartialItems(ctx, arrayDef, ops[op], op, true)) {
        return false;
      }
    }
  }

  return true;
}

// ── Array patch handler ───────────────────────────────────────────────────────

/**
 * Handles patch‑mode validation for top‑level embedded arrays.
 *
 * When the incoming value is:
 * - A plain array → falls through to default array validation ($replace semantics)
 * - A patch operator object → validates each operator's payload individually
 */
function handleArrayPatch(
  ctx: TValidatorPluginContext,
  def: TAtscriptAnnotatedType<TAtscriptTypeArray>,
  value: unknown,
): boolean | undefined {
  // Plain array → treat as $replace, fall through to default validation
  if (Array.isArray(value)) {
    return undefined;
  }

  // Not an object at all → fall through (default validation will report the error)
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const ops = value as Record<string, unknown>;
  const keys = Object.keys(ops);

  // No keys or non-patch keys → fall through to default validation
  if (keys.length === 0 || !keys.every((k) => PATCH_OPS.has(k))) {
    // Check if any keys look like patch ops mixed with unknown keys
    const hasPatchOps = keys.some((k) => PATCH_OPS.has(k));
    if (hasPatchOps) {
      const unknown = keys.filter((k) => !PATCH_OPS.has(k));
      ctx.error(
        `Unknown patch operator(s): ${unknown.join(", ")}. Allowed: $replace, $insert, $upsert, $update, $remove`,
      );
      return false;
    }
    return undefined;
  }

  // $replace / $insert / $upsert → validate as full array
  for (const op of ["$replace", "$insert", "$upsert"] as const) {
    if (ops[op] !== undefined) {
      if (!ctx.validateAnnotatedType(def, ops[op])) {
        return false;
      }
    }
  }

  // $update / $remove → validate each item (element type, key fields required)
  const isMerge = def.metadata.get("db.patch.strategy") === "merge";
  for (const op of ["$update", "$remove"] as const) {
    if (ops[op] !== undefined) {
      if (!validatePartialItems(ctx, def, ops[op], op, isMerge)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Validates `$update` / `$remove` items.
 *
 * Each item must be an object. For object arrays with `@expect.array.key` fields,
 * key properties are required and non‑key properties are validated but optional.
 * For primitive arrays, items are validated directly against the element type.
 */
function validatePartialItems(
  ctx: TValidatorPluginContext,
  arrayDef: TAtscriptAnnotatedType<TAtscriptTypeArray>,
  items: unknown,
  op: "$update" | "$remove",
  isMerge?: boolean,
): boolean {
  if (!Array.isArray(items)) {
    ctx.error(`${op} must be an array`);
    return false;
  }

  const elementDef = arrayDef.type.of;

  // Primitive arrays — validate each item against element type directly
  if (elementDef.type.kind !== "object") {
    return ctx.validateAnnotatedType(arrayDef, items);
  }

  // Object arrays — validate with key awareness
  const keyProps = getKeyProps(arrayDef);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      ctx.error(`${op}[${i}]: expected object`);
      return false;
    }
    const rec = item as Record<string, unknown>;

    // Validate key fields are present (required for identification)
    if (keyProps.size > 0) {
      for (const kp of keyProps) {
        if (rec[kp] === undefined || rec[kp] === null) {
          ctx.error(`${op}[${i}]: key field '${kp}' is required`);
          return false;
        }
      }
    }

    // Validate each provided property against its type
    const objType = elementDef.type;
    for (const [key, val] of Object.entries(rec)) {
      const propDef = objType.props.get(key);
      if (propDef) {
        if (!ctx.validateAnnotatedType(propDef, val)) {
          return false;
        }
      }
    }

    // For $update with replace strategy: all non-optional fields are required
    if (op === "$update" && isMerge !== true) {
      for (const [propName, propDef] of objType.props) {
        if (!propDef.optional && !keyProps.has(propName) && rec[propName] === undefined) {
          ctx.error(`${op}[${i}]: field '${propName}' is required (replace strategy)`);
          return false;
        }
      }
    }
  }

  return true;
}
