import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, it, expect } from "vite-plus/test";

import dbPlugin from "../plugin";

// Annotations valid only on fields of a `@db.table` interface look up the
// interface that declares the field. For a table with a base type that must
// not depend on what else names the table: a chain reference to one of its
// fields, or an interface extending it, merges the table with its base before
// the annotations are checked.

const customers = `
@db.table 'eo_customers'
export interface EoCustomer {
    @meta.id
    id: string
}
`;

const supplier = `
export interface EoParty {
    @meta.id
    id: string
}

@db.table 'eo_suppliers'
@db.table.sortable 'manual'
@db.table.filterable 'manual'
export interface EoSupplier extends EoParty {
    @db.column.sortable
    @db.column.filterable
    rating?: string

    @db.rel.FK
    customerId?: EoCustomer.id

    @db.rel.to
    customer?: EoCustomer

    @db.rel.from
    offers?: EoOffer[]
}

@db.table 'eo_offers'
export interface EoOffer {
    @meta.id
    id: string

    @db.rel.FK
    supplierId?: EoSupplier.id
}
`;

async function diagnostics(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "extends-owner-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  return [...(await repo.diagnostics()).values()].flat().map((m) => m.message);
}

describe("field annotations on a @db.table interface with a base type", () => {
  it.each([
    ["nothing else names the table's fields", ""],
    [
      "a chain reference names an inherited field",
      `
export interface EoQuote {
    supplierId?: EoSupplier.id
}`,
    ],
    [
      "a chain reference names an own field",
      `
export interface EoQuote {
    rating?: EoSupplier.rating
}`,
    ],
    [
      "an interface extends the table",
      `
export interface EoPreferred extends EoSupplier {
    since?: string
}`,
    ],
    [
      "an intersection has the table as a member",
      `
export type EoWide = EoSupplier & { extra?: string }`,
    ],
  ])("are accepted when %s", async (_name, extra) => {
    expect(await diagnostics(customers + supplier + extra)).toEqual([]);
  });

  it("are accepted when the chain reference is declared before the table", async () => {
    const quote = `
export interface EoQuote {
    rating?: EoSupplier.rating
}`;
    expect(await diagnostics(customers + quote + supplier)).toEqual([]);
  });

  it("stay refused on the base type, which is not a table", async () => {
    const found = await diagnostics(`${customers}
export interface EoPerson {
    @meta.id
    id: string

    @db.rel.FK
    customerId?: EoCustomer.id

    @db.rel.to
    customer?: EoCustomer

    @db.column.sortable
    sorted?: string
}

@db.table 'eo_people'
@db.table.sortable 'manual'
export interface EoPeople extends EoPerson {
    note?: string
}

export interface EoBadge {
    personId?: EoPeople.id
}`);
    expect(found).toContain("@db.rel.to is only valid on fields of a @db.table interface");
    expect(found).toContain("@db.column.sortable is only valid on fields of a @db.table interface");
  });
});
