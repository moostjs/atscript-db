import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";

// ── Mock table (mirrors as-db.controller.spec.ts shape) ─────────────────────

function deriveIdentifications(
  primaryKeys: readonly string[],
): Array<{ fields: readonly string[]; source: string }> {
  if (primaryKeys.length === 0) return [];
  return [{ fields: [...primaryKeys], source: "primaryKey" }];
}

function createMockTable(overrides: Record<string, any> = {}) {
  const mockValidator = {
    validate: vi.fn().mockReturnValue(true),
    errors: [],
  };
  const primaryKeys = overrides.primaryKeys ?? ["id"];
  const identifications = overrides.identifications ?? deriveIdentifications(primaryKeys);
  return {
    tableName: "users",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap: new Map([
      ["", {} as any],
      ["id", {} as any],
      ["name", {} as any],
      ["version", {} as any],
    ]),
    primaryKeys,
    preferredId: primaryKeys,
    identifications,
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map(),
    fieldDescriptors: [
      { path: "id", ignored: false, isIndexed: true },
      { path: "name", ignored: false, isIndexed: false },
      { path: "version", ignored: false, isIndexed: false },
    ],
    isView: false,
    versionColumn: "version" as string | undefined,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    canFilterField: vi.fn().mockReturnValue(true),
    canSortField: vi.fn().mockReturnValue(true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    getValidator: vi.fn().mockReturnValue(mockValidator),
    resolveIdFilter: vi.fn().mockImplementation((id: unknown) => {
      if (id === null || typeof id !== "object") return { id };
      // Pick only PK fields — mirrors real `resolveIdFilter`'s PK extraction.
      const obj = id as Record<string, unknown>;
      const filter: Record<string, unknown> = {};
      for (const pk of primaryKeys) {
        if (obj[pk] !== undefined) filter[pk] = obj[pk];
      }
      return Object.keys(filter).length > 0 ? filter : null;
    }),
    findOne: vi.fn().mockResolvedValue(null),
    insertOne: vi.fn().mockResolvedValue({ insertedId: "1" }),
    insertMany: vi.fn().mockResolvedValue({ insertedCount: 0, insertedIds: [] }),
    replaceOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    bulkReplace: vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
    bulkUpdate: vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    ...overrides,
  } as any;
}

function createMockApp() {
  return {
    getLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
    }),
  } as any;
}

function createController(tableOverrides: Record<string, any> = {}) {
  const table = createMockTable(tableOverrides);
  const app = createMockApp();
  const controller = new AsDbController(app, table);
  return { controller, table, app };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("AsDbController OCC integration", () => {
  // WHY: clients use `versionColumn` in `/meta` to decide whether to round-trip
  // the `version` field — without this pointer the auto-lift is invisible to
  // consumers and the whole feature would be undiscoverable from the wire.
  describe("GET /meta — versionColumn pointer", () => {
    it("includes versionColumn for versioned tables", async () => {
      const { controller } = createController();
      const meta = await controller.meta();
      expect(meta.versionColumn).toBe("version");
    });

    // WHY: non-versioned tables must look identical to today (backward compat).
    it("omits versionColumn for non-versioned tables", async () => {
      const { controller } = createController({ versionColumn: undefined });
      const meta = await controller.meta();
      expect(meta.versionColumn).toBeUndefined();
    });
  });

  // ── PATCH ────────────────────────────────────────────────────────────
  describe("PATCH / — auto-lift `version` → `$cas`", () => {
    let controller: AsDbController;
    let table: ReturnType<typeof createMockTable>;
    beforeEach(() => {
      const ctx = createController();
      controller = ctx.controller;
      table = ctx.table;
    });

    // WHY: happy path — the version round-trip + auto-lift must produce the
    // exact `$cas` shape the SDK validates, with `version` stripped from SET.
    it("strips version and lifts to $cas on matching update", async () => {
      table.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
      const result = await controller.update({ id: "u1", name: "Ada", version: 4 });
      expect(table.updateOne).toHaveBeenCalledWith({
        id: "u1",
        name: "Ada",
        $cas: { version: 4 },
      });
      expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    });

    // WHY: the load-bearing conflict signal — clients depend on `409 +
    // version_mismatch + currentVersion` to know they must re-fetch.
    it("returns 409 with version_mismatch when row exists but version is stale", async () => {
      table.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      table.findOne.mockResolvedValue({ id: "u1", name: "Ada", version: 6 });
      const result = await controller.update({ id: "u1", name: "Ada", version: 4 });
      expect(result).toBeInstanceOf(HttpError);
      const body = (result as HttpError).body as unknown as Record<string, unknown>;
      // NOTE: the Wooks `HttpError.body` getter forcibly stamps
      // `error: "Conflict"` from the canonical status text, overriding our
      // discriminator. We carry the proposal's `error: "version_mismatch"`
      // intent in `message` (and as an explicit `kind`). Clients pivot on
      // `kind`/`message` + `currentVersion`.
      expect(body.statusCode).toBe(409);
      expect(body.message).toBe("version_mismatch");
      expect(body.kind).toBe("version_mismatch");
      expect(body.currentVersion).toBe(6);
      expect(table.findOne).toHaveBeenCalledTimes(1);
      // The findOne uses the PK filter only — not the original payload.
      expect(table.findOne).toHaveBeenCalledWith(expect.objectContaining({ filter: { id: "u1" } }));
    });

    // WHY: §6.3 disambiguation — clients can't tell missing vs. stale from
    // `matchedCount === 0` alone, so the controller pays one `findOne` to
    // produce a meaningful HTTP status.
    it("returns 404 when row is missing on a CAS-protected update", async () => {
      table.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      table.findOne.mockResolvedValue(null);
      const result = await controller.update({ id: "u1", name: "Ada", version: 4 });
      expect(result).toBeInstanceOf(HttpError);
      expect((result as HttpError).body.statusCode).toBe(404);
    });

    // WHY: presence-based opt-out from §6.2 — clients that strip `version`
    // get last-write-wins (no `$cas` predicate, no extra `findOne` on 0-match).
    it("does NOT lift or disambiguate when version is absent (last-write-wins)", async () => {
      table.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      const result = await controller.update({ id: "u1", name: "Ada" });
      expect(table.updateOne).toHaveBeenCalledWith({ id: "u1", name: "Ada" });
      const arg = table.updateOne.mock.calls[0]![0];
      expect(arg).not.toHaveProperty("$cas");
      expect(table.findOne).not.toHaveBeenCalled();
      // No CAS → result passes through verbatim, even with matchedCount === 0.
      expect(result).toEqual({ matchedCount: 0, modifiedCount: 0 });
    });

    // WHY: `versionColumn === undefined` must short-circuit the entire
    // auto-lift path — otherwise non-versioned tables would behave
    // differently when callers happened to include a `version` field.
    it("non-versioned table: version is treated as a regular SET field", async () => {
      const ctx = createController({ versionColumn: undefined });
      ctx.table.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
      await ctx.controller.update({ id: "u1", version: 5 });
      // Payload passes through unchanged; the SDK validator decides what to do
      // with `version` (likely reject as unknown column). The controller does
      // NOT inject `$cas` and does NOT run the disambiguation `findOne`.
      expect(ctx.table.updateOne).toHaveBeenCalledWith({ id: "u1", version: 5 });
      expect(ctx.table.findOne).not.toHaveBeenCalled();
    });
  });

  // ── PUT ──────────────────────────────────────────────────────────────
  describe("PUT / — replace path mirrors PATCH", () => {
    let controller: AsDbController;
    let table: ReturnType<typeof createMockTable>;
    beforeEach(() => {
      const ctx = createController();
      controller = ctx.controller;
      table = ctx.table;
    });

    // WHY: replace must behave identically to update for OCC (§9.2) — single
    // semantic across both verbs keeps clients simple.
    it("strips version and lifts to $cas on matching replace", async () => {
      table.replaceOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
      await controller.replace({ id: "u1", name: "Ada", version: 4 });
      expect(table.replaceOne).toHaveBeenCalledWith({
        id: "u1",
        name: "Ada",
        $cas: { version: 4 },
      });
    });

    // WHY: same load-bearing conflict signal as PATCH but on the replace verb.
    it("returns 409 with version_mismatch on stale replace", async () => {
      table.replaceOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      table.findOne.mockResolvedValue({ id: "u1", name: "Ada", version: 9 });
      const result = await controller.replace({ id: "u1", name: "Ada", version: 4 });
      expect(result).toBeInstanceOf(HttpError);
      const body = (result as HttpError).body as unknown as Record<string, unknown>;
      expect(body.statusCode).toBe(409);
      expect(body.message).toBe("version_mismatch");
      expect(body.kind).toBe("version_mismatch");
      expect(body.currentVersion).toBe(9);
    });
  });

  // ── Bulk ────────────────────────────────────────────────────────────
  describe("PATCH / (array) — per-item auto-lift", () => {
    // WHY: per §6.4 bulk threads each item's version → its own `$cas`.
    // Per-item conflict disambiguation in the response body is deferred for
    // v1 (documented in code) — but the auto-lift itself must thread
    // correctly so the SDK applies the version predicate independently per
    // row.
    it("lifts version per item in array payload", async () => {
      const { controller, table } = createController();
      table.bulkUpdate.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });
      await controller.update([
        { id: "u1", name: "A", version: 1 },
        { id: "u2", name: "B", version: 2 },
        { id: "u3", name: "C" }, // no version → no $cas
      ]);
      const arg = table.bulkUpdate.mock.calls[0]![0];
      expect(arg).toEqual([
        { id: "u1", name: "A", $cas: { version: 1 } },
        { id: "u2", name: "B", $cas: { version: 2 } },
        { id: "u3", name: "C" },
      ]);
    });

    // WHY: aggregate response surfaces partial application — `modifiedCount <
    // matchedCount` (or both 0) is how callers detect bulk mismatches until
    // per-item disambiguation lands.
    it("returns aggregate { matchedCount, modifiedCount } from bulkUpdate", async () => {
      const { controller, table } = createController();
      table.bulkUpdate.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });
      const result = await controller.update([
        { id: "u1", name: "A", version: 1 },
        { id: "u2", name: "B", version: 2 },
        { id: "u3", name: "C", version: 99 }, // mismatched in real life
      ]);
      expect(result).toEqual({ matchedCount: 2, modifiedCount: 2 });
    });
  });
});
