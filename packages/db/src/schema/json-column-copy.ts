import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { BaseDbAdapter } from "../base-adapter";
import { resolveDesignType, type AtscriptDbReadable } from "../table/db-readable";
import { relationalColumnName } from "../table/table-metadata";
import { unionValueMembers } from "../shared/union-shape";
import type { TColumnDiff, TDbFieldMeta, TJsonCopyTarget } from "../types";
import { serializeDefaultValue, type TTableSnapshot } from "./schema-hash";

/**
 * The data migration from the column layout atscript-db ≤ 0.1.154 gave union
 * fields on relational storage (since 0.1.155). That layout stored a whole
 * `T | null` object, union of objects or mixed union in ONE text column (JSON
 * text for objects / arrays, plain text for scalars) under the field's name.
 *
 * - `copies` — an object field now flattened to `__` columns whose old text
 *   column is still there (it is in the diff's `removed`): its JSON values are
 *   copied into the new columns before the old one is dropped;
 * - `jsonify` — a field now stored as JSON whose column was a text column of
 *   the old layout: plain-text values are rewritten as JSON strings before
 *   the column becomes a JSON column (or is read as one);
 * - `errors` — a copy the adapter cannot perform: the table is refused
 *   rather than its data dropped.
 */
export interface TJsonColumnMigration {
  copies: Array<{ source: string; targets: TJsonCopyTarget[] }>;
  jsonify: string[];
  errors: string[];
}

const NONE: TJsonColumnMigration = { copies: [], jsonify: [], errors: [] };

/** A text column type of the old layout (`TEXT`, `LONGTEXT`, `VARCHAR(n)`, `character varying`). */
const TEXT_TYPE = /text|char|clob/i;

/**
 * Design types a stored snapshot gives a field whose column held a whole
 * value as JSON text: the old union layout (`union`), or `@db.json`.
 */
const JSON_TEXT_DESIGN_TYPES: ReadonlySet<string> = new Set(["union", "json", "object"]);

/** How a target column reads its value out of the JSON, or why it cannot. */
function targetKind(fd: TDbFieldMeta): TJsonCopyTarget["kind"] | { problem: string } {
  if (fd.encrypted) return { problem: "it is @db.encrypted" };
  if (fd.isGeoPoint) return { problem: "it is a db.geoPoint" };
  if (fd.storage === "json") return "json";
  return fd.designType === "boolean" ? "boolean" : "text";
}

/** Whether `type` is a union one of whose value members is a string. */
function hasStringMember(type: TAtscriptAnnotatedType | undefined): boolean {
  if (type?.type.kind !== "union") return false;
  return unionValueMembers(type).members.some((m) => resolveDesignType(m) === "string");
}

/**
 * Plans {@link TJsonColumnMigration} for one table from its live column diff
 * (and its stored snapshot — on SQLite the old text column and a JSON
 * column have the same type).
 */
export function planJsonColumnMigration(
  readable: AtscriptDbReadable,
  diff: TColumnDiff,
  snapshot?: TTableSnapshot | null,
): TJsonColumnMigration {
  const meta = readable.getMetadata();
  if (meta.nestedObjects) return NONE;
  const adapter: BaseDbAdapter = readable.dbAdapter;
  const name = readable.tableName;
  const removed = new Set(diff.removed.map((c) => c.name));
  const snapshotFields = new Map(snapshot?.fields.map((f) => [f.physicalName, f]));
  const out: TJsonColumnMigration = { copies: [], jsonify: [], errors: [] };

  if (removed.size > 0) {
    for (const parent of meta.flattenedParents) {
      // The old column carried the field's own name (`@db.column` cannot
      // rename a flattened object, so there is no override to honour).
      const source = relationalColumnName(parent, undefined, parent.includes("."));
      if (!removed.has(source)) continue;
      // A column the snapshot knows as a scalar is no JSON text (a field
      // retyped from `string` to an object): it is dropped as usual.
      const was = snapshotFields.get(source);
      if (was && !JSON_TEXT_DESIGN_TYPES.has(was.designType)) continue;
      const prefix = `${parent}.`;
      const targets: TJsonCopyTarget[] = [];
      const problems: string[] = [];
      for (const fd of meta.storedDescriptors) {
        if (!fd.path.startsWith(prefix)) continue;
        const kind = targetKind(fd);
        if (typeof kind === "object") {
          problems.push(`"${fd.physicalName}" (${kind.problem})`);
          continue;
        }
        targets.push({
          column: fd.physicalName,
          path: fd.path.slice(prefix.length).split("."),
          kind,
          field: fd,
        });
      }
      if (targets.length === 0 && problems.length === 0) continue;
      if (problems.length > 0 || !adapter.copyFromJsonColumn) {
        const why =
          problems.length > 0
            ? `cannot fill ${problems.join(", ")} from it`
            : "the adapter cannot copy JSON values into columns";
        out.errors.push(
          `Column "${source}" of ${name} holds "${parent}" as JSON text (the layout of atscript-db ≤ 0.1.154) and ${why}. ` +
            `Annotate "${parent}" with @db.json to keep it in one column, or migrate the data and drop "${source}" manually.`,
        );
        continue;
      }
      out.copies.push({ source, targets });
    }
  }

  const typeChanged = new Map(diff.typeChanged.map((tc) => [tc.field.physicalName, tc]));
  for (const fd of meta.storedDescriptors) {
    // Only a union with a string member has plain-text values to rewrite
    // (`Address | string`); any other JSON field's text is JSON already, or
    // fails its conversion loudly as before.
    if (fd.storage !== "json" || !hasStringMember(meta.flatMap.get(fd.path))) continue;
    const tc = typeChanged.get(fd.physicalName);
    const old = snapshotFields.get(fd.physicalName);
    // Witnesses of the old layout: a text column turning JSON (PostgreSQL,
    // MySQL), the stored snapshot, or the dot-named columns it gave an
    // object member (`extra.street` — SQLite keeps TEXT, so no type change).
    const dotted = `${fd.physicalName}.`;
    const wasText =
      (tc !== undefined && TEXT_TYPE.test(tc.existingType)) ||
      (old !== undefined && old.storage !== "json" && old.designType !== "json") ||
      diff.removed.some((c) => c.name.startsWith(dotted));
    if (!wasText) continue;
    if (!adapter.jsonifyTextColumn) {
      out.errors.push(
        `Column "${fd.physicalName}" of ${name} becomes a JSON column but the adapter cannot convert its text values. Migrate them manually.`,
      );
      continue;
    }
    out.jsonify.push(fd.physicalName);
  }
  return out.copies.length > 0 || out.jsonify.length > 0 || out.errors.length > 0 ? out : NONE;
}

/** The copy targets {@link applyJsonColumnMigration} adds: those not in the table yet. */
function copyTargetsToAdd(migration: TJsonColumnMigration, diff: TColumnDiff): TDbFieldMeta[] {
  const targets = new Set(migration.copies.flatMap((c) => c.targets.map((t) => t.column)));
  return diff.added.filter((fd) => targets.has(fd.physicalName));
}

/**
 * The column diff the rest of the table's sync applies after
 * {@link applyJsonColumnMigration}: without the copy targets it added, with
 * their NOT NULL and model default as nullability / default changes. Also
 * what `plan({ safe: true })` reports as skipped — safe mode adds and fills
 * the targets but leaves them nullable and without their default.
 */
export function diffAfterJsonCopy(migration: TJsonColumnMigration, diff: TColumnDiff): TColumnDiff {
  const toAdd = copyTargetsToAdd(migration, diff);
  if (toAdd.length === 0) return diff;
  return {
    ...diff,
    added: diff.added.filter((fd) => !toAdd.includes(fd)),
    nullableChanged: [
      ...diff.nullableChanged,
      ...toAdd.filter((fd) => !fd.optional).map((fd) => ({ field: fd, wasNullable: true })),
    ],
    defaultChanged: [
      ...diff.defaultChanged,
      ...toAdd
        .filter((fd) => fd.defaultValue !== undefined)
        .map((fd) => ({ field: fd, newDefault: serializeDefaultValue(fd.defaultValue) })),
    ],
  };
}

/**
 * Runs a planned {@link TJsonColumnMigration} — first, before any other
 * column work of the table: text columns become JSON text, the copy targets
 * that do not exist yet are added, and the values are copied. Returns the
 * diff without the columns it added ({@link diffAfterJsonCopy}). Idempotent:
 * a re-run converts nothing twice and copies only into rows whose targets
 * are all NULL.
 *
 * The targets are added nullable and WITHOUT a default — `ADD COLUMN …
 * DEFAULT`, or the type default an adapter gives a required column (a
 * leaf every member of a non-null union of objects declares), fills every
 * existing row, so the copy would skip them all. A model default and NOT
 * NULL are returned as default / nullability changes of the diff, which the
 * rest of the table's sync applies after the copy (`SET DEFAULT` / `SET NOT
 * NULL` / `MODIFY COLUMN`, a table recreation on SQLite). Rows the copy
 * leaves NULL keep NULL in a nullable column; a required one backfills them.
 */
export async function applyJsonColumnMigration(
  adapter: BaseDbAdapter,
  migration: TJsonColumnMigration,
  diff: TColumnDiff,
): Promise<{ diff: TColumnDiff; added: string[] }> {
  for (const column of migration.jsonify) {
    await adapter.jsonifyTextColumn!(column);
  }
  if (migration.copies.length === 0) return { diff, added: [] };
  const toAdd = copyTargetsToAdd(migration, diff);
  let added: string[] = [];
  if (toAdd.length > 0) {
    const result = await adapter.syncColumns!({
      added: toAdd.map((fd) => ({ ...fd, optional: true, defaultValue: undefined })),
      removed: [],
      renamed: [],
      typeChanged: [],
      nullableChanged: [],
      defaultChanged: [],
      conflicts: [],
    });
    added = result.added;
  }
  for (const copy of migration.copies) {
    await adapter.copyFromJsonColumn!(copy.source, copy.targets);
  }
  return { diff: diffAfterJsonCopy(migration, diff), added };
}
