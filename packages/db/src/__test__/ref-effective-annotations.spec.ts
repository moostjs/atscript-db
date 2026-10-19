import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";

// Compile checks see a field's effective annotations through its type ref
// (what codegen writes into the runtime metadata), and a view field's read
// seals through its source field (since 0.1.162).

async function errorsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "ref-effective-annotations-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()]
    .flat()
    .filter((m) => m.severity === 1)
    .map((m) => m.message);
}

const ACCOUNT = `
@db.table 'rea_accounts'
export interface Account {
    @meta.id
    id: number.int

    @expect.int
    @db.index.plain
    entityId: number

    @db.default.increment
    seq: number

    score: number

    title: string

    @db.writeOnly
    pin?: string

    @db.writeOnly
    secrets?: {
        hint: string
    }

    @db.encrypted
    token?: string

    @db.json
    settings?: string

    @db.amount.currency 'EUR'
    price: decimal

    @db.unit 'kg'
    weight: decimal

    cur: string

    unitCode: string
}
`;

/** A `@db.view.for Account` view whose body lines are verbatim. */
const view = (body: string) => `${ACCOUNT}
@db.view 'rea_account_view'
@db.view.for Account
export interface AccountView {
    id: Account.id
${body}
}
`;

describe("searchable / fulltext follow @expect.int through a field ref", () => {
  it("accepts @db.column.searchable on a view field over an @expect.int source", async () => {
    expect(
      await errorsFor(view("    @db.column.searchable\n    entityId: Account.entityId")),
    ).toEqual([]);
  });

  it("accepts @db.index.fulltext on a table field typed as a ref to an @expect.int field", async () => {
    const source = `${ACCOUNT}
@db.table 'rea_links'
export interface Link {
    @meta.id
    id: number.int

    @db.index.fulltext 'ft'
    @db.index.plain
    entityId: Account.entityId
}
`;
    expect(await errorsFor(source)).toEqual([]);
  });

  it("still refuses a float source, suggesting @expect.int (not increment) on a view field", async () => {
    const found = await errorsFor(view("    @db.column.searchable\n    score: Account.score"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/"score" is a floating-point number — .*add @expect\.int$/);
    expect(found[0]).not.toMatch(/increment/);
  });

  it("refuses a view field over an increment source (increment does not travel, like at runtime)", async () => {
    const found = await errorsFor(view("    @db.column.searchable\n    seq: Account.seq"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/"seq" is a floating-point number/);
  });
});

describe("search annotations over a @db.writeOnly source", () => {
  it.each([
    ["@db.column.searchable", "pin?: Account.pin"],
    ["@db.column.searchable", "hint: Account.secrets.hint"],
    ["@db.column.searchable", "pin?: string"],
    ["@db.index.fulltext 'ft'", "pin?: Account.pin"],
  ])("refuses %s on %s", async (ann, decl) => {
    const found = await errorsFor(view(`    ${ann}\n    ${decl}`));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/reads a @db\.writeOnly source field — search results would reveal/);
  });

  it("refuses it through a view over a view", async () => {
    const source = `${view("    pin?: Account.pin")}
@db.view 'rea_view_over_view'
@db.view.for AccountView
export interface ViewOverView {
    id: AccountView.id
    @db.column.searchable
    pinAgain?: AccountView.pin
}
`;
    const found = await errorsFor(source);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/"pinAgain", which reads a @db\.writeOnly source field/);
  });

  it("accepts a searchable view field over a readable source", async () => {
    expect(await errorsFor(view("    @db.column.searchable\n    title: Account.title"))).toEqual(
      [],
    );
  });
});

describe("@db.sort.nulls over a sealed source", () => {
  it("refuses a view field over a @db.encrypted source", async () => {
    const found = await errorsFor(view("    @db.sort.nulls 'first'\n    token?: Account.token"));
    expect(found).toEqual([
      "@db.sort.nulls on a view field over a @db.encrypted source field — encrypted fields are not sortable",
    ]);
  });

  it("accepts a view field over a primitive @db.json source (the view reads its typed value)", async () => {
    expect(
      await errorsFor(view("    @db.sort.nulls 'first'\n    settings?: Account.settings")),
    ).toEqual([]);
  });

  it("accepts a view field over a plain source", async () => {
    expect(await errorsFor(view("    @db.sort.nulls 'last'\n    title?: Account.title"))).toEqual(
      [],
    );
  });
});

describe("currency / unit ref exclusivity sees the inherited literal form", () => {
  it("refuses @db.amount.currency.ref on a field that inherits @db.amount.currency", async () => {
    const found = await errorsFor(
      view("    cur: Account.cur\n    @db.amount.currency.ref 'cur'\n    price: Account.price"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /@db\.amount\.currency\.ref cannot coexist with @db\.amount\.currency, which this field inherits from its type reference/,
    );
  });

  it("refuses @db.unit.ref on a field that inherits @db.unit", async () => {
    const found = await errorsFor(
      view(
        "    unitCode: Account.unitCode\n    @db.unit.ref 'unitCode'\n    weight: Account.weight",
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /@db\.unit\.ref cannot coexist with @db\.unit, which this field inherits from its type reference/,
    );
  });

  it("accepts a ref field over a source without the literal form", async () => {
    const source = `${ACCOUNT}
@db.table 'rea_prices'
export interface PriceRow {
    @meta.id
    id: number.int
    cur: string
    @db.amount.currency.ref 'cur'
    amount: decimal
}
`;
    expect(await errorsFor(source)).toEqual([]);
  });
});

describe("@db.json on a primitive field", () => {
  it("warns that it stores one JSON column ($exists-only, never sortable)", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ref-effective-annotations-"));
    writeFileSync(
      join(rootDir, "fixture.as"),
      `@db.table 'rea_json'\nexport interface JsonRow {\n    @meta.id\n    id: number.int\n    @db.json\n    score?: number\n}\n`,
    );
    const repo = await build({
      rootDir,
      entries: ["fixture.as"],
      plugins: [tsPlugin(), dbPlugin()],
    });
    const warnings = [...(await repo.diagnostics()).values()]
      .flat()
      .filter((m) => m.severity === 2)
      .map((m) => m.message);
    expect(warnings).toContain(
      "@db.json on a primitive field stores it as one JSON column — filterable only with $exists and never sortable; drop @db.json for a typed scalar column",
    );
  });
});
