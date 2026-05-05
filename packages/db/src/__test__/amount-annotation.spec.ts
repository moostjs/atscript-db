import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { AggregateQuery } from "@uniqu/core";

import { DbError } from "../db-error";
import dbPlugin from "../plugin";
import { AtscriptDbTable } from "../table/db-table";
import { MockAdapter, prepareFixtures } from "./test-utils";

let MultiCurrencyOrder: any;
let SingleCurrencyOrder: any;

beforeAll(async () => {
  await prepareFixtures();
  const mod = await import("./fixtures/amount-orders.as");
  MultiCurrencyOrder = mod.MultiCurrencyOrder;
  SingleCurrencyOrder = mod.SingleCurrencyOrder;
});

// ── Metadata stamping ────────────────────────────────────────────────────────

describe("@db.amount.currency / @db.amount.currency.ref metadata", () => {
  it("stamps the literal currency on the field", () => {
    const amount = SingleCurrencyOrder.type.props.get("amount");
    expect(amount.metadata.get("db.amount.currency")).toBe("EUR");
  });

  it("stamps the ref form with the sibling field name", () => {
    const amount = MultiCurrencyOrder.type.props.get("amount");
    expect(amount.metadata.get("db.amount.currency.ref")).toBe("currency");
  });

  it("populates fieldDescriptors.currencyCode from the literal form", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(SingleCurrencyOrder, adapter);
    const desc = table.fieldDescriptors.find((f) => f.path === "amount");
    expect(desc?.currencyCode).toBe("EUR");
    expect(desc?.currencyRefField).toBeUndefined();
  });

  it("populates fieldDescriptors.currencyRefField from the ref form", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(MultiCurrencyOrder, adapter);
    const desc = table.fieldDescriptors.find((f) => f.path === "amount");
    expect(desc?.currencyRefField).toBe("currency");
    expect(desc?.currencyCode).toBeUndefined();
  });

  it("populates the TableMetadata.quantityRefByField lookup", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(MultiCurrencyOrder, adapter);
    expect(table.getMetadata().quantityRefByField.get("amount")).toBe("currency");
  });
});

// ── Runtime aggregation guard ───────────────────────────────────────────────

describe("aggregate(): @db.amount.currency.ref enforces $groupBy", () => {
  let adapter: MockAdapter;
  let table: AtscriptDbTable<any>;

  beforeEach(() => {
    adapter = new MockAdapter();
    adapter.aggregateResult = [{ status: "active", currency: "EUR", total: 100 }];
    table = new AtscriptDbTable(MultiCurrencyOrder, adapter);
  });

  it("rejects SUM(amount) when currency is missing from $groupBy", async () => {
    const query: AggregateQuery = {
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "sum", $field: "amount", $as: "total" }] as any,
      },
    };
    await expect(table.aggregate(query)).rejects.toThrow(DbError);
    await expect(table.aggregate(query)).rejects.toMatchObject({
      code: "INVALID_QUERY",
      errors: [{ path: "$select", message: expect.stringContaining("currency") }],
    });
  });

  it("rejects AVG(amount) when currency is missing from $groupBy", async () => {
    const query: AggregateQuery = {
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "avg", $field: "amount", $as: "avgAmount" }] as any,
      },
    };
    await expect(table.aggregate(query)).rejects.toThrow(DbError);
  });

  it("allows SUM(amount) when currency is in $groupBy", async () => {
    const query: AggregateQuery = {
      filter: {},
      controls: {
        $groupBy: ["status", "currency"],
        $select: ["status", "currency", { $fn: "sum", $field: "amount", $as: "total" }] as any,
      },
    };
    const result = await table.aggregate(query);
    expect(result).toBeDefined();
  });

  it("allows COUNT(*) without requiring currency in $groupBy", async () => {
    const query: AggregateQuery = {
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "count", $field: "*", $as: "cnt" }] as any,
      },
    };
    const result = await table.aggregate(query);
    expect(result).toBeDefined();
  });

  it("does not require grouping for tables that use the literal @db.amount.currency form", async () => {
    const singleAdapter = new MockAdapter();
    singleAdapter.aggregateResult = [{ status: "active", total: 100 }];
    const single = new AtscriptDbTable(SingleCurrencyOrder, singleAdapter);
    const query: AggregateQuery = {
      filter: {},
      controls: {
        $groupBy: ["status"],
        $select: ["status", { $fn: "sum", $field: "amount", $as: "total" }] as any,
      },
    };
    const result = await single.aggregate(query);
    expect(result).toBeDefined();
  });
});

// ── Compile-time validation ─────────────────────────────────────────────────

describe("@db.amount.currency.* compile-time validation", () => {
  it("rejects @db.amount.currency on a non-decimal field", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface BadLiteral {
        @meta.id
        id: number

        @db.amount.currency 'EUR'
        amount: number
      }
    `);
    expect(messages.some((m) => m.includes("@db.amount.currency") && m.includes("decimal"))).toBe(
      true,
    );
  });

  it("rejects @db.amount.currency.ref on a non-decimal field", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface BadRef {
        @meta.id
        id: number

        currency: db.currencyCode

        @db.amount.currency.ref 'currency'
        amount: number
      }
    `);
    expect(
      messages.some((m) => m.includes("@db.amount.currency.ref") && m.includes("decimal")),
    ).toBe(true);
  });

  it("rejects @db.amount.currency.ref pointing at a missing sibling", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface MissingSibling {
        @meta.id
        id: number

        @db.amount.currency.ref 'cur'
        amount: decimal
      }
    `);
    expect(messages.some((m) => m.includes("no sibling field named 'cur'"))).toBe(true);
  });

  it("rejects @db.amount.currency.ref pointing at a non-string sibling", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface WrongRefType {
        @meta.id
        id: number

        currency: number

        @db.amount.currency.ref 'currency'
        amount: decimal
      }
    `);
    expect(
      messages.some((m) => m.includes("@db.amount.currency.ref") && m.includes("must be a string")),
    ).toBe(true);
  });

  it("rejects coexistence of literal and ref on the same field", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface BothForms {
        @meta.id
        id: number

        currency: db.currencyCode

        @db.amount.currency 'EUR'
        @db.amount.currency.ref 'currency'
        amount: decimal
      }
    `);
    expect(messages.some((m) => m.includes("cannot coexist"))).toBe(true);
  });

  it("rejects an invalid literal currency code", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface BadCode {
        @meta.id
        id: number

        @db.amount.currency 'eur'
        amount: decimal
      }
    `);
    expect(
      messages.some(
        (m) => m.includes("@db.amount.currency") && m.includes("invalid currency code"),
      ),
    ).toBe(true);
  });

  it("accepts a valid ref to a db.currencyCode sibling", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'good'
      export interface Good {
        @meta.id
        id: number

        currency: db.currencyCode

        @db.amount.currency.ref 'currency'
        amount: decimal
      }
    `);
    expect(messages.filter((m) => m.includes("@db.amount."))).toEqual([]);
  });
});

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "amount-annotation-diagnostics-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()].flat().map((message) => message.message);
}
