import type { FilterExpr } from "@uniqu/core";

import type { BaseDbAdapter } from "../base-adapter";
import type { TableMetadata } from "../table/table-metadata";
import type { TCascadeResolver, TFkLookupResolver, TWriteTableResolver } from "../types";

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
  ): Promise<void>;

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

  async cascadeBeforeDelete(): Promise<void> {
    // No-op: DB handles ON DELETE CASCADE/SET NULL
  }

  needsCascade(): boolean {
    return false;
  }
}
