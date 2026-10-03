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

async function diagnosticsFor(
  source: string,
  extraFiles: Record<string, string> = {},
): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "view-annotations-diagnostics-"));
  writeFileSync(join(rootDir, "fixture.as"), TABLES + source);
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(join(rootDir, name), content);
  }
  const repo = await build({
    rootDir,
    entries: ["fixture.as", ...Object.keys(extraFiles)],
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
      "'VaRegion' is joined more than once — declare a @db.alias type (`@db.alias VaRegion` + `export type Other = VaRegion`) to join it under another name",
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
      "@db.view.joins cannot join the entry table 'VaUser' directly — declare a @db.alias type (`@db.alias VaUser` + `export type Other = VaUser`) to join it under another name",
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

// ── Views over views (since 0.1.141) ────────────────────────────────────

const UPSTREAM = `
@db.view 'va_people'
@db.view.for VaUser
@db.view.joins VaRegion, \`VaRegion.id = VaUser.regionId\`, 'left'
export interface VaPeople {
    id: VaUser.id
    name: VaUser.name
    regionName?: VaRegion.name
    regionId?: VaUser.regionId
}

@db.view 'va_legacy'
export interface VaLegacy {
    @meta.id
    id: number
    label: string
}
`;

describe("views over views — @db.view.for / @db.view.joins accept a @db.view source", () => {
  it("accepts a managed view as the entry and a managed / external view as a join target", async () => {
    const messages = await diagnosticsFor(
      UPSTREAM +
        `
@db.view 'va_over'
@db.view.for VaPeople
@db.view.joins VaCountry, \`VaCountry.id = VaPeople.regionId\`, 'left'
@db.view.joins VaLegacy, \`VaLegacy.id = VaPeople.id\`, 'left'
@db.view.filter \`VaPeople.regionName exists\`
export interface VaOver {
    id: VaPeople.id
    name: VaPeople.name
    regionName?: VaPeople.regionName
    countryName?: VaCountry.name
    label?: VaLegacy.label
}

@db.view 'va_over_legacy'
@db.view.for VaLegacy
export interface VaOverLegacy {
    id: VaLegacy.id
}
`,
    );
    expect(messages).toEqual([]);
  });

  it("rejects a plain interface (neither @db.table nor @db.view) as entry or join target", async () => {
    const messages = await diagnosticsFor(`
export interface VaPlain {
    id: number
}

@db.view 'va_bad_entry'
@db.view.for VaPlain
export interface VaBadEntry {
    id: VaPlain.id
}

@db.view 'va_bad_join'
@db.view.for VaUser
@db.view.joins VaPlain, \`VaPlain.id = VaUser.id\`
export interface VaBadJoin {
    id: VaUser.id
}
`);
    expect(
      messages.filter((m) => m === "Type 'VaPlain' must be a @db.table or a @db.view."),
    ).toHaveLength(2);
  });

  it("VW9: reports a view that depends on itself through another view (same file)", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_a'
@db.view.for VaB
export interface VaA {
    id: VaB.id
}

@db.view 'va_b'
@db.view.for VaUser
@db.view.joins VaA, \`VaA.id = VaUser.id\`
export interface VaB {
    id: VaUser.id
}
`);
    expect(messages).toContain("View 'VaA' depends on itself: VaA → VaB → VaA");
    expect(messages).toContain("View 'VaB' depends on itself: VaB → VaA → VaB");
  });

  it("VW9: follows imports and @db.alias sources across files", async () => {
    const messages = await diagnosticsFor(
      `
import { VaOther } from './other'

@db.alias VaOther
export type VaOtherAlias = VaOther

@db.view 'va_first'
@db.view.for VaUser
@db.view.joins VaOtherAlias, \`VaOtherAlias.id = VaUser.id\`
export interface VaFirst {
    id: VaUser.id
}
`,
      {
        "other.as": `
import { VaFirst } from './fixture'

@db.view 'va_other'
@db.view.for VaFirst
export interface VaOther {
    id: VaFirst.id
}
`,
      },
    );
    expect(messages).toContain("View 'VaFirst' depends on itself: VaFirst → VaOther → VaFirst");
    expect(messages).toContain("View 'VaOther' depends on itself: VaOther → VaFirst → VaOther");
  });
});

// ── Join aliases (since 0.1.141) ────────────────────────────────────────

describe("@db.alias — join aliases", () => {
  it("accepts a self-join and a second join of one table through aliases", async () => {
    const messages = await diagnosticsFor(`
@db.alias VaUser
export type VaManager = VaUser

@db.alias VaRegion
export type VaHomeRegion = VaRegion

@db.view 'va_staff'
@db.view.for VaUser
@db.view.joins VaManager, \`VaManager.id = VaUser.regionId\`, 'left'
@db.view.joins VaRegion, \`VaRegion.id = VaUser.regionId\`, 'left'
@db.view.joins VaHomeRegion, \`VaHomeRegion.id = VaManager.regionId\`, 'left'
@db.view.filter \`VaManager.name != 'x' or VaManager.id not exists\`
export interface VaStaff {
    id: VaUser.id
    managerName?: VaManager.name
    regionName?: VaRegion.name
    homeRegionName?: VaHomeRegion.name
}
`);
    expect(messages).toEqual([]);
  });

  it("VA1: the alias must be 'export type X = Target' with the annotation argument as target", async () => {
    const messages = await diagnosticsFor(`
@db.alias VaRegion
export type VaWrongTarget = VaUser

@db.alias VaUser
export type VaChain = VaUser.name
`);
    expect(messages).toContain(
      "@db.alias VaRegion must be declared on 'export type VaWrongTarget = VaRegion' — the type must be a plain reference to the aliased VaRegion",
    );
    expect(messages).toContain(
      "@db.alias VaUser must be declared on 'export type VaChain = VaUser' — the type must be a plain reference to the aliased VaUser",
    );
  });

  it("VA2: the target is a table or a view, never another alias", async () => {
    const messages = await diagnosticsFor(`
export interface VaPlain {
    id: number
}

@db.alias VaPlain
export type VaPlainAlias = VaPlain

@db.alias VaUser
export type VaManager = VaUser

@db.alias VaManager
export type VaBoss = VaManager
`);
    expect(messages).toContain("Type 'VaPlain' must be a @db.table or a @db.view.");
    expect(messages).toContain(
      "Type 'VaManager' is a @db.alias — a join alias cannot be used here, reference the aliased table or view.",
    );
  });

  it("VA3 / nodeType: an alias is not an interface and cannot be a table or view", async () => {
    const messages = await diagnosticsFor(`
@db.alias VaUser
export interface VaNotAType {
    id: number
}
`);
    expect(messages.some((m) => m.includes("applies only to type nodes"))).toBe(true);
  });

  it("rejects an alias as the @db.view.for entry (not in this version)", async () => {
    const messages = await diagnosticsFor(`
@db.alias VaUser
export type VaManager = VaUser

@db.view 'va_alias_entry'
@db.view.for VaManager
export interface VaAliasEntry {
    id: VaManager.id
}
`);
    expect(messages).toContain(
      "Type 'VaManager' is a @db.alias — a join alias cannot be used here, reference the aliased table or view.",
    );
  });

  it("VJ5: an alias is joined once; the hint is omitted when the duplicate is already an alias", async () => {
    const messages = await diagnosticsFor(`
@db.alias VaUser
export type VaManager = VaUser

@db.view 'va_dup_alias'
@db.view.for VaUser
@db.view.joins VaManager, \`VaManager.id = VaUser.regionId\`, 'left'
@db.view.joins VaManager, \`VaManager.id = VaUser.id\`, 'left'
export interface VaDupAlias {
    id: VaUser.id
}
`);
    expect(messages).toContain("'VaManager' is joined more than once");
  });

  it("VW7 applies to a left-joined alias", async () => {
    const messages = await diagnosticsFor(`
@db.alias VaUser
export type VaManager = VaUser

@db.view 'va_required_alias'
@db.view.for VaUser
@db.view.joins VaManager, \`VaManager.id = VaUser.regionId\`, 'left'
export interface VaRequiredAlias {
    id: VaUser.id
    managerName: VaManager.name
}
`);
    expect(messages).toContain(
      'Field "managerName" reads from left-joined "VaManager" and must be optional (managerName?: …)',
    );
  });
});

// ── VH1 — @db.view.having references the view's own fields (since 0.1.141) ──

describe("VH1 — @db.view.having field references", () => {
  it("accepts aggregate aliases and dimensions, unqualified", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_stats'
@db.view.for VaUser
@db.view.having \`total > 10 and city = 'Paris' and users >= 1\`
export interface VaStats {
    city: VaUser.address.city

    @db.agg.sum "regionId"
    total: number

    @db.agg.count
    users: number
}
`);
    expect(messages).toEqual([]);
  });

  it("rejects a qualified source-table reference and an unknown field", async () => {
    const messages = await diagnosticsFor(`
@db.view 'va_bad_having'
@db.view.for VaUser
@db.view.having \`VaUser.name = 'x' and nope > 1\`
export interface VaBadHaving {
    name: VaUser.name

    @db.agg.count
    users: number
}
`);
    expect(messages).toContain(
      "Query references 'VaUser' which is not in scope — @db.view.having references the view's own fields unqualified",
    );
    expect(messages).toContain("Field 'nope' does not exist on 'VaBadHaving'");
  });
});

// First-row joins (VJ6–VJ8) and computed columns (VC1–VC6). Since 0.1.147.
const TICKETS = `
@db.table 'fx_tickets'
export interface FxTicket {
    @meta.id
    id: number
    title: string
}

@db.table 'fx_issues'
export interface FxIssue {
    @meta.id
    id: number
    ticketId: number
    raisedAt: number.timestamp
    severity: number
    status: string
    overdue: boolean
    estimate?: number
    price: decimal
    tags: string[]
    @db.json
    payload: { level: number }
    @db.encrypted
    secret: string
    address: { city: string }
}

@db.alias FxIssue
export type FxOldest = FxIssue

@db.table 'fx_pairs'
export interface FxPair {
    @meta.id
    a: number
    @meta.id
    b: number
    ticketId: number
}

@db.alias FxPair
export type FxPairAlias = FxPair
`;

describe("@db.view.joins — first-row join ordering (VJ6–VJ8)", () => {
  const view = (order: string, target = "FxOldest") =>
    diagnosticsFor(`${TICKETS}
@db.view 'fx_q'
@db.view.for FxTicket
@db.view.joins ${target}, \`${target}.ticketId = FxTicket.id\`, 'left', \`${order}\`
export interface FxQ {
    id: FxTicket.id
}
`);

  it("accepts scalar keys, a qualified target key and directions", async () => {
    expect(await view("raisedAt desc, FxOldest.severity, FxOldest.address.city asc")).toEqual([]);
  });

  it("VJ6: rejects an unknown key and a key of another type", async () => {
    const messages = await view("nope, FxTicket.id");
    expect(messages).toContain("Field 'nope' does not exist on 'FxOldest'");
    expect(messages).toContain(
      "Query references 'FxTicket' which is not in scope — a first-row join orders by fields of its target 'FxOldest'",
    );
  });

  it("VJ6: rejects array, JSON, encrypted and object keys", async () => {
    const messages = await view("tags, FxOldest.payload.level, secret, address");
    expect(messages).toContain(
      "Order key 'tags' is an array — order by a scalar field of 'FxOldest'",
    );
    expect(messages).toContain(
      "Order key 'payload.level' reads a @db.json field — order by a scalar field of 'FxOldest'",
    );
    expect(messages).toContain(
      "Order key 'secret' is @db.encrypted — order by a scalar field of 'FxOldest'",
    );
    expect(messages).toContain(
      "Order key 'address' is not a scalar — order by a scalar field of 'FxOldest'",
    );
  });

  it("VJ7: rejects a target without a single primary key (incl. an alias of a composite-key table)", async () => {
    const messages = await view("ticketId", "FxPairAlias");
    expect(messages).toContain(
      "A first-row join needs a target with exactly one @meta.id field — 'FxPairAlias' has 2 (a composite key)",
    );
  });

  it("VJ8: rejects a duplicate key (qualified and unqualified spellings)", async () => {
    const messages = await view("raisedAt, FxOldest.raisedAt desc");
    expect(messages).toContain("Order key 'raisedAt' appears more than once");
  });

  it("reports order-list syntax errors", async () => {
    const messages = await view("raisedAt asc asc");
    expect(messages).toContain(
      'Unexpected token in order list: "asc" (expected "," or "asc" / "desc")',
    );
  });
});

describe("@db.compute — computed view columns (VC1–VC6)", () => {
  const computed = (fields: string, extra = "") =>
    diagnosticsFor(`${TICKETS}
@db.view 'fx_c'
@db.view.for FxTicket
@db.view.joins FxIssue, \`FxIssue.ticketId = FxTicket.id\`, 'left'
${extra}
export interface FxC {
    id: FxTicket.id

    @db.agg.count 'id', \`FxIssue.status = 'open'\`
    openCount: FxIssue.id

    @db.agg.sum 'estimate'
    estimateSum?: FxIssue.estimate

    @db.agg.max 'raisedAt'
    lastRaised?: FxIssue.raisedAt

    @db.agg.max 'price'
    maxPrice?: FxIssue.price

    @db.ignore
    hidden: number
${fields}
}
`);

  it("accepts arithmetic over aggregates, dimensions and computed fields", async () => {
    expect(
      await computed(`
    @db.compute \`openCount * 10 + id\`
    rank: number

    @db.compute \`coalesce(estimateSum / openCount, 0) - -1\`
    avg: number

    @db.compute \`estimateSum / openCount\`
    ratio?: number

    @db.compute \`-(rank - 1) * 2\`
    score: number
`),
    ).toEqual([]);
  });

  it("VC1: rejects a table field, an aggregate field and a non-number type", async () => {
    const table = await diagnosticsFor(`
@db.table 'fx_t'
export interface FxT {
    @meta.id
    id: number
    @db.compute \`id * 2\`
    double: number
}
`);
    expect(table).toContain("@db.compute is only valid on a field of a @db.view.for view");

    const messages = await computed(`
    @db.agg.count
    @db.compute \`openCount + 1\`
    both: number

    @db.compute \`openCount + 1\`
    chained: FxIssue.severity

    @db.compute \`openCount + 1\`
    int: number.int
`);
    expect(messages).toContain(
      "@db.compute cannot coexist with @db.agg.count on the same field — pick one form, not both",
    );
    expect(messages).toContain('Field "chained" has a @db.compute and must be typed `number`');
    expect(messages).toContain('Field "int" has a @db.compute and must be typed `number`');
  });

  it("VC2: rejects a qualified ref and a missing field", async () => {
    const messages = await computed(`
    @db.compute \`FxIssue.severity + nope\`
    bad?: number
`);
    expect(messages).toContain(
      "Query references 'FxIssue' which is not in scope — @db.compute references the view's own fields — declare it on the view first (`field: Type.field`)",
    );
    expect(messages).toContain("Field 'nope' does not exist on 'FxC'");
  });

  it("VC3: rejects decimal, timestamp, string and ignored operands", async () => {
    const messages = await computed(`
    title: FxTicket.title

    @db.compute \`maxPrice + lastRaised + title + hidden\`
    bad?: number
`);
    expect(messages).toContain(
      "@db.compute operand 'maxPrice' is a decimal — operands must be number fields",
    );
    expect(messages).toContain(
      "@db.compute operand 'lastRaised' is a timestamp — operands must be number fields",
    );
    expect(messages).toContain(
      "@db.compute operand 'title' is a string — operands must be number fields",
    );
    expect(messages).toContain(
      "@db.compute operand 'hidden' is @db.ignore'd — operands must be number fields",
    );
  });

  it("VC4: rejects a self-reference and a 3-cycle", async () => {
    const messages = await computed(`
    @db.compute \`self + 1\`
    self: number

    @db.compute \`b + 1\`
    a: number

    @db.compute \`c + 1\`
    b: number

    @db.compute \`a + openCount\`
    c: number
`);
    expect(messages).toContain('@db.compute of "self" depends on itself: self → self');
    expect(messages).toContain('@db.compute of "a" depends on itself: a → b → c → a');
    expect(messages).toContain('@db.compute of "c" depends on itself: c → a → b → c');
  });

  it("VC5: rejects a constant expression", async () => {
    const messages = await computed(`
    @db.compute \`1 + 2\`
    three: number
`);
    expect(messages).toContain(
      "@db.compute needs at least one view field — a constant column is not supported",
    );
  });

  it("VC6: a nullable expression needs an optional field; coalesce makes it non-null", async () => {
    const messages = await computed(`
    @db.compute \`openCount / 2\`
    half: number

    @db.compute \`estimateSum + 1\`
    plus: number

    @db.compute \`coalesce(estimateSum / openCount, 0)\`
    safe: number
`);
    expect(messages).toContain(
      'Field "half" has a @db.compute that may be NULL and must be optional (half?: …) — it is NULL when an operand is NULL or a divisor is 0',
    );
    expect(messages).toContain(
      'Field "plus" has a @db.compute that may be NULL and must be optional (plus?: …) — it is NULL when an operand is NULL or a divisor is 0',
    );
    expect(messages.filter((m) => m.includes('"safe"'))).toEqual([]);
  });

  it("reports expression syntax errors", async () => {
    const messages = await computed(`
    @db.compute \`openCount %\`
    bad: number
`);
    expect(messages).toContain('Unexpected token in expression: "%"');
  });
});
