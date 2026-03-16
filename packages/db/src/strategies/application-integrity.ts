import { AsyncLocalStorage } from "node:async_hooks";

import type { FilterExpr } from "@uniqu/core";

import { type BaseDbAdapter } from "../base-adapter";
import { DbError } from "../db-error";
import { UniquSelect } from "../query/uniqu-select";
import type { TableMetadata } from "../table/table-metadata";
import type {
  TCascadeResolver,
  TDbForeignKey,
  TFkLookupResolver,
  TFkLookupTarget,
  TWriteTableResolver,
} from "../types";
import { IntegrityStrategy } from "./integrity";

// ── Cascade context ─────────────────────────────────────────────────────

const MAX_CASCADE_DEPTH = 100;

interface CascadeContext {
  visited: Set<string>;
  depth: number;
}

const cascadeStorage = new AsyncLocalStorage<CascadeContext>();

/**
 * Integrity strategy for adapters without native FK support (e.g. MongoDB).
 * Validates FK constraints and executes cascade/setNull actions at
 * the application level.
 */
export class ApplicationIntegrity extends IntegrityStrategy {
  /**
   * Validates FK constraints by querying target tables for referenced records.
   * Collects unique FK values across items, batches them into target-table
   * lookups, and throws FK_VIOLATION if any references are missing.
   */
  async validateForeignKeys(
    items: Array<Record<string, unknown>>,
    meta: TableMetadata,
    fkLookupResolver: TFkLookupResolver | undefined,
    writeTableResolver: TWriteTableResolver | undefined,
    partial?: boolean,
    excludeTargetTable?: string,
  ): Promise<void> {
    if (!fkLookupResolver) {
      return;
    }

    // Build all FK checks, then run in parallel
    const checks: Array<() => Promise<void>> = [];

    for (const [, fk] of meta.foreignKeys) {
      // Skip FKs that reference the excluded table (e.g. FROM child → parent during pre-validation)
      if (excludeTargetTable && fk.targetTable === excludeTargetTable) {
        continue;
      }

      // Collect unique FK values across all items using Sets for O(1) dedup
      const valueSets: Array<Set<unknown>> = fk.fields.map(() => new Set<unknown>());

      for (const item of items) {
        // For partial updates, skip if none of the FK fields are in the payload
        if (partial && !fk.fields.some((f) => f in item)) {
          continue;
        }

        // Skip if any FK field is null/undefined (nullable FK — no constraint)
        let allPresent = true;
        const vals: unknown[] = [];
        for (const field of fk.fields) {
          const v = item[field];
          if (v === null || v === undefined) {
            allPresent = false;
            break;
          }
          vals.push(v);
        }
        if (!allPresent) {
          continue;
        }

        for (let i = 0; i < vals.length; i++) {
          valueSets[i].add(vals[i]);
        }
      }

      if (valueSets[0].size === 0) {
        continue;
      }

      // Resolve target table — try lookup resolver first, then write resolver as fallback
      let target: TFkLookupTarget | undefined = fkLookupResolver(fk.targetTable);
      if (!target && fk.targetTypeRef && writeTableResolver) {
        const resolved = writeTableResolver(fk.targetTypeRef());
        if (resolved) {
          target = { count: (filter: Record<string, unknown>) => resolved.count({ filter }) };
        }
      }
      if (!target) {
        continue;
      }

      // Build filter on target table's fields and count matching records
      const filter: Record<string, unknown> = {};
      let firstValues: unknown[] = [];
      for (let i = 0; i < fk.targetFields.length; i++) {
        const values = [...valueSets[i]];
        if (i === 0) firstValues = values;
        filter[fk.targetFields[i]] = values.length === 1 ? values[0] : { $in: values };
      }
      const expectedCount = firstValues.length;

      checks.push(async () => {
        const count = await target.count(filter);
        if (count < expectedCount) {
          const sample = firstValues.slice(0, 3).join(", ");
          const suffix = firstValues.length > 3 ? `, ... (${firstValues.length} total)` : "";
          throw new DbError("FK_VIOLATION", [
            {
              path: fk.fields.join(", "),
              message: `FK constraint violation: "${fk.fields.join(", ")}" references non-existent record in "${fk.targetTable}" (values: ${sample}${suffix})`,
            },
          ]);
        }
      });
    }

    if (checks.length > 0) {
      await Promise.all(checks.map((fn) => fn()));
    }
  }

  /**
   * Applies cascade/setNull actions on child tables before deleting parent records.
   * Finds all records matching `filter`, extracts their PK values, then for each
   * child table with a FK pointing to this table:
   * - `restrict`: throws if any children exist
   * - `cascade`: recursively deletes child records
   * - `setNull`: sets FK fields to null
   */
  async cascadeBeforeDelete(
    filter: FilterExpr,
    tableName: string,
    meta: TableMetadata,
    cascadeResolver: TCascadeResolver,
    translateFilter: (f: FilterExpr) => FilterExpr,
    adapter: BaseDbAdapter,
  ): Promise<void> {
    const parentCtx = cascadeStorage.getStore();
    const visited = parentCtx?.visited ?? new Set<string>();
    const depth = (parentCtx?.depth ?? 0) + 1;

    if (depth > MAX_CASCADE_DEPTH) {
      throw new DbError("CASCADE_CYCLE", [
        {
          path: tableName,
          message: `Cascade delete aborted: chain exceeded ${MAX_CASCADE_DEPTH} levels, likely caused by a circular or deeply nested cascade relationship`,
        },
      ]);
    }

    const targets = cascadeResolver(tableName);
    if (targets.length === 0) {
      return;
    }

    // Ensure PK fields are fetched (needed for record-level cycle detection)
    const neededLogical = new Set<string>();
    for (const t of targets) {
      for (const tf of t.fk.targetFields) {
        neededLogical.add(tf);
      }
    }
    for (const pk of meta.primaryKeys) {
      neededLogical.add(pk);
    }

    // Map logical → physical for the adapter query, then back for FK matching
    const physicalToLogical = new Map<string, string>();
    const physicalFields: string[] = [];
    for (const logical of neededLogical) {
      const physical = meta.pathToPhysical.get(logical) ?? meta.columnMap.get(logical) ?? logical;
      physicalFields.push(physical);
      physicalToLogical.set(physical, logical);
    }
    const rawRecords = await adapter.findMany({
      filter: translateFilter(filter),
      controls: { $select: new UniquSelect(physicalFields) },
    });
    if (rawRecords.length === 0) {
      return;
    }

    // Map physical column names back to logical for FK matching
    const allRecords = rawRecords.map((r) => {
      const mapped: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(r)) {
        mapped[physicalToLogical.get(key) ?? key] = val;
      }
      return mapped;
    });

    // Record-level cycle detection: skip records already being deleted
    // by an ancestor in the cascade chain (e.g. A1→B1→A1 skips A1).
    // Records in the same table but with different keys proceed normally
    // (e.g. A1→B1→C1→A2 processes A2).
    const pkFields = meta.primaryKeys;
    const addedKeys: string[] = [];
    const records: Array<Record<string, unknown>> = [];
    for (const record of allRecords) {
      const key = this.recordKey(tableName, pkFields, record);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      addedKeys.push(key);
      records.push(record);
    }
    if (records.length === 0) {
      return;
    }

    try {
      await cascadeStorage.run({ visited, depth }, async () => {
        // Pass 1: RESTRICT pre-check — block the delete before any side effects
        // All restrict checks are read-only counts, safe to run in parallel.
        const restrictChecks: Array<Promise<void>> = [];
        for (const target of targets) {
          if (target.fk.onDelete !== "restrict") {
            continue;
          }
          const childFilter = this.buildCascadeChildFilter(records, target.fk);
          if (!childFilter) {
            continue;
          }
          restrictChecks.push(
            target.count(childFilter).then((count) => {
              if (count > 0) {
                throw new DbError("CONFLICT", [
                  {
                    path: tableName,
                    message: `Cannot delete from "${tableName}": ${count} record(s) in "${target.childTable}" (${target.fk.fields.join(", ")}) reference it (RESTRICT)`,
                  },
                ]);
              }
            }),
          );
        }
        if (restrictChecks.length > 0) {
          await Promise.all(restrictChecks);
        }

        // Pass 2: CASCADE / SET NULL — safe to execute now that RESTRICT passed
        for (const target of targets) {
          const action = target.fk.onDelete;
          if (!action || action === "noAction" || action === "restrict") {
            continue;
          }

          const childFilter = this.buildCascadeChildFilter(records, target.fk);
          if (!childFilter) {
            continue;
          }

          switch (action) {
            case "cascade": {
              await target.deleteMany(childFilter);
              break;
            }
            case "setNull": {
              const nullData: Record<string, unknown> = {};
              for (const f of target.fk.fields) {
                nullData[f] = null;
              }
              await target.updateMany(childFilter, nullData);
              break;
            }
          }
        }
      });
    } finally {
      for (const key of addedKeys) {
        visited.delete(key);
      }
    }
  }

  needsCascade(cascadeResolver: TCascadeResolver | undefined): boolean {
    return !!cascadeResolver;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private recordKey(
    tableName: string,
    pkFields: string[],
    record: Record<string, unknown>,
  ): string {
    let key = tableName;
    for (const f of pkFields) {
      const v: unknown = record[f];
      key += `\0${v === null || v === undefined ? "" : String(v as string | number | boolean)}`;
    }
    return key;
  }

  /**
   * Builds a filter for child records whose FK matches the deleted parent's PK values.
   */
  private buildCascadeChildFilter(
    parentRecords: Array<Record<string, unknown>>,
    fk: Pick<TDbForeignKey, "fields" | "targetFields">,
  ): Record<string, unknown> | undefined {
    if (fk.fields.length === 1 && fk.targetFields.length === 1) {
      // Single-field FK: { fkField: { $in: [pk1, pk2, ...] } }
      const pkField = fk.targetFields[0];
      const values = parentRecords
        .map((r) => r[pkField])
        .filter((v) => v !== undefined && v !== null);
      if (values.length === 0) {
        return undefined;
      }
      return values.length === 1
        ? { [fk.fields[0]]: values[0] }
        : { [fk.fields[0]]: { $in: values } };
    }

    // Composite FK: { $or: [{ fk1: pk1, fk2: pk2 }, ...] }
    const orFilters: Array<Record<string, unknown>> = [];
    for (const record of parentRecords) {
      const condition: Record<string, unknown> = {};
      let valid = true;
      for (let i = 0; i < fk.fields.length; i++) {
        const val = record[fk.targetFields[i]];
        if (val === undefined || val === null) {
          valid = false;
          break;
        }
        condition[fk.fields[i]] = val;
      }
      if (valid) {
        orFilters.push(condition);
      }
    }
    if (orFilters.length === 0) {
      return undefined;
    }
    return orFilters.length === 1 ? orFilters[0] : { $or: orFilters };
  }
}
