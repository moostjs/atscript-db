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
  return (await diagnosticsIn({ "fixture.as": source })).map((d) => d.message);
}

/** Diagnostics of several files: the file, the (0-based) line and the message of each. */
async function diagnosticsIn(
  files: Record<string, string>,
): Promise<Array<{ file: string; line: number; message: string }>> {
  const rootDir = mkdtempSync(join(tmpdir(), "extends-owner-"));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(rootDir, name), source);
  const repo = await build({
    rootDir,
    entries: Object.keys(files),
    plugins: [tsPlugin(), dbPlugin()],
  });
  return [...(await repo.diagnostics()).entries()].flatMap(([uri, messages]) =>
    messages.map((m) => ({
      file: uri.slice(uri.lastIndexOf("/") + 1),
      line: m.range.start.line,
      message: m.message,
    })),
  );
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

// Checks that look across the fields of a table (the sibling an argument
// names, the version column, foreign keys, index groups, a view's fields)
// count the fields it inherits — at run time the table has them all.

const orderBase = `
export interface EfOrderBase {
    @meta.id
    id: string

    @db.rel.FK
    customerId?: EoCustomer.id
}
`;

const versioned = `
export interface EfVersioned {
    @meta.id
    id: string

    @db.column.version
    version: number.int
}
`;

const boards = `
@db.table 'ef_boards'
export interface EfBoard {
    @meta.id
    org: string

    @meta.id
    code: string
}
`;

describe("checks across the fields of a table with a base type", () => {
  it.each([
    [
      "a @db.rel.to over an inherited @db.rel.FK",
      `${orderBase}
@db.table 'ef_orders'
export interface EfOrder extends EfOrderBase {
    @db.rel.to
    customer?: EoCustomer
}`,
    ],
    [
      "a currency and a unit reference to inherited fields",
      `
export interface EfPricedBase {
    @meta.id
    id: string

    currency: string

    unit: string
}

@db.table 'ef_prices'
export interface EfPrice extends EfPricedBase {
    @db.amount.currency.ref 'currency'
    amount: decimal

    @db.unit.ref 'unit'
    weight: number
}`,
    ],
    [
      "a version-exempt field of a table whose version column is inherited",
      `${versioned}
@db.table 'ef_notes'
export interface EfNote extends EfVersioned {
    @db.column.version.exempt
    views?: number
}`,
    ],
    [
      "a composite foreign key with an inherited column",
      `${boards}
export interface EfCardBase {
    @meta.id
    id: string

    @db.rel.FK 'board'
    boardOrg?: EfBoard.org
}

@db.table 'ef_cards'
export interface EfCard extends EfCardBase {
    @db.rel.FK 'board'
    boardCode?: EfBoard.code

    @db.rel.to 'board'
    board?: EfBoard
}`,
    ],
    [
      "a full-text option over an inherited index",
      `
export interface EfArticleBase {
    @meta.id
    id: string

    @db.index.fulltext 'ft_body'
    body: string
}

@db.table 'ef_articles'
@db.index.fulltext.language 'russian', 'ft_body'
export interface EfArticle extends EfArticleBase {
    note?: string
}`,
    ],
    [
      "a preferred id naming an inherited unique index",
      `
export interface EfUserBase {
    @meta.id
    id: string

    @db.index.unique 'by_slug'
    slug: string
}

@db.table 'ef_users'
@db.table.preferredId.uniqueIndex 'by_slug'
export interface EfUser extends EfUserBase {
    note?: string
}`,
    ],
  ])("accept %s", async (_name, source) => {
    expect(await diagnostics(customers + source)).toEqual([]);
  });

  it("accept a @db.rel.from whose target inherits its @db.rel.FK", async () => {
    expect(
      await diagnostics(`
@db.table 'ef_clients'
export interface EfClient {
    @meta.id
    id: string

    @db.rel.from
    orders?: EfOrder[]
}

export interface EfOrderBase {
    @meta.id
    id: string

    @db.rel.FK
    clientId?: EfClient.id
}

@db.table 'ef_orders'
export interface EfOrder extends EfOrderBase {
    note?: string
}`),
    ).toEqual([]);
  });

  it("accept inherited fields of a base declared in another file", async () => {
    const found = await diagnosticsIn({
      "base.as": `
@db.table 'ef_customers'
export interface EfCustomer {
    @meta.id
    id: string
}

export interface EfOrderBase {
    @meta.id
    id: string

    @db.rel.FK
    customerId?: EfCustomer.id

    currency: string

    @db.column.version
    version: number.int
}
`,
      "fixture.as": `import { EfCustomer, EfOrderBase } from './base'

@db.table 'ef_orders'
export interface EfOrder extends EfOrderBase {
    @db.rel.to
    customer?: EfCustomer

    @db.amount.currency.ref 'currency'
    amount: decimal

    @db.column.version.exempt
    views?: number
}
`,
    });
    expect(found).toEqual([]);
  });

  it("an inherited sibling's type resolves in the file that declares it", async () => {
    const found = await diagnosticsIn({
      "base.as": `
export type EfCode = number

export interface EfMeasuredBase {
    @meta.id
    id: string

    code: EfCode
}
`,
      "fixture.as": `import { EfMeasuredBase } from './base'

@db.table 'ef_measures'
export interface EfMeasure extends EfMeasuredBase {
    @db.unit.ref 'code'
    weight: number
}
`,
    });
    expect(found).toEqual([
      {
        file: "fixture.as",
        line: 4,
        message: "@db.unit.ref 'code': sibling field must be a string, got 'number'",
      },
    ]);
  });

  it.each([
    [
      "a second version column next to an inherited one",
      `${versioned}
@db.table 'ef_notes'
export interface EfNote extends EfVersioned {
    @db.column.version
    revision: number.int
}`,
      "At most one @db.column.version per table",
    ],
    [
      "a second @db.rel.to to the target of an inherited one",
      `${orderBase}
@db.table 'ef_orders'
export interface EfOrder extends EfOrderBase {
    @db.rel.to
    customer?: EoCustomer
}

@db.table 'ef_big_orders'
export interface EfBigOrder extends EfOrder {
    @db.rel.to
    buyer?: EoCustomer
}`,
      "Duplicate @db.rel.to 'EoCustomer' — only one forward navigational property per alias",
    ],
    [
      "a second foreign key without alias to the target of an inherited one",
      `${orderBase}
@db.table 'ef_orders'
export interface EfOrder extends EfOrderBase {
    @db.rel.FK
    payerId?: EoCustomer.id
}`,
      "Multiple @db.rel.FK fields resolve to type 'EoCustomer' — add alias to disambiguate",
    ],
    [
      "a second @db.rel.from to the target of an inherited one",
      `
@db.table 'ef_clients'
export interface EfClient {
    @meta.id
    id: string

    @db.rel.from
    orders?: EfOrder[]
}

@db.table 'ef_clients'
export interface EfVipClient extends EfClient {
    @db.rel.from
    vipOrders?: EfOrder[]
}

@db.table 'ef_orders'
export interface EfOrder {
    @meta.id
    id: string

    @db.rel.FK
    clientId?: EfClient.id

    @db.rel.FK
    vipId?: EfVipClient.id
}`,
      "Duplicate @db.rel.from 'EfOrder' — only one inverse navigational property per alias",
    ],
    [
      "a referential action on two columns of one composite foreign key, one inherited",
      `${boards}
export interface EfCardBase {
    @meta.id
    id: string

    @db.rel.FK 'board'
    @db.rel.onDelete 'cascade'
    boardOrg?: EfBoard.org
}

@db.table 'ef_cards'
export interface EfCard extends EfCardBase {
    @db.rel.FK 'board'
    @db.rel.onDelete 'cascade'
    boardCode?: EfBoard.code
}`,
      "Composite FK 'board' has @db.rel.onDelete on multiple fields — declare it on exactly one",
    ],
    [
      "a foreign key to an inherited field of the target that is no key",
      `
export interface EfPartyBase {
    @meta.id
    id: string

    name: string
}

@db.table 'ef_parties'
export interface EfParty extends EfPartyBase {
    note?: string
}

@db.table 'ef_letters'
export interface EfLetter {
    @meta.id
    id: string

    @db.rel.FK
    partyName?: EfParty.name
}`,
      "@db.rel.FK target 'EfParty.name' is not a primary key (@meta.id) or unique (@db.index.unique) field",
    ],
    [
      "an integer full-text member behind an inherited primary key column",
      `
export interface EfTicketBase {
    @meta.id
    id: string
}

@db.table 'ef_tickets'
export interface EfTicket extends EfTicketBase {
    @meta.id
    @db.index.fulltext
    refNo: number.int

    @db.index.fulltext
    title: string
}`,
      '@db.index.fulltext on the integer field "refNo" needs an index for its exact-number match — make it the primary key (first @meta.id) or the first field of a @db.index.plain / @db.index.unique',
    ],
    [
      "an integer full-text member behind an inherited field of its index group",
      `
export interface EfTicketBase {
    @meta.id
    id: string

    @db.index.plain 'by_ref'
    prefix: string
}

@db.table 'ef_tickets'
export interface EfTicket extends EfTicketBase {
    @db.index.plain 'by_ref'
    @db.index.fulltext
    refNo: number.int

    @db.index.fulltext
    title: string
}`,
      '@db.index.fulltext on the integer field "refNo" needs an index for its exact-number match — make it the primary key (first @meta.id) or the first field of a @db.index.plain / @db.index.unique',
    ],
    [
      "a foreign key to one column of a composite key formed with an inherited @meta.id",
      `
export interface EfDictBase {
    @meta.id
    attribute: string
}

@db.table 'ef_dict'
export interface EfDict extends EfDictBase {
    @meta.id
    value: string
}

@db.table 'ef_items'
export interface EfItem {
    @meta.id
    id: string

    @db.rel.FK
    value?: EfDict.value
}`,
      "@db.rel.FK target 'EfDict.value' is one column of a composite primary key — a foreign key must reference a unique column; for value help without a constraint use @ui.valueHelp",
    ],
    [
      "an unnamed preferred id with an inherited unique index group before its own",
      `
export interface EfUserBase {
    @meta.id
    id: string

    @db.index.unique
    slug: string
}

@db.table 'ef_users'
@db.table.preferredId.uniqueIndex
export interface EfUser extends EfUserBase {
    @db.index.unique
    email: string
}`,
      "@db.table.preferredId.uniqueIndex without a name uses the first declared unique-index group; this can shift if props are reordered.",
    ],
    [
      "an encrypted field whose type inherits a search feature",
      `
export interface EfAddressBase {
    @db.index.fulltext
    city: string
}

export interface EfAddress extends EfAddressBase {
    zip?: string
}

@db.table 'ef_people'
export interface EfPerson {
    @meta.id
    id: string

    @db.encrypted
    address?: EfAddress
}`,
      '@db.encrypted on "address" — its type declares @db.index.fulltext on "address.city"; search over ciphertext is impossible',
    ],
    [
      "a view field that reads a write-only field its source's type inherits",
      `
export interface EfAddressBase {
    @db.writeOnly
    city: string
}

export interface EfAddress extends EfAddressBase {
    zip?: string
}

@db.table 'ef_people'
export interface EfPerson {
    @meta.id
    id: string

    address: EfAddress
}

@db.view 'ef_people_view'
@db.view.for EfPerson
export interface EfPersonView {
    id: EfPerson.id

    @db.column.searchable
    city?: EfPerson.address.city
}`,
      '@db.column.searchable on "city", which reads a @db.writeOnly source field — search results would reveal the sealed value',
    ],
    [
      "a view field inherited from its base that reads past a JSON leaf",
      `
@db.table 'ef_orders'
export interface EfOrder {
    @meta.id
    id: string

    @db.json
    payload: { tags: string[] }
}

export interface EfOrderRowBase {
    tags?: EfOrder.payload.tags
}

@db.view 'ef_order_rows'
@db.view.for EfOrder
export interface EfOrderRow extends EfOrderRowBase {
    id: EfOrder.id
}`,
      'Field "tags" reads "EfOrder.payload.tags" inside a JSON-stored field — it must end at a string, number or boolean leaf',
    ],
    [
      "a @db.compute operand the view inherits that is not a number",
      `
@db.table 'ef_orders'
export interface EfOrder {
    @meta.id
    id: string

    label: string
}

export interface EfOrderRowBase {
    label: EfOrder.label
}

@db.view 'ef_order_rows'
@db.view.for EfOrder
export interface EfOrderRow extends EfOrderRowBase {
    id: EfOrder.id

    @db.compute \`label * 2\`
    score?: number
}`,
      "@db.compute operand 'label' is a string — operands must be number fields",
    ],
  ])("report %s", async (_name, source, message) => {
    expect(await diagnostics(customers + source)).toEqual([message]);
  });

  it("report a @db.compute cycle through a field the view inherits", async () => {
    const found = await diagnostics(`
@db.table 'ef_orders'
export interface EfOrder {
    @meta.id
    id: string
}

export interface EfOrderRowBase {
    @db.compute \`score + 1\`
    rank: number
}

@db.view 'ef_order_rows'
@db.view.for EfOrder
export interface EfOrderRow extends EfOrderRowBase {
    id: EfOrder.id

    @db.compute \`rank * 2\`
    score: number
}`);
    // the base is no view: its @db.compute is refused there, the cycle here
    expect(found).toEqual([
      "@db.compute is only valid on a field of a @db.view.for view",
      '@db.compute of "score" depends on itself: score → rank → score',
    ]);
  });

  it("an inherited key's type resolves in the file that declares it", async () => {
    const found = await diagnosticsIn({
      "keybase.as": `export type Code = { a: string }

export interface KeyBase {
    @meta.id
    id: string

    code: Code
}
`,
      "k.as": `import { KeyBase } from './keybase'

@db.table 'k'
export interface K extends KeyBase {
    note?: string
}
`,
      "fixture.as": `import { K } from './k'

export type Code = string

@db.table 'f'
export interface F {
    @meta.id
    id: string

    @db.rel.FK 'c'
    kc?: K.code
}
`,
    });
    expect(found).toEqual([
      {
        file: "fixture.as",
        line: 9,
        message:
          "@db.rel.FK target 'K.code' is not a primary key (@meta.id) or unique (@db.index.unique) field",
      },
      {
        file: "fixture.as",
        line: 9,
        message:
          "Foreign key field must resolve to a scalar type (number, string, etc.), got 'Code'",
      },
    ]);
  });

  it("accept tables that extend a full table, two levels deep", async () => {
    expect(
      await diagnostics(`${customers}${boards}
@db.table 'ef_orders'
@db.table.preferredId.uniqueIndex 'by_ref'
@db.index.fulltext.language 'english'
export interface EfOrder {
    @meta.id
    @db.index.fulltext 'ft'
    refNo: number.int

    @db.column.version
    version: number.int

    @db.column.version.exempt
    views?: number

    @db.rel.FK
    customerId?: EoCustomer.id

    @db.rel.to
    customer?: EoCustomer

    @db.rel.FK 'board'
    @db.rel.onDelete 'cascade'
    boardOrg?: EfBoard.org

    @db.rel.FK 'board'
    boardCode?: EfBoard.code

    @db.rel.to 'board'
    board?: EfBoard

    @db.index.unique 'by_ref'
    ref: string

    @db.index.fulltext 'ft'
    title: string

    currency: string

    @db.amount.currency.ref 'currency'
    amount: decimal
}

@db.table 'ef_big_orders'
export interface EfBigOrder extends EfOrder {
    @db.column.version.exempt
    score?: number

    @db.amount.currency.ref 'currency'
    total?: decimal

    @db.index.fulltext 'ft'
    summary?: string
}

@db.table 'ef_huge_orders'
@db.table.preferredId.uniqueIndex 'by_ref'
@db.index.fulltext.language 'english', 'ft'
export interface EfHugeOrder extends EfBigOrder {
    @db.index.plain
    region?: string
}`),
    ).toEqual([]);
  });

  it("accept a diamond: two bases that extend one base with the version column and a foreign key", async () => {
    expect(
      await diagnostics(`${customers}
export interface EfRoot {
    @meta.id
    id: string

    @db.column.version
    version: number.int

    @db.rel.FK
    customerId?: EoCustomer.id
}

export interface EfLeft extends EfRoot {
    left?: string
}

export interface EfRight extends EfRoot {
    right?: string
}

@db.table 'ef_diamonds'
export interface EfDiamond extends EfLeft, EfRight {
    @db.column.version.exempt
    note?: string

    @db.rel.to
    customer?: EoCustomer
}`),
    ).toEqual([]);
  });

  it("report a view's inherited fields on its own annotations", async () => {
    const found = await diagnosticsIn({
      "fixture.as": `
@db.table 'ef_regions'
export interface EfRegion {
    @meta.id
    id: string

    name: string
}

@db.table 'ef_shops'
export interface EfShop {
    @meta.id
    id: string

    regionId?: EfRegion.id

    rating?: number
}

export interface EfShopRow {
    id: EfShop.id

    rating?: EfShop.rating

    regionName: EfRegion.name
}

@db.view 'ef_shop_rows'
@db.view.for EfShop
@db.view.joins EfRegion, \`EfRegion.id = EfShop.regionId\`, 'left'
export interface EfShopView extends EfShopRow {
    @db.compute \`rating * 2\`
    score: number
}
`,
    });
    expect(found).toEqual([
      {
        file: "fixture.as",
        line: 31,
        message:
          'Field "score" has a @db.compute that may be NULL and must be optional (score?: …) — it is NULL when an operand is NULL or a divisor is 0',
      },
      {
        file: "fixture.as",
        line: 28,
        message:
          'Field "regionName" reads from left-joined "EfRegion" and must be optional (regionName?: …)',
      },
    ]);
  });

  it.each([
    [
      "a sibling reference written in the base to a field only the table declares",
      `
export interface EfPricedBase {
    @meta.id
    id: string

    @db.amount.currency.ref 'currency'
    amount: decimal
}

@db.table 'ef_prices'
export interface EfPrice extends EfPricedBase {
    currency: string
}`,
      "@db.amount.currency.ref 'currency': no sibling field named 'currency' on this type",
    ],
    [
      "a table field that redeclares an inherited one",
      `
export interface EfPricedBase {
    @meta.id
    id: string

    currency: string
}

@db.table 'ef_prices'
export interface EfPrice extends EfPricedBase {
    currency: string
}`,
      'Property "currency" already exists in parent "EfPricedBase" — override in extends is not allowed',
    ],
  ])("still refuse %s", async (_name, source, message) => {
    expect(await diagnostics(source)).toContain(message);
  });
});
