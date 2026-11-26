import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import dbPlugin from "../plugin";
import { acceptsFilterValue } from "../query/filter-values";
import { DbSpace } from "../table/db-space";
import type { TDbDefaultFn, TDbInsertManyResult } from "../types";
import { MockAdapter, prepareFixtures } from "./test-utils";

/**
 * `@db.default.store` (since 0.1.196): the store fills this value when an
 * insert leaves it out — for a store that assigns keys itself. The SDK never
 * fills it; a table with one needs an adapter that lists `"store"` in
 * `nativeDefaultFns()`.
 */

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "default-store-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  // errors only (a primitive `@db.json` field also gets its J1 warning)
  return [...(await repo.diagnostics()).values()]
    .flat()
    .filter((m) => m.severity === 1)
    .map((m) => m.message);
}

function table(fields: string): string {
  return `
    @db.table 'dc_rows'
    export interface DcRow {
      @meta.id
      id: number
      ${fields}
    }
  `;
}

describe("compile rule", () => {
  it("a scalar field — a key, a nested field, a literal union — compiles", async () => {
    expect(
      await diagnosticsFor(`
        @db.table 'dc_orders'
        export interface DcOrder {
          @meta.id
          @db.default.store
          orderNo: string
          @db.default.store
          seq: number
          @db.default.store
          kind: 'a' | 'b'
          audit: {
            @db.default.store
            stamp?: string
          }
        }
      `),
    ).toEqual([]);
  });

  it("not on an array field", async () => {
    expect(await diagnosticsFor(table("@db.default.store\ntags: string[]"))).toEqual([
      "@db.default.store requires a scalar field — the store fills a column",
    ]);
  });

  it("not on an object field", async () => {
    expect(await diagnosticsFor(table("@db.default.store\nbox: { a: string }"))).toEqual([
      "@db.default.store requires a scalar field — the store fills a column",
    ]);
  });

  it("not inside a @db.json value or an array element, nor on a @db.json field", async () => {
    expect(
      await diagnosticsFor(
        table(`@db.json
        data: { @db.default.store
          code: string }
        items: { @db.default.store
          code: string }[]
        @db.json
        @db.default.store
        raw: string`),
      ),
    ).toEqual([
      "@db.default.store cannot sit inside a @db.json value ('data') — the store fills a column",
      "@db.default.store cannot sit inside an array element ('items') — the store fills a column",
      "@db.default.store cannot coexist with @db.json — the store fills a scalar column, not a JSON value",
    ]);
  });

  it("no other @db.default*, no version, change counter, derived or encrypted column", async () => {
    const messages = await diagnosticsFor(
      table(`@db.default.store
      @db.default.uuid
      code: string
      @db.default.store
      @db.onUpdate.inc
      rev: number.int
      @db.default.store
      @db.encrypted
      secret?: string`),
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        "@db.default.store cannot coexist with @db.default.uuid — a field has one default",
        "@db.default.store cannot coexist with @db.onUpdate.inc — a change counter starts at 0",
        "@db.encrypted cannot coexist with @db.default.store — the store fills the value, bypassing the encryption transform",
      ]),
    );
    expect(
      await diagnosticsFor(table("@db.column.version\n@db.default.store\nversion: number.int")),
    ).toContain(
      "@db.default.store cannot coexist with @db.column.version — a version the store issues is a @db.column.version.token, which the store fills",
    );
  });
});

// ── Run time ────────────────────────────────────────────────────────────────

let DsOrder: any;
let DsLine: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ DsOrder, DsLine } = await import("./fixtures/default-store.as"));
});

type TRow = Record<string, unknown>;

/** A store that assigns order numbers itself and returns them in `insertedIds`. */
class StoreFillsAdapter extends MockAdapter {
  private _next = 0;

  override nativeDefaultFns(): ReadonlySet<TDbDefaultFn> {
    return new Set(["store"]);
  }

  override async insertMany(data: TRow[]): Promise<TDbInsertManyResult> {
    if (this._table.tableName !== "ds_orders") return super.insertMany(data);
    this.record(
      "insertMany",
      data.map((row) => ({ ...row })),
    );
    const filled = data.map((row) => ({
      ...row,
      orderNo: row.orderNo ?? `SO-${++this._next}`,
      seq: row.seq ?? this._next,
    }));
    this._rows().push(...filled);
    return { insertedCount: filled.length, insertedIds: filled.map((row) => row.orderNo) };
  }
}

function space() {
  const adapters: MockAdapter[] = [];
  const db = new DbSpace(() => {
    const adapter = new StoreFillsAdapter();
    adapters.push(adapter);
    return adapter;
  });
  return { orders: db.getTable(DsOrder), lines: db.getTable(DsLine), adapters };
}

describe("on an adapter that lists 'store'", () => {
  it("the SDK never fills it; the key the store fills comes back in insertedId", async () => {
    const { orders, adapters } = space();
    const result = await orders.insertOne({ customer: "C1" } as any);
    expect(result).toEqual({ insertedId: "SO-1" });
    const sent = adapters[0]!.calls.find((c) => c.method === "insertMany")!.args[0];
    expect(sent).toEqual([{ customer: "C1" }]);
  });

  it("returning reads the row back by the store-filled key", async () => {
    const { orders } = space();
    const result = await orders.insertOne({ customer: "C1" } as any, { returning: true });
    expect(result.row).toMatchObject({ orderNo: "SO-1", customer: "C1", seq: 1 });
  });

  it("nested FROM children link by the store-filled key", async () => {
    const { orders, lines } = space();
    await orders.insertOne({ customer: "C1", lines: [{ item: "pen" }, { item: "ink" }] } as any);
    expect(await lines.findMany({ filter: { orderNo: "SO-1" } } as any)).toHaveLength(2);
  });

  it("a value the caller sends is passed to the adapter", async () => {
    const { orders, adapters } = space();
    await orders.insertOne({ orderNo: "X-9", customer: "C1" } as any);
    const sent = adapters[0]!.calls.find((c) => c.method === "insertMany")!.args[0];
    expect(sent).toEqual([{ orderNo: "X-9", customer: "C1" }]);
  });

  it("a filter on a store-filled number is not typed as an integer", () => {
    const meta = space().orders.getMetadata();
    const fd = meta.fieldDescriptors.find((f) => f.path === "seq")!;
    expect(fd.defaultValue).toEqual({ kind: "fn", fn: "store" });
    expect(acceptsFilterValue(meta, fd, 1.5)).toBe(true);
  });
});

describe("refusal", () => {
  it("build: an adapter that does not list 'store' refuses every use", async () => {
    const orders = new DbSpace(() => new MockAdapter()).getTable(DsOrder);
    const refusal =
      'Table "ds_orders": field "orderNo" is a @db.default.store; the MockAdapter adapter does not list "store" in nativeDefaultFns()';
    expect(() => orders.getMetadata()).toThrow(refusal);
    await expect(orders.insertOne({ customer: "C1" } as any)).rejects.toThrow(refusal);
  });
});
