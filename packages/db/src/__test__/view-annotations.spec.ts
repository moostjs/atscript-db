import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";

// Compile-time diagnostics of `@db.view.joins` (kind, chained scope, VJ5) and
// the whole-view checks run from `@db.view.for` (VW7, VW8). Since 0.1.136.

const TABLES = `
@db.table 'va_users'
export interface VaUser {
    @meta.id
    id: number
    name: string
    regionId?: number

    @db.json
    settings: {
        theme: string
        size: number
        price: decimal
        inner: {
            mode: string
        }
    }

    address: {
        city: string
    }
}

@db.table 'va_regions'
export interface VaRegion {
    @meta.id
    id: number
    name: string
    amount: number
    countryId?: number
}

@db.table 'va_countries'
export interface VaCountry {
    @meta.id
    id: number
    name: string
}
`;

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "view-annotations-diagnostics-"));
  writeFileSync(join(rootDir, "fixture.as"), TABLES + source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()].flat().map((message) => message.message);
}

describe("@db.view.joins — kind and chained joins", () => {
  it("accepts a left join and a chained join that references an earlier join", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_ok'
@db.view.for VaUser
@db.view.joins VaRegion, \`VaRegion.id = VaUser.regionId\`, 'left'
@db.view.joins VaCountry, \`VaCountry.id = VaRegion.countryId\`, 'inner'
export interface VaOk {
    id: VaUser.id
    regionName?: VaRegion.name
    countryName: VaCountry.name
}
`);
    expect(messages).toEqual([]);
  });

  it("rejects a join condition that references a join declared after it", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_forward'
@db.view.for VaUser
@db.view.joins VaCountry, \`VaCountry.id = VaRegion.countryId\`
@db.view.joins VaRegion, \`VaRegion.id = VaUser.regionId\`
export interface VaForward {
    id: VaUser.id
}
`);
    expect(messages).toContain(
      "Query references 'VaRegion' which is not in scope — a join may reference the entry table and joins declared before it",
    );
  });

  it("rejects an unknown join kind", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_kind'
@db.view.for VaUser
@db.view.joins VaRegion, \`VaRegion.id = VaUser.regionId\`, 'outer'
export interface VaKind {
    id: VaUser.id
}
`);
    expect(messages.some((m) => m.includes('("kind") must be one of [inner, left]'))).toBe(true);
  });

  it("VJ5: rejects joining the same table twice", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_dup'
@db.view.for VaUser
@db.view.joins VaRegion, \`VaRegion.id = VaUser.regionId\`
@db.view.joins VaRegion, \`VaRegion.id = VaUser.id\`
export interface VaDup {
    id: VaUser.id
}
`);
    expect(messages).toContain(
      "'VaRegion' is joined more than once — no join aliases / self-joins yet",
    );
  });

  it("VJ5: rejects joining the entry table", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_self'
@db.view.for VaUser
@db.view.joins VaUser, \`VaUser.id = VaUser.regionId\`
export interface VaSelf {
    id: VaUser.id
}
`);
    expect(messages).toContain(
      "@db.view.joins cannot join the entry table 'VaUser' — no join aliases / self-joins yet",
    );
  });
});

describe("VW7 — fields from a left-joined table must be optional", () => {
  it("rejects a required field reading from a left-joined table", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_left'
@db.view.for VaUser
@db.view.joins VaRegion, \`VaRegion.id = VaUser.regionId\`, 'left'
export interface VaLeft {
    id: VaUser.id
    regionName: VaRegion.name
}
`);
    expect(messages).toContain(
      'Field "regionName" reads from left-joined "VaRegion" and must be optional (regionName?: …)',
    );
  });

  it("exempts count but not sum over a left-joined table", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_left_agg'
@db.view.for VaUser
@db.view.joins VaRegion, \`VaRegion.id = VaUser.regionId\`, 'left'
export interface VaLeftAgg {
    name: VaUser.name

    @db.agg.count
    regions: VaRegion.id

    @db.agg.sum "amount"
    total: VaRegion.amount
}
`);
    expect(messages).toEqual([
      'Field "total" reads from left-joined "VaRegion" and must be optional (total?: …)',
    ]);
  });

  it("does not apply to inner joins", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_inner'
@db.view.for VaUser
@db.view.joins VaRegion, \`VaRegion.id = VaUser.regionId\`
export interface VaInner {
    id: VaUser.id
    regionName: VaRegion.name
}
`);
    expect(messages).toEqual([]);
  });
});

describe("VW8 — JSON chains must end at a primitive leaf", () => {
  it("accepts string / number leaves inside a JSON field", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_json_ok'
@db.view.for VaUser
export interface VaJsonOk {
    id: VaUser.id
    theme: VaUser.settings.theme
    size: VaUser.settings.size
    mode: VaUser.settings.inner.mode
    city: VaUser.address.city
}
`);
    expect(messages).toEqual([]);
  });

  it("rejects an object or decimal leaf inside a JSON field", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_json_bad'
@db.view.for VaUser
export interface VaJsonBad {
    id: VaUser.id
    inner: VaUser.settings.inner
    price: VaUser.settings.price
}
`);
    expect(messages).toEqual([
      'Field "inner" reads "VaUser.settings.inner" inside a JSON-stored field — it must end at a string, number or boolean leaf',
      'Field "price" reads "VaUser.settings.price" inside a JSON-stored field — it must end at a string, number or boolean leaf',
    ]);
  });
});

// Conditional aggregates + countDistinct (`@db.agg.* field, condition?`). Since 0.1.136.
describe("@db.agg.* — countDistinct and conditions", () => {
  it("accepts countDistinct and conditions over the entry table and every join", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_agg_ok'
@db.view.for VaRegion
@db.view.joins VaUser, \`VaUser.regionId = VaRegion.id\`
export interface VaAggOk {
    name: VaRegion.name

    @db.agg.count '*', \`VaUser.name = 'x'\`
    named: number

    @db.agg.count "id", \`amount > 1\`
    bigUsers: number

    @db.agg.countDistinct "countryId"
    countries: number

    @db.agg.sum "amount", \`VaUser.id > 0 and VaRegion.amount < 10\`
    total: number

    @db.agg.avg "amount", \`VaUser.id > 0\`
    avgAmount?: number

    @db.agg.max "amount", \`VaUser.id > 0\`
    maxAmount?: number
}
`);
    expect(messages).toEqual([]);
  });

  it("rejects '*' outside count, a missing field, and a non-number result type", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_agg_star'
@db.view.for VaRegion
export interface VaAggStar {
    name: VaRegion.name

    @db.agg.sum '*'
    total: number

    @db.agg.countDistinct
    countries: number

    @db.agg.countDistinct "name"
    names: VaRegion.name
}
`);
    expect(messages.toSorted()).toEqual([
      '@db.agg.countDistinct is not compatible with type "string" — requires number',
      "@db.agg.countDistinct requires at least 1 arguments, but got 0.",
      "@db.agg.sum needs a field — only @db.agg.count accepts '*'",
    ]);
  });

  it("rejects a condition over a table the view does not join", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_agg_scope'
@db.view.for VaRegion
export interface VaAggScope {
    name: VaRegion.name

    @db.agg.count '*', \`VaCountry.name = 'x'\`
    n: number
}
`);
    expect(messages).toEqual([
      "Query references 'VaCountry' which is not in scope — expected 'VaRegion'",
    ]);
  });

  it("requires conditional avg / min / max fields to be optional (NULL when no row matches)", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_agg_opt'
@db.view.for VaRegion
export interface VaAggOpt {
    name: VaRegion.name

    @db.agg.avg "amount", \`amount > 1\`
    avgAmount: number

    @db.agg.min "amount", \`amount > 1\`
    minAmount: number

    @db.agg.sum "amount", \`amount > 1\`
    total: number
}
`);
    expect(messages).toEqual([
      'Field "avgAmount" has a conditional @db.agg.avg and must be optional (avgAmount?: …) — it is NULL when no row matches',
      'Field "minAmount" has a conditional @db.agg.min and must be optional (minAmount?: …) — it is NULL when no row matches',
    ]);
  });

  it("requires @db.view.for for a conditional aggregate", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_agg_external'
export interface VaAggExternal {
    @db.agg.count '*', \`amount > 1\`
    n: number
}
`);
    expect(messages).toContain("A conditional @db.agg.count requires @db.view.for on the view");
  });
});
