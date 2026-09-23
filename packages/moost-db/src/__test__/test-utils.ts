import path from "path";

import { vi } from "vite-plus/test";
import { prepareFixtures as prepare } from "@atscript/typescript/test-utils";
import dbPlugin from "@atscript/db/plugin";
import type { HttpError } from "@moostjs/event-http";

/** Compiles the `.as` fixtures of this package (js + dts, written only when changed). */
export async function prepareFixtures(): Promise<void> {
  const fixturesDir = path.join(path.dirname(import.meta.url.slice(7)), "fixtures");
  await prepare({ rootDir: fixturesDir, plugins: [dbPlugin()] });
}

/** The structured 400 envelope's `errors` (wooks types `body` loosely). */
export function errorsOf(e: unknown): Array<{ path: string; message: string }> {
  return ((e as HttpError).body as unknown as { errors: Array<{ path: string; message: string }> })
    .errors;
}

/** Minimal Moost app mock: only `getLogger` is consulted by the controllers. */
export function createMockApp(): any {
  return {
    getLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
    }),
  };
}

/**
 * Adapter mock whose `withTransaction` records begin / commit / rollback into
 * `order` (shared with a {@link createMockReadable} table so the sequence of
 * transaction primitives and table calls can be asserted together).
 */
export function createMockAdapter(order: string[] = []) {
  const adapter = {
    begin: vi.fn(() => order.push("begin")),
    commit: vi.fn(() => order.push("commit")),
    rollback: vi.fn(() => order.push("rollback")),
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      adapter.begin();
      try {
        const r = await fn();
        adapter.commit();
        return r;
      } catch (e) {
        adapter.rollback();
        throw e;
      }
    },
  };
  return adapter;
}

/** A field descriptor entry as `TableMetadata` would build it — enough for the capability index. */
export function makeFieldDescriptor(
  path: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    path,
    physicalName: path.replace(/\./g, "__"),
    ignored: false,
    isIndexed: false,
    storage: "column",
    designType: "string",
    type: { metadata: new Map() },
    ...extra,
  };
}

/**
 * A complete readable / table mock: every member the controllers consult is
 * present (`fieldDescriptors`, `canFilterField`, `canSortField`, `flatMap`,
 * `navFields`, `relations`, `getAdapter`, …) so production code never needs
 * partial-mock tolerance. `fields` lists the leaf paths (descriptors +
 * flat-map entries); `overrides` replaces any member.
 */
export function createMockReadable(
  overrides: Record<string, unknown> = {},
  opts: { fields?: string[]; primaryKeys?: string[]; order?: string[] } = {},
): any {
  const order = opts.order ?? [];
  const primaryKeys = opts.primaryKeys ?? ["id"];
  const fields = opts.fields ?? ["id", "name"];
  const adapter = createMockAdapter(order);
  const validator = { validate: vi.fn().mockReturnValue(true), errors: [] as unknown[] };
  const flatMap = new Map<string, unknown>([["", { metadata: new Map() }]]);
  for (const f of fields) flatMap.set(f, { metadata: new Map() });
  const table = {
    tableName: "test_table",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap,
    navFields: new Set<string>(),
    ignoredFields: new Set<string>(),
    primaryKeys,
    preferredId: [...primaryKeys],
    identifications: [{ fields: [...primaryKeys], source: "primaryKey" }],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map(),
    fieldDescriptors: fields.map((f) =>
      makeFieldDescriptor(f, { isIndexed: primaryKeys.includes(f) }),
    ),
    isView: false,
    versionColumn: undefined as string | undefined,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    isGeoSearchable: vi.fn().mockReturnValue(false),
    canFilterField: vi.fn().mockReturnValue(true),
    canSortField: vi.fn().mockReturnValue(true),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    getValidator: vi.fn().mockReturnValue(validator),
    getAdapter: vi.fn(() => adapter),
    resolveIdFilter: vi.fn().mockImplementation((id: unknown) => {
      if (id === null || typeof id !== "object") return { id };
      const obj = id as Record<string, unknown>;
      return obj.id === undefined ? null : { id: obj.id };
    }),
    findOne: vi.fn(async () => {
      order.push("findOne");
      return null;
    }),
    findMany: vi.fn().mockResolvedValue([]),
    findManyWithCount: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    count: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue([]),
    insertOne: vi.fn(async () => {
      order.push("insertOne");
      return { insertedId: "1" };
    }),
    insertMany: vi.fn(async () => {
      order.push("insertMany");
      return { insertedCount: 2, insertedIds: ["1", "2"] };
    }),
    replaceOne: vi.fn(async () => {
      order.push("replaceOne");
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    bulkReplace: vi.fn(async () => {
      order.push("bulkReplace");
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    updateOne: vi.fn(async () => {
      order.push("updateOne");
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    bulkUpdate: vi.fn(async () => {
      order.push("bulkUpdate");
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    deleteOne: vi.fn(async () => {
      order.push("deleteOne");
      return { deletedCount: 1 };
    }),
    ...overrides,
  };
  return Object.assign(table, { adapter, validator, order });
}
