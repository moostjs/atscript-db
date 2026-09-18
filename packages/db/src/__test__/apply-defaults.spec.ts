import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import type { TDbDefaultFn, TDbWriteGuardContext } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

let DefaultItem: any;

/**
 * Defaults pass contract (since 0.1.128): static `@db.default 'x'` values
 * are filled on EVERY adapter — including one that carries the same value in
 * its DDL `DEFAULT` clause — so write guards and validators see the full row.
 * Function defaults stay adapter-native: `now` / `uuid` are generated
 * SDK-side only when the adapter does not list them in `nativeDefaultFns()`.
 * The pass has no public wrapper; it is observed through a write `guard`
 * (the plaintext rows) and through what the adapter receives.
 */

/** An adapter with DDL value defaults and a native `now` (the SQLite / Postgres shape). */
class NativeDefaultsAdapter extends MockAdapter {
  override supportsNativeValueDefaults(): boolean {
    return true;
  }
  override nativeDefaultFns(): ReadonlySet<TDbDefaultFn> {
    return new Set<TDbDefaultFn>(["now", "increment"]);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Inserts `rows` and returns the rows a guard saw (defaults applied, plaintext). */
async function rowsSeenByGuard(
  table: AtscriptDbTable,
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  let seen: Array<Record<string, unknown>> = [];
  await table.insertMany(rows as any[], {
    guard: (ctx: TDbWriteGuardContext<any>) => {
      seen = ctx.rows;
    },
  });
  return seen;
}

describe("defaults — value defaults on every adapter, function defaults adapter-native", () => {
  beforeAll(async () => {
    await prepareFixtures();
    ({ DefaultItem } = await import("./fixtures/apply-defaults.as"));
  });

  describe("adapter with native value defaults", () => {
    let adapter: NativeDefaultsAdapter;
    let table: AtscriptDbTable;

    beforeEach(() => {
      adapter = new NativeDefaultsAdapter();
      table = new AtscriptDbTable(DefaultItem, adapter);
    });

    it("fills every static value default (typed per design type) but not the native `now`", async () => {
      await table.insertOne({ id: 1, name: "a" } as any);
      const insertCall = adapter.calls.find((c) => c.method === "insertMany");
      const row = insertCall!.args[0][0] as Record<string, unknown>;
      expect(row.status).toBe("todo"); // union of string literals → raw string
      expect(row.archived).toBe(false); // boolean → JSON-parsed
      expect(row.score).toBe(0); // number → JSON-parsed
      expect(row.prefs).toBe('{"theme":"light"}'); // JSON column: parsed to an object, serialized for storage
      expect(row).not.toHaveProperty("createdAt"); // native fn default → left to the engine
      expect(typeof row.token).toBe("string"); // uuid not native on this mock → SDK-generated
      expect(row.token).toMatch(UUID_RE);
    });

    it("a write guard sees the defaults applied in place and explicit values never overridden", async () => {
      const rows = await rowsSeenByGuard(table, [
        { id: 1, name: "a" },
        { id: 2, name: "b", status: "done", score: 9, archived: true },
      ]);
      expect(rows[0]).toMatchObject({ status: "todo", archived: false, score: 0 });
      expect(rows[0]!.prefs).toEqual({ theme: "light" }); // still the plaintext object at guard time
      expect(rows[0]).not.toHaveProperty("createdAt");
      expect(rows[0]!.token).toMatch(UUID_RE);
      expect(rows[1]).toMatchObject({ status: "done", score: 9, archived: true });
    });

    it("replace fills value defaults the same way", async () => {
      await table.replaceOne({ id: 1, name: "a" } as any);
      const replaceCall = adapter.calls.find((c) => c.method === "replaceOne");
      const row = replaceCall!.args[1] as Record<string, unknown>;
      expect(row).toMatchObject({ status: "todo", archived: false, score: 0 });
      expect(row).not.toHaveProperty("createdAt");
    });
  });

  describe("adapter without native defaults (document-store shape)", () => {
    it("fills value defaults AND generates `now` / `uuid` SDK-side", async () => {
      const table = new AtscriptDbTable(DefaultItem, new MockAdapter());
      const rows = await rowsSeenByGuard(table, [{ id: 1, name: "a" }]);
      expect(rows[0]).toMatchObject({ status: "todo", archived: false, score: 0 });
      expect(typeof rows[0]!.createdAt).toBe("number");
      expect(rows[0]!.token).toMatch(UUID_RE);
    });
  });
});
