/**
 * `ClientLike<T, D>` (since 0.1.196): the public surface of `Client`, derived
 * from the class. A class-free object literal stands in for a `Client`; a
 * member missing from it is a type error. The helper aliases `Client`'s
 * signatures name are exported for such implementations.
 */
import { describe, it, expect, expectTypeOf } from "vite-plus/test";

import {
  Client,
  ClientError,
  type AggregateRows,
  type ClientLike,
  type InsertedRow,
  type MetaResponse,
  type ReadRow,
  type SingleInsertOf,
} from "../index";

// Synthetic Atscript-shaped type (generic model).
declare class Item {
  id: number;
  name: string;
  static __is_atscript_annotated_type: true;
  static type: { __dataType?: Item };
  static __ownProps: { id: number; name: string };
  static __navProps: Record<never, never>;
  static __pk: number;
}

const META = { fields: {} } as unknown as MetaResponse;

/** What a read-only implementation answers for an operation it cannot perform. */
function notSupported(operation: string): Promise<never> {
  return Promise.reject(
    new ClientError(400, {
      message: `${operation} is not supported`,
      statusCode: 400,
      code: "NOT_SUPPORTED",
    }),
  );
}

/**
 * A read-only stand-in: no class, every member present. The generic read
 * methods return rows typed by the call's query, so plain rows are cast.
 */
function readOnlyItems(rows: Array<{ id: number; name: string }>): ClientLike<typeof Item> {
  return {
    meta: async () => META,
    query: async () => rows as never,
    pages: async () =>
      ({ data: rows, page: 1, itemsPerPage: rows.length, pages: 1, count: rows.length }) as never,
    one: async (id) => rows.find((row) => row.id === id) ?? null,
    count: async () => rows.length,
    getValidator: () => notSupported("getValidator"),
    invalidateMeta: () => {},
    metaEtag: () => undefined,
    metaStore: undefined,
    availableActions: async () => ({ actions: [] }),
    getActionForm: async () => null,
    getActionFormTexts: async () => undefined,
    aggregate: () => notSupported("aggregate"),
    geoSearch: () => notSupported("geoSearch"),
    geoPages: () => notSupported("geoPages"),
    insert: () => notSupported("insert"),
    update: () => notSupported("update"),
    replace: () => notSupported("replace"),
    remove: () => notSupported("remove"),
    action: () => notSupported("action"),
    actionOnQuery: () => notSupported("actionOnQuery"),
    countActionTarget: () => notSupported("countActionTarget"),
  };
}

describe("ClientLike", () => {
  it("a class-free object literal satisfies it and answers through it", async () => {
    const items = readOnlyItems([{ id: 1, name: "a" }]);
    expect(await items.query()).toEqual([{ id: 1, name: "a" }]);
    expect(await items.one(1)).toEqual({ id: 1, name: "a" });
    const error = await items.insert({ name: "b" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ status: 400, body: { code: "NOT_SUPPORTED" } });
  });

  it("is the class's public surface: a Client is one, private members are not part of it", () => {
    const client = new Client<typeof Item>("/api/items");
    expectTypeOf(client).toMatchTypeOf<ClientLike<typeof Item>>();
    expectTypeOf<ClientLike<typeof Item>>().not.toHaveProperty("_path");
    expectTypeOf<keyof ClientLike<typeof Item>>().toEqualTypeOf<keyof Client<typeof Item>>();
  });

  it("requires every member", () => {
    const { query: _query, ...rest } = readOnlyItems([]);
    // @ts-expect-error — `query` is missing
    const incomplete: ClientLike<typeof Item> = rest;
    expect(incomplete).toBeDefined();
  });

  it("keeps the signatures: overloads and typed rows", () => {
    type Items = ClientLike<typeof Item>;
    expectTypeOf<Awaited<ReturnType<Items["count"]>>>().toEqualTypeOf<number>();
    expectTypeOf<ReadRow<typeof Item, {}, {}>>().toHaveProperty("name");
    expectTypeOf<InsertedRow<typeof Item, {}>>().toHaveProperty("id");
    expectTypeOf<SingleInsertOf<typeof Item>>().toHaveProperty("name");
    expectTypeOf<
      AggregateRows<{ name: string }, { controls: { $groupBy: ["name"]; $select: ["name"] } }>
    >().toBeArray();
  });
});
