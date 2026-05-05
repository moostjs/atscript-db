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

let MultiUnitProduct: any;
let SingleUnitMetric: any;

beforeAll(async () => {
  await prepareFixtures();
  const mod = await import("./fixtures/unit-products.as");
  MultiUnitProduct = mod.MultiUnitProduct;
  SingleUnitMetric = mod.SingleUnitMetric;
});

// ── Metadata stamping ────────────────────────────────────────────────────────

describe("@db.unit / @db.unit.ref metadata", () => {
  it("stamps the literal unit on the field", () => {
    const rate = SingleUnitMetric.type.props.get("rate");
    expect(rate.metadata.get("db.unit")).toBe("qps");
  });

  it("stamps the ref form with the sibling field name", () => {
    const weight = MultiUnitProduct.type.props.get("weight");
    expect(weight.metadata.get("db.unit.ref")).toBe("unit");
  });

  it("populates fieldDescriptors.unitCode from the literal form", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(SingleUnitMetric, adapter);
    const desc = table.fieldDescriptors.find((f) => f.path === "rate");
    expect(desc?.unitCode).toBe("qps");
    expect(desc?.unitRefField).toBeUndefined();
  });

  it("populates fieldDescriptors.unitRefField from the ref form", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(MultiUnitProduct, adapter);
    const desc = table.fieldDescriptors.find((f) => f.path === "weight");
    expect(desc?.unitRefField).toBe("unit");
    expect(desc?.unitCode).toBeUndefined();
  });

  it("feeds the shared TableMetadata.quantityRefByField lookup", () => {
    const adapter = new MockAdapter();
    const table = new AtscriptDbTable(MultiUnitProduct, adapter);
    expect(table.getMetadata().quantityRefByField.get("weight")).toBe("unit");
  });
});

// ── Runtime aggregation guard ───────────────────────────────────────────────

describe("aggregate(): @db.unit.ref enforces $groupBy", () => {
  let adapter: MockAdapter;
  let table: AtscriptDbTable<any>;

  beforeEach(() => {
    adapter = new MockAdapter();
    adapter.aggregateResult = [{ category: "scale", unit: "kg", total: 100 }];
    table = new AtscriptDbTable(MultiUnitProduct, adapter);
  });

  it("rejects SUM(weight) when unit is missing from $groupBy", async () => {
    const query: AggregateQuery = {
      filter: {},
      controls: {
        $groupBy: ["category"],
        $select: ["category", { $fn: "sum", $field: "weight", $as: "total" }] as any,
      },
    };
    await expect(table.aggregate(query)).rejects.toThrow(DbError);
    await expect(table.aggregate(query)).rejects.toMatchObject({
      code: "INVALID_QUERY",
      errors: [{ path: "$select", message: expect.stringContaining("unit") }],
    });
  });

  it("allows SUM(weight) when unit is in $groupBy", async () => {
    const query: AggregateQuery = {
      filter: {},
      controls: {
        $groupBy: ["category", "unit"],
        $select: ["category", "unit", { $fn: "sum", $field: "weight", $as: "total" }] as any,
      },
    };
    const result = await table.aggregate(query);
    expect(result).toBeDefined();
  });

  it("does not require grouping for tables that use the literal @db.unit form", async () => {
    const singleAdapter = new MockAdapter();
    singleAdapter.aggregateResult = [{ host: "h1", total: 100 }];
    const single = new AtscriptDbTable(SingleUnitMetric, singleAdapter);
    const query: AggregateQuery = {
      filter: {},
      controls: {
        $groupBy: ["host"],
        $select: ["host", { $fn: "sum", $field: "rate", $as: "total" }] as any,
      },
    };
    const result = await single.aggregate(query);
    expect(result).toBeDefined();
  });
});

// ── Compile-time validation ─────────────────────────────────────────────────

describe("@db.unit.* compile-time validation", () => {
  it("accepts @db.unit on a number field (counts and rates)", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'good'
      export interface GoodNumber {
        @meta.id
        id: number

        @db.unit 'qps'
        rate: number
      }
    `);
    expect(messages.filter((m) => m.includes("@db.unit"))).toEqual([]);
  });

  it("accepts @db.unit on a decimal field", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'good'
      export interface GoodDecimal {
        @meta.id
        id: number

        @db.unit 'kg'
        weight: decimal
      }
    `);
    expect(messages.filter((m) => m.includes("@db.unit"))).toEqual([]);
  });

  it("rejects @db.unit on a string field", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface BadHost {
        @meta.id
        id: number

        @db.unit 'kg'
        label: string
      }
    `);
    expect(
      messages.some(
        (m) =>
          m.includes("@db.unit") &&
          (m.includes("decimal") || m.includes("number")) &&
          !m.includes("@db.unit.ref"),
      ),
    ).toBe(true);
  });

  it("rejects @db.unit.ref pointing at a missing sibling", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface MissingSibling {
        @meta.id
        id: number

        @db.unit.ref 'u'
        weight: decimal
      }
    `);
    expect(messages.some((m) => m.includes("no sibling field named 'u'"))).toBe(true);
  });

  it("rejects @db.unit.ref pointing at a non-string sibling", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface WrongRefType {
        @meta.id
        id: number

        unit: number

        @db.unit.ref 'unit'
        weight: decimal
      }
    `);
    expect(messages.some((m) => m.includes("@db.unit.ref") && m.includes("must be a string"))).toBe(
      true,
    );
  });

  it("rejects coexistence of literal and ref on the same field", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'bad'
      export interface BothForms {
        @meta.id
        id: number

        unit: string

        @db.unit 'kg'
        @db.unit.ref 'unit'
        weight: decimal
      }
    `);
    expect(messages.some((m) => m.includes("cannot coexist"))).toBe(true);
  });

  it("does NOT validate the unit code shape (free-form)", async () => {
    const messages = await diagnosticsFor(`
      @db.table 'good'
      export interface FreeFormCode {
        @meta.id
        id: number

        @db.unit 'requests/sec'
        rate: number
      }
    `);
    expect(messages.filter((m) => m.includes("@db.unit"))).toEqual([]);
  });
});

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "unit-annotation-diagnostics-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()].flat().map((message) => message.message);
}
