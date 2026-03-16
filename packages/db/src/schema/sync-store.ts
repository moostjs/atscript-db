import { AtscriptDbTable } from "../table/db-table";
import { AtscriptDbView } from "../table/db-view";
import type { AtscriptDbReadable } from "../table/db-readable";
import type { DbSpace } from "../table/db-space";
import type { TTableSnapshot, TViewSnapshot } from "./schema-hash";

// ── SyncStore ────────────────────────────────────────────────────────────

export class SyncStore {
  private controlTable: AtscriptDbTable | undefined;

  constructor(private readonly space: DbSpace) {}

  // ── Control table ─────────────────────────────────────────────────────

  async ensureControlTable(): Promise<void> {
    if (!this.controlTable) {
      const { AtscriptControl } = await import("./control.as");
      this.controlTable = this.space.getTable(AtscriptControl);
    }
    await this.controlTable.ensureTable();
  }

  async readControlValue(_id: string): Promise<string | null> {
    const row = await this.controlTable!.findOne({
      filter: { _id: { $eq: _id } },
      controls: {},
    });
    return ((row as Record<string, unknown> | null)?.value as string | null) ?? null;
  }

  async writeControlValue(_id: string, value: string): Promise<void> {
    const existing = await this.readControlValue(_id);
    if (existing !== null) {
      await this.controlTable!.replaceOne({ _id, value } as any);
    } else {
      await this.controlTable!.insertOne({ _id, value } as any);
    }
  }

  // ── Schema hash ───────────────────────────────────────────────────────

  async readHash(): Promise<string | null> {
    return this.readControlValue("schema_version");
  }

  async writeHash(hash: string): Promise<void> {
    await this.writeControlValue("schema_version", hash);
  }

  // ── Table snapshot storage ────────────────────────────────────────────

  async readTableSnapshot(tableName: string): Promise<TTableSnapshot | null>;
  async readTableSnapshot(tableName: string, asView: true): Promise<TViewSnapshot | null>;
  async readTableSnapshot(
    tableName: string,
    _asView?: boolean,
  ): Promise<TTableSnapshot | TViewSnapshot | null> {
    const value = await this.readControlValue(`table_snapshot:${tableName}`);
    return value ? JSON.parse(value) : null;
  }

  async writeTableSnapshot(
    tableName: string,
    snapshot: TTableSnapshot | TViewSnapshot,
  ): Promise<void> {
    await this.writeControlValue(`table_snapshot:${tableName}`, JSON.stringify(snapshot));
  }

  async deleteTableSnapshot(tableName: string): Promise<void> {
    try {
      await this.controlTable!.deleteOne(`table_snapshot:${tableName}` as any);
    } catch {
      /* best effort */
    }
  }

  // ── Table tracking ────────────────────────────────────────────────────

  async readTrackedList(): Promise<
    Array<{ name: string; isView: boolean; viewType?: "V" | "M" | "E" }>
  > {
    const value = await this.readControlValue("synced_tables");
    if (!value) {
      return [];
    }
    const parsed = JSON.parse(value);
    // Backwards-compatible: old format was string[], then { name, isView }[]
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string") {
      return (parsed as string[]).map((name) => ({ name, isView: false }));
    }
    // Entries without viewType default to 'V' for views
    const entries = parsed as Array<{ name: string; isView: boolean; viewType?: "V" | "M" | "E" }>;
    for (const e of entries) {
      e.viewType ??= e.isView ? "V" : undefined;
    }
    return entries;
  }

  async writeTrackedList(readables: AtscriptDbReadable[]): Promise<void> {
    const entries = readables.map((r) => {
      const isView = r.isView;
      let viewType: "V" | "M" | "E" | undefined;
      if (isView) {
        const view = r as AtscriptDbView;
        viewType = view.isExternal ? "E" : view.viewPlan.materialized ? "M" : "V";
      }
      return { name: r.tableName, isView, viewType };
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    await this.writeControlValue("synced_tables", JSON.stringify(entries));
  }

  // ── Distributed lock ──────────────────────────────────────────────────

  async tryAcquireLock(podId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();

    const existing = (await this.controlTable!.findOne({
      filter: { _id: { $eq: "sync_lock" } },
      controls: {},
    })) as Record<string, unknown> | null;

    if (existing) {
      const expiresAt = existing.expiresAt as number;
      if (expiresAt && expiresAt < now) {
        await this.controlTable!.deleteOne("sync_lock" as any);
      } else {
        return false;
      }
    }

    try {
      await this.controlTable!.insertOne({
        _id: "sync_lock",
        lockedBy: podId,
        lockedAt: now,
        expiresAt: now + ttlMs,
      } as any);
      return true;
    } catch {
      return false;
    }
  }

  async refreshLock(podId: string, ttlMs: number): Promise<"refreshed" | "stolen" | "missing"> {
    const existing = (await this.controlTable!.findOne({
      filter: { _id: { $eq: "sync_lock" } },
      controls: {},
    })) as Record<string, unknown> | null;

    if (!existing) {
      return "missing";
    }
    if (existing.lockedBy !== podId) {
      return "stolen";
    }

    await this.controlTable!.replaceOne({
      _id: "sync_lock",
      lockedBy: podId,
      lockedAt: existing.lockedAt,
      expiresAt: Date.now() + ttlMs,
    } as any);

    return "refreshed";
  }

  async releaseLock(podId: string): Promise<void> {
    try {
      const existing = (await this.controlTable!.findOne({
        filter: { _id: { $eq: "sync_lock" } },
        controls: {},
      })) as Record<string, unknown> | null;

      if (existing && existing.lockedBy === podId) {
        await this.controlTable!.deleteOne("sync_lock" as any);
      }
    } catch {
      // Best effort — lock will expire anyway
    }
  }

  async waitForLock(timeoutMs: number, pollIntervalMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const lock = (await this.controlTable!.findOne({
        filter: { _id: { $eq: "sync_lock" } },
        controls: {},
      })) as Record<string, unknown> | null;

      if (!lock) {
        return;
      }

      const expiresAt = lock.expiresAt as number;
      if (expiresAt && expiresAt < Date.now()) {
        await this.controlTable!.deleteOne("sync_lock" as any);
        return;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollIntervalMs);
      });
    }

    throw new Error(`Schema sync lock wait timed out after ${timeoutMs}ms`);
  }
}

// ── Public snapshot reader ───────────────────────────────────────────────

/**
 * Reads a stored table snapshot from the control table.
 * Use this for introspection/test utilities without coupling to control table internals.
 */
export async function readStoredSnapshot(
  space: DbSpace,
  tableName: string,
): Promise<TTableSnapshot | null>;
export async function readStoredSnapshot(
  space: DbSpace,
  tableName: string,
  asView: true,
): Promise<TViewSnapshot | null>;
export async function readStoredSnapshot(
  space: DbSpace,
  tableName: string,
  _asView?: boolean,
): Promise<TTableSnapshot | TViewSnapshot | null> {
  const { AtscriptControl } = await import("./control.as");
  const table = space.getTable(AtscriptControl);
  await table.ensureTable();
  const row = await table.findOne({
    filter: { _id: { $eq: `table_snapshot:${tableName}` } },
    controls: {},
  });
  const value = ((row as Record<string, unknown> | null)?.value as string | null) ?? null;
  return value ? JSON.parse(value) : null;
}
