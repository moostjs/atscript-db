import type {
  TDbDefaultFn,
  TDbFieldMeta,
  TDerivedChangeReason,
  TExistingColumn,
  TColumnDiff,
} from "../types";
import { serializeDefaultValue, type TFieldSnapshot, type TTableSnapshot } from "./schema-hash";
import { fkKey } from "./fk-diff";
import { stableJson } from "../shared/object";

/**
 * Why a derived column (desired, live, or both) must be dropped and re-added,
 * or `undefined` when it is unchanged. Nullability and defaults are never
 * compared for one: a generated column is nullable and has no DEFAULT.
 */
function derivedChangeReason(
  field: TDbFieldMeta,
  existingCol: TExistingColumn,
  typeMapper: ((field: TDbFieldMeta) => string) | undefined,
  snap: TFieldSnapshot | undefined,
): TDerivedChangeReason | undefined {
  if (!field.derived) {
    return existingCol.generated ? "kind" : undefined;
  }
  if (!existingCol.generated) {
    return "kind";
  }
  const stored = snap?.derived;
  if (
    stored &&
    (stored.sourceColumn !== field.derived.sourceColumn ||
      stored.type !== field.derived.type ||
      stored.jsonPath.length !== field.derived.jsonPath.length ||
      stored.jsonPath.some((seg, i) => seg !== field.derived!.jsonPath[i]))
  ) {
    return "expression";
  }
  if (typeMapper && isColumnTypeChanged(existingCol.type, typeMapper(field))) {
    return "type";
  }
  return undefined;
}

/**
 * Whether a live column's type differs from the type the adapter's
 * `typeMapper` gives the field — the one rule schema sync diffs column types
 * by (case-insensitive). Exported for adapters that must agree with it (the
 * PostgreSQL recreate converts exactly the columns this reports changed).
 * @since 0.1.137
 */
export function isColumnTypeChanged(existingType: string, expectedType: string): boolean {
  return existingType.toUpperCase() !== expectedType.toUpperCase();
}

/**
 * Whether a live column default (as the adapter's introspection normalized
 * it) and a model default (`serializeDefaultValue`) denote the same value for
 * `field` — compared in a canonical, type-aware form, because the DDL writes a
 * literal that differs from the annotation text and the engine reformats it
 * again: booleans as `1` / `0` (`true` / `1` → `1`), numbers numerically
 * (`1.0` = `1`, a DECIMAL's `0.00` = `0`), JSON-stored values as parsed,
 * key-sorted JSON (`{"a": 1}` = `{"a":1}`). With a column type `liveType`
 * of a fixed scale (`DECIMAL(10,2)`, `NUMERIC(8,3)`) — the type the column
 * has once synced, i.e. the model's — a model value is also the value the
 * column stores for it (`2.345` = `2.35`).
 * Function defaults (`fn:now`, `fn:uuid`, …) and every other value compare as
 * strings. Exported for adapters that must agree with schema sync.
 * @since 0.1.162
 */
export function sameDefaultValue(
  field: Pick<TDbFieldMeta, "designType" | "storage">,
  live: string | undefined,
  desired: string | undefined,
  liveType?: string,
): boolean {
  if (live === desired) {
    return true;
  }
  if (live === undefined || desired === undefined) {
    return false;
  }
  if (live.startsWith("fn:") || desired.startsWith("fn:")) {
    return false;
  }
  if (isJsonDefault(field)) {
    const a = canonicalJson(live);
    return a !== undefined && a === canonicalJson(desired);
  }
  switch (field.designType) {
    case "boolean": {
      const a = canonicalBoolean(live);
      return a !== undefined && a === canonicalBoolean(desired);
    }
    case "number":
    case "integer":
    case "decimal": {
      return sameNumber(live, desired, liveType);
    }
    default: {
      return false;
    }
  }
}

function isJsonDefault(field: Pick<TDbFieldMeta, "designType" | "storage">): boolean {
  return (
    field.storage === "json" ||
    field.designType === "json" ||
    field.designType === "array" ||
    field.designType === "object"
  );
}

function canonicalBoolean(value: string): "1" | "0" | undefined {
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1") {
    return "1";
  }
  if (v === "false" || v === "0") {
    return "0";
  }
  return undefined;
}

/** Parsed JSON re-serialized with object keys sorted; `undefined` when not JSON. */
function canonicalJson(value: string): string | undefined {
  try {
    return stableJson(JSON.parse(value));
  } catch {
    return undefined;
  }
}

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/;

const SCALED_TYPE_RE = /^(?:DECIMAL|NUMERIC|DEC|FIXED)\s*\(\s*\d+\s*,\s*(\d+)\s*\)/i;

/**
 * Numeric equality of two default literals — or, on a column of a fixed
 * scale (`liveType` `DECIMAL(p,s)` / `NUMERIC(p,s)`), of the live value and
 * the model value rounded half-up to that scale, as the engine stores it.
 */
function sameNumber(live: string, desired: string, liveType: string | undefined): boolean {
  const l = live.trim();
  const d = desired.trim();
  if (l === "" || d === "") {
    return false;
  }
  // Numerically, as the DDL writes it (`String(Number(value))`)
  const a = Number(l);
  const b = Number(d);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const scale = liveType ? SCALED_TYPE_RE.exec(liveType.trim())?.[1] : undefined;
  if (scale === undefined) {
    return false;
  }
  const rounded = roundDecimal(d, Number(scale));
  return rounded !== undefined && Number(rounded) === a;
}

/** `value` (a plain decimal literal) rounded half-up to `scale` fraction digits, exactly. */
function roundDecimal(value: string, scale: number): string | undefined {
  const m = DECIMAL_RE.exec(value);
  if (!m) {
    return undefined;
  }
  const [, sign, int, frac = ""] = m;
  if (frac.length <= scale) {
    return value;
  }
  const digits = `${int || "0"}${frac.slice(0, scale)}`;
  let n = BigInt(digits);
  if (frac.charCodeAt(scale) >= 53 /* '5' */) {
    n += 1n;
  }
  const str = n.toString().padStart(scale + 1, "0");
  const head = str.slice(0, str.length - scale);
  const tail = str.slice(str.length - scale);
  return `${sign}${head}${scale > 0 ? `.${tail}` : ""}`;
}

/** Options of {@link computeColumnDiff}. */
export interface TColumnDiffOptions {
  /**
   * The table's stored snapshot (since 0.1.141) — the baseline a derived
   * column's expression is compared with (the engine normalizes the
   * expression it stores, so the live column cannot be). Without one, only a
   * kind or type drift is seen.
   */
  snapshot?: TTableSnapshot | null;
  /** The adapter's `nativeDefaultFns()`: a column missing such a default drifts. */
  nativeDefaultFns?: ReadonlySet<TDbDefaultFn>;
  /** The adapter's `reportedDefault` hook (since 0.1.162): a live default equal to it is unchanged. */
  reportedDefault?: (desired: string, field: TDbFieldMeta) => string;
}

/**
 * Computes the difference between desired schema fields and existing database columns.
 *
 * @param desired - Field descriptors from the Atscript type (after flattening) —
 *                  the readable's `columnDescriptors`; ignored descriptors are skipped.
 * @param existing - Columns currently in the database (from introspection).
 * @param typeMapper - Optional function to map field metadata to DB-native type strings.
 *                     Receives the full field meta (design type, annotations, PK status, etc.)
 *                     so adapters can produce context-aware types (e.g., `VARCHAR(255)` from maxLength).
 *                     Required for type change detection.
 * @param opts - See {@link TColumnDiffOptions}.
 */
export function computeColumnDiff(
  desired: readonly TDbFieldMeta[],
  existing: TExistingColumn[],
  typeMapper?: (field: TDbFieldMeta) => string,
  opts?: TColumnDiffOptions,
): TColumnDiff {
  const existingByName = new Map(existing.map((c) => [c.name, c]));
  const snapshotByName = opts?.snapshot
    ? new Map(opts.snapshot.fields.map((f) => [f.physicalName, f]))
    : undefined;
  const derivedChanged: NonNullable<TColumnDiff["derivedChanged"]> = [];
  const desiredByName = new Map<string, TDbFieldMeta>();
  const renamedOldNames = new Set<string>();

  const added: TDbFieldMeta[] = [];
  const renamed: TColumnDiff["renamed"] = [];
  const typeChanged: TColumnDiff["typeChanged"] = [];
  const nullableChanged: TColumnDiff["nullableChanged"] = [];
  const defaultChanged: TColumnDiff["defaultChanged"] = [];
  const conflicts: TColumnDiff["conflicts"] = [];

  /**
   * A derived column (on either side) is compared as a whole — any drift is a
   * drop + add, and nullability / defaults are not the model's to manage.
   * `true` when the pair was a derived one (handled here).
   */
  const checkDerived = (field: TDbFieldMeta, col: TExistingColumn, snapKey: string): boolean => {
    if (!field.derived && !col.generated) {
      return false;
    }
    const reason = derivedChangeReason(field, col, typeMapper, snapshotByName?.get(snapKey));
    if (reason) {
      derivedChanged.push({ field, reason });
    }
    return true;
  };

  for (const field of desired) {
    if (field.ignored) {
      continue;
    }
    desiredByName.set(field.physicalName, field);

    const existingCol = existingByName.get(field.physicalName);
    if (existingCol) {
      // Column exists with current name — but if this field also has renamedFrom
      // pointing to another existing column, the rename target conflicts
      if (field.renamedFrom && existingByName.has(field.renamedFrom)) {
        conflicts.push({ field, oldName: field.renamedFrom, conflictsWith: field.physicalName });
        renamedOldNames.add(field.renamedFrom);
      } else if (!checkDerived(field, existingCol, field.physicalName)) {
        // Check type change (requires typeMapper)
        const mappedType = typeMapper?.(field);
        if (mappedType !== undefined && isColumnTypeChanged(existingCol.type, mappedType)) {
          typeChanged.push({ field, existingType: existingCol.type });
        }

        // Check nullable change — skip primary keys (SQLite PRAGMA reports notnull=0
        // for INTEGER PRIMARY KEY even though it enforces non-null on them)
        if (!field.isPrimaryKey && !existingCol.pk) {
          const desiredNotNull = !field.optional;
          if (existingCol.notnull !== desiredNotNull) {
            nullableChanged.push({ field, wasNullable: !existingCol.notnull });
          }
        }

        // Check default value change — only when a baseline exists.
        // When existingCol.dflt_value is undefined, we have no baseline
        // (e.g., old DDL without DEFAULT clause) and can't detect changes —
        // except a `now` / `uuid` default the engine applies itself
        // (`nativeDefaultFns`): the table layer leaves such a field out of an
        // INSERT, so a column without it would reject the row.
        const liveDefault = existingCol.dflt_value;
        const desiredDefault = serializeDefaultValue(field.defaultValue);
        const fn = field.defaultValue?.kind === "fn" ? field.defaultValue.fn : undefined;
        const missingNative =
          fn !== undefined && fn !== "increment" && opts?.nativeDefaultFns?.has(fn) === true;
        if (
          (liveDefault !== undefined || missingNative) &&
          liveDefault !== desiredDefault &&
          // Rounded to the scale the column has after this sync — the model's
          // type when it changes (a DECIMAL(10,2) → (10,3) keeps 2.345)
          !sameDefaultValue(field, liveDefault, desiredDefault, mappedType ?? existingCol.type) &&
          !(
            liveDefault !== undefined &&
            desiredDefault !== undefined &&
            opts?.reportedDefault?.(desiredDefault, field) === liveDefault
          )
        ) {
          defaultChanged.push({
            field,
            oldDefault: liveDefault,
            newDefault: desiredDefault,
          });
        }
      }
    } else if (field.renamedFrom && existingByName.has(field.renamedFrom)) {
      // Column exists under old name → rename. A derived column that also
      // changed its expression (or kind) is rebuilt after the rename, under
      // its new name — the rename alone would keep the old expression.
      renamed.push({ field, oldName: field.renamedFrom });
      renamedOldNames.add(field.renamedFrom);
      checkDerived(field, existingByName.get(field.renamedFrom)!, field.renamedFrom);
    } else {
      added.push(field);
    }
  }

  // Exclude renamed old names from "removed"
  const removed: TExistingColumn[] = existing.filter(
    (c) => !desiredByName.has(c.name) && !renamedOldNames.has(c.name),
  );

  const diff: TColumnDiff = {
    added,
    removed,
    renamed,
    typeChanged,
    nullableChanged,
    defaultChanged,
    conflicts,
  };
  if (derivedChanged.length > 0) {
    diff.derivedChanged = derivedChanged;
  }

  // Primary-key field set — only meaningful when the table exists. Compared
  // as sorted sets (consistent with the schema hash, which stores
  // `isPrimaryKey` per field sorted by name and cannot see a reorder either).
  // A renamed PK column is mapped to its new name before comparing so a plain
  // `@db.column.renamed` on the key is not mistaken for a key change.
  if (existing.length > 0) {
    const newNameByOld = new Map(renamed.map((r) => [r.oldName, r.field.physicalName]));
    const from = existing.filter((c) => c.pk).map((c) => newNameByOld.get(c.name) ?? c.name);
    const to = desired.filter((f) => !f.ignored && f.isPrimaryKey).map((f) => f.physicalName);
    if (fkKey(from) !== fkKey(to)) {
      diff.primaryKeyChanged = { from, to };
    }
  }

  return diff;
}
