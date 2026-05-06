import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";

/**
 * Task 3.3 / spec `db-column-query-gate`:
 * Verifies the `@db.table.filterable 'manual'` / `@db.table.sortable 'manual'`
 * gate rejects filter/sort clauses on un-annotated fields and lets them through
 * on annotated ones (or everywhere, in default-open mode).
 */

function makeFieldEntry(annotations: Partial<AtscriptMetadata> = {}) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "", designType: "string", tags: new Set() },
    metadata: new Map(Object.entries(annotations)),
  } as any;
}

// Mirror the BaseDbAdapter / MongoAdapter capability defaults: SQL adapters
// can't filter/sort on JSON-stored fields; Mongo can filter (arrays / dot-paths)
// but inherits the conservative sort default.
const sqlCanFilterOrSort = (fd: { storage: string }) => fd.storage !== "json";

function makeMockTable({
  tableMeta = {} as Record<string, unknown>,
  fields = {} as Record<string, Partial<AtscriptMetadata>>,
  fieldStorage = {} as Record<string, "column" | "flattened" | "json">,
  fieldIndexed = {} as Record<string, boolean>,
  adapterMode = "sql" as "sql" | "mongo",
}) {
  const flatMap = new Map<string, unknown>();
  for (const [path, annotations] of Object.entries(fields)) {
    flatMap.set(path, makeFieldEntry(annotations));
  }
  const fieldDescriptors = Array.from(flatMap.entries()).map(([path, type]) => ({
    path,
    ignored: false,
    isIndexed: fieldIndexed[path] ?? false,
    storage: fieldStorage[path] ?? "column",
    type,
  }));
  const canFilterField =
    adapterMode === "mongo" ? vi.fn(() => true) : vi.fn((fd: any) => sqlCanFilterOrSort(fd));
  const canSortField = vi.fn((fd: any) => sqlCanFilterOrSort(fd));
  return {
    tableName: "gated_table",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(Object.entries(tableMeta)),
    },
    flatMap,
    primaryKeys: ["id"],
    preferredId: ["id"],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map(),
    fieldDescriptors,
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    canFilterField,
    canSortField,
    getSearchIndexes: vi.fn().mockReturnValue([]),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
  } as any;
}

function makeApp() {
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

function makeController(table: any) {
  return new AsDbController(table, makeApp());
}

describe("AsDbController — @db.column.filterable / @db.column.sortable gate", () => {
  // ── Default-open (back-compat) ────────────────────────────────────────

  it("without @db.table.filterable 'manual' accepts any filter field", async () => {
    const table = makeMockTable({
      tableMeta: {},
      fields: { email: {} },
    });
    const controller = makeController(table);
    const result = await controller.query("?email=foo");
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.findMany).toHaveBeenCalled();
  });

  // ── Filter-manual mode ────────────────────────────────────────────────

  it("with @db.table.filterable 'manual' rejects filter on un-annotated field", async () => {
    const table = makeMockTable({
      tableMeta: { "db.table.filterable": "manual" },
      fields: {
        email: { "db.column.filterable": true },
        name: {},
      },
    });
    const controller = makeController(table);
    const result = await controller.query("?name=Alice");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toContain('"name"');
    expect(table.findMany).not.toHaveBeenCalled();
  });

  it("with @db.table.filterable 'manual' accepts filter on @db.column.filterable field", async () => {
    const table = makeMockTable({
      tableMeta: { "db.table.filterable": "manual" },
      fields: {
        email: { "db.column.filterable": true },
        name: {},
      },
    });
    const controller = makeController(table);
    const result = await controller.query("?email=foo");
    expect(result).not.toBeInstanceOf(HttpError);
    expect(table.findMany).toHaveBeenCalled();
  });

  // ── Sort-manual mode ──────────────────────────────────────────────────

  it("with @db.table.sortable 'manual' rejects sort on un-annotated field", async () => {
    const table = makeMockTable({
      tableMeta: { "db.table.sortable": "manual" },
      fields: {
        createdAt: { "db.column.sortable": true },
        name: {},
      },
    });
    const controller = makeController(table);
    const result = await controller.query("?$sort=name");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).message).toContain('"name"');
  });

  it("with @db.table.sortable 'manual' accepts sort on @db.column.sortable field", async () => {
    const table = makeMockTable({
      tableMeta: { "db.table.sortable": "manual" },
      fields: {
        createdAt: { "db.column.sortable": true },
        name: {},
      },
    });
    const controller = makeController(table);
    const result = await controller.query("?$sort=createdAt");
    expect(result).not.toBeInstanceOf(HttpError);
  });

  // ── Independent application of filter & sort gates ────────────────────

  it("filter gate applies independently from sort gate", async () => {
    const table = makeMockTable({
      tableMeta: { "db.table.filterable": "manual" },
      fields: {
        email: { "db.column.filterable": true },
        name: {},
      },
    });
    const controller = makeController(table);
    // Filter forbidden — blocked.
    expect(await controller.query("?name=x")).toBeInstanceOf(HttpError);
    // Sort is open because no sortable-manual flag.
    expect(await controller.query("?$sort=name")).not.toBeInstanceOf(HttpError);
  });
});

describe("AsDbController — /meta capability flags (adapter-gated)", () => {
  // ── SQL default: JSON storage cannot be filtered or sorted ────────────

  it("SQL adapter: @db.json field is neither filterable nor sortable", async () => {
    const table = makeMockTable({
      fields: { name: {}, address: {} },
      fieldStorage: { address: "json" },
    });
    const controller = makeController(table);
    const meta = await controller.meta();
    expect(meta.fields.address).toEqual({ filterable: false, sortable: false });
  });

  it("SQL adapter: array field (storage='json') is neither filterable nor sortable", async () => {
    const table = makeMockTable({
      fields: { name: {}, tags: {} },
      fieldStorage: { tags: "json" },
    });
    const controller = makeController(table);
    const meta = await controller.meta();
    expect(meta.fields.tags).toEqual({ filterable: false, sortable: false });
  });

  it("SQL adapter: scalar fields keep default-open filter/sort behavior", async () => {
    const table = makeMockTable({
      fields: { name: {}, createdAt: {} },
      fieldIndexed: { createdAt: true },
    });
    const controller = makeController(table);
    const meta = await controller.meta();
    // Default-open: any scalar is filterable; sortable derived from isIndexed.
    expect(meta.fields.name).toEqual({ filterable: true, sortable: false });
    expect(meta.fields.createdAt).toEqual({ filterable: true, sortable: true });
  });

  it("SQL adapter: explicit @db.column.filterable on a JSON field is overridden by adapter gate", async () => {
    const table = makeMockTable({
      tableMeta: { "db.table.filterable": "manual" },
      fields: {
        name: { "db.column.filterable": true },
        address: { "db.column.filterable": true },
      },
      fieldStorage: { address: "json" },
    });
    const controller = makeController(table);
    const meta = await controller.meta();
    // Annotated scalar field still gets through.
    expect(meta.fields.name.filterable).toBe(true);
    // Adapter veto wins over the explicit annotation on the JSON-stored field.
    expect(meta.fields.address.filterable).toBe(false);
  });

  // ── Mongo: JSON storage IS filterable (adapter-native dot-paths / arrays) ─

  it("Mongo-like adapter: @db.json field is filterable but not sortable", async () => {
    const table = makeMockTable({
      adapterMode: "mongo",
      fields: { name: {}, address: {} },
      fieldStorage: { address: "json" },
    });
    const controller = makeController(table);
    const meta = await controller.meta();
    expect(meta.fields.address).toEqual({ filterable: true, sortable: false });
  });

  it("Mongo-like adapter: array field is filterable but not sortable", async () => {
    const table = makeMockTable({
      adapterMode: "mongo",
      fields: { name: {}, tags: {} },
      fieldStorage: { tags: "json" },
    });
    const controller = makeController(table);
    const meta = await controller.meta();
    expect(meta.fields.tags).toEqual({ filterable: true, sortable: false });
  });
});
