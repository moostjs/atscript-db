import type { FilterExpr } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import type { TableMetadata } from "../table/table-metadata";
import type { TCascadeResolver, TFkLookupResolver, TWriteTableResolver } from "../types";

/**
 * Result of {@link IntegrityStrategy.cascadeBeforeDelete}:
 * - `undefined` — no cascade ran, or the filter holds no relational
 *   predicate; delete with the caller's own filter;
 * - an array — the rows the cascade ran for, pinned by primary key as
 *   ADAPTER-READY (physical, already translated) filters, in batches. The
 *   caller must delete exactly these rows instead of evaluating its filter
 *   again: the cascade changed the data the filter may read (a relational
 *   predicate on a child relation no longer matches once the children are
 *   gone). An empty array means no row matched.
 */
export type TCascadePin = FilterExpr[] | undefined;

/**
 * Strategy for referential integrity enforcement.
 * Two implementations: {@link NativeIntegrity} (DB handles FK constraints)
 * and `ApplicationIntegrity` (generic layer validates + cascades).
 */
export abstract class IntegrityStrategy {
  abstract validateForeignKeys(
    items: Array<Record<string, unknown>>,
    meta: TableMetadata,
    fkLookupResolver: TFkLookupResolver | undefined,
    writeTableResolver: TWriteTableResolver | undefined,
    partial?: boolean,
    excludeTargetTable?: string,
  ): Promise<void>;

  abstract cascadeBeforeDelete(
    filter: FilterExpr,
    tableName: string,
    meta: TableMetadata,
    cascadeResolver: TCascadeResolver,
    translateFilter: (f: FilterExpr) => FilterExpr,
    adapter: BaseDbAdapter,
  ): Promise<TCascadePin>;

  abstract needsCascade(cascadeResolver: TCascadeResolver | undefined): boolean;
}

/**
 * Integrity strategy for adapters with native FK support (e.g. SQLite, MySQL).
 * All operations are no-ops — the database engine enforces constraints.
 */
export class NativeIntegrity extends IntegrityStrategy {
  async validateForeignKeys(): Promise<void> {
    // No-op: DB validates FK constraints on write
  }

  async cascadeBeforeDelete(): Promise<TCascadePin> {
    // No-op: DB handles ON DELETE CASCADE/SET NULL
    return undefined;
  }

  needsCascade(): boolean {
    return false;
  }
}
