import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, getQueryScope, getValueCandidates } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";

// A db annotation on a top-level field is checked on the field it ends up on,
// in the type it ends up in, whether it is written on the field or in an
// `annotate` block (since 0.1.194): `annotate T { … }` writes into T,
// `annotate T as U { … }` into U — a copy of T that answers to T's name. Same
// checks, same messages and severities; the error sits on the annotation as
// written. A nested entry is applied but not checked.

interface TDiagnostic {
  file: string;
  line: number;
  severity: number | undefined;
  message: string;
}

/** Diagnostics of several files: the file, the (0-based) line, the severity and the message of each. */
async function diagnosticsIn(files: Record<string, string>): Promise<TDiagnostic[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "annotate-block-"));
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
      severity: m.severity,
      message: m.message,
    })),
  );
}

/**
 * The three placements of the annotations `source` marks on one top-level
 * field (`@@ @a | @b 'x' @@ field: Type` — the annotations, then the field):
 * written on the field; in `annotate <type> { … }`; in `annotate <type> as
 * <type>Copy { … }`. `lines`: the lines of the annotations in the blocks.
 */
function placements(source: string, type: string) {
  const marker = /^([ \t]*)@@ (.*?) @@ (\S+?)([?:].*)$/m.exec(source);
  expect(marker, "a marked field").not.toBeNull();
  const [whole, indent, written, field, rest] = marker!;
  const annotations = written.split(" | ");
  const inline = source.replace(
    whole,
    [...annotations, field + rest].map((line) => indent + line).join("\n"),
  );
  const bare = source.replace(whole, indent + field + rest);
  const entry = [...annotations, field].map((line) => `    ${line}`).join("\n");
  const first = bare.split("\n").length + 1;
  return {
    inline,
    mutating: `${bare}\nannotate ${type} {\n${entry}\n}\n`,
    alias: `${bare}\nexport annotate ${type} as ${type}Copy {\n${entry}\n}\n`,
    lines: annotations.map((_, i) => first + i),
  };
}

/** Severity and message of each diagnostic. */
function shape(list: TDiagnostic[]): string[] {
  return list.map((d) => `[${d.severity}] ${d.message}`);
}

/** Diagnostics of each placement: severity + message, and the lines they sit on in the blocks. */
async function diagnosticsOfPlacements(source: string, type: string) {
  const p = placements(source, type);
  const [inline, mutating, alias] = await Promise.all(
    [p.inline, p.mutating, p.alias].map((text) => diagnosticsIn({ "fixture.as": text })),
  );
  return {
    inline: shape(inline),
    mutating: shape(mutating),
    alias: shape(alias),
    blockLines: [...mutating, ...alias].map((d) => d.line),
    lines: p.lines,
  };
}

const USER = `
@db.table 'ab_users'
export interface User {
    @meta.id
    id: string
    name: string
}
`;

/** `[case, annotated type, source]` — the annotation is valid. */
const ACCEPTED: Array<[string, string, string]> = [
  [
    "@db.rel.to with its foreign key on the table",
    "Post",
    `${USER}
@db.table 'ab_posts'
export interface Post {
    @meta.id
    id: string
    @db.rel.FK
    authorId: User.id
    @@ @db.rel.to @@ author?: User
}`,
  ],
  [
    "@db.rel.from with the target's foreign key pointing back",
    "Author",
    `
@db.table 'ab_authors'
export interface Author {
    @meta.id
    id: string
    @@ @db.rel.from @@ books: Book[]
}
@db.table 'ab_books'
export interface Book {
    @meta.id
    id: string
    @db.rel.FK
    authorId: Author.id
}`,
  ],
  [
    "@db.rel.via over a junction table",
    "Post",
    `
@db.table 'ab_posts'
export interface Post {
    @meta.id
    id: string
    @@ @db.rel.via PostTag @@ tags: Tag[]
}
@db.table 'ab_tags'
export interface Tag {
    @meta.id
    id: string
}
@db.table 'ab_post_tags'
export interface PostTag {
    @meta.id
    id: string
    @db.rel.FK
    postId: Post.id
    @db.rel.FK
    tagId: Tag.id
}`,
  ],
  [
    "@db.column.sortable on a manual-sort table",
    "Post",
    `
@db.table 'ab_posts'
@db.table.sortable 'manual'
export interface Post {
    @meta.id
    id: string
    @@ @db.column.sortable @@ title: string
}`,
  ],
  [
    "@db.column.derived reading the table's own @db.json field",
    "Order",
    `
@db.table 'ab_orders'
export interface Order {
    @meta.id
    id: string
    @db.json
    payload: { customer: { id: string } }
    @@ @db.column.derived @@ customerId: Order.payload.customer.id
}`,
  ],
  [
    "@db.compute over the view's fields",
    "OrderStats",
    `
@db.table 'ab_orders'
export interface Order {
    @meta.id
    id: string
    amount: number
    status: string
}
@db.view.for Order
export interface OrderStats {
    status: Order.status
    @db.agg.sum 'amount'
    total: number
    @@ @db.compute \`total * 2\` @@ doubled: number
}`,
  ],
];

/** `[case, annotated type, source]` — the annotation is refused. */
const REFUSED: Array<[string, string, string]> = [
  [
    "@db.rel.to without a foreign key",
    "Post",
    `${USER}
@db.table 'ab_posts'
export interface Post {
    @meta.id
    id: string
    authorId: User.id
    @@ @db.rel.to @@ author?: User
}`,
  ],
  [
    "@db.rel.FK on a scalar field",
    "Post",
    `
@db.table 'ab_posts'
export interface Post {
    @meta.id
    id: string
    @@ @db.rel.FK @@ authorId: string
}`,
  ],
  [
    "@db.rel.filterable on a field that is no relation",
    "Post",
    `
@db.table 'ab_posts'
export interface Post {
    @meta.id
    id: string
    @@ @db.rel.filterable @@ title: string
}`,
  ],
  [
    '@db.rel.onDelete "setNull" on a required foreign key',
    "Post",
    `${USER}
@db.table 'ab_posts'
export interface Post {
    @meta.id
    id: string
    @db.rel.FK
    @@ @db.rel.onDelete "setNull" @@ authorId: User.id
}`,
  ],
  [
    "@db.column.sortable outside a table",
    "Post",
    `
export interface Post {
    @meta.id
    id: string
    @@ @db.column.sortable @@ title: string
}`,
  ],
  [
    "@db.column.version on a string",
    "Doc",
    `
@db.table 'ab_docs'
export interface Doc {
    @meta.id
    id: string
    @@ @db.column.version @@ version: string
}`,
  ],
  [
    "@db.column.version.exempt on a table without a version column",
    "Doc",
    `
@db.table 'ab_docs'
export interface Doc {
    @meta.id
    id: string
    @@ @db.column.version.exempt @@ score: number
}`,
  ],
  [
    "@db.onUpdate.inc on an optional float",
    "Doc",
    `
@db.table 'ab_docs'
export interface Doc {
    @meta.id
    id: string
    @@ @db.onUpdate.inc @@ revision?: number
}`,
  ],
  [
    "@db.json on a primitive",
    "Doc",
    `
@db.table 'ab_docs'
export interface Doc {
    @meta.id
    id: string
    @@ @db.json @@ note: string
}`,
  ],
  [
    "@db.encrypted on the primary key",
    "Doc",
    `
@db.table 'ab_docs'
export interface Doc {
    @@ @meta.id | @db.encrypted @@ id: string
}`,
  ],
  [
    "@db.column.searchable on a float",
    "Doc",
    `
@db.table 'ab_docs'
export interface Doc {
    @meta.id
    id: string
    @@ @db.column.searchable @@ score: number
}`,
  ],
  [
    "@db.index.fulltext on an integer without an index",
    "Doc",
    `
@db.table 'ab_docs'
export interface Doc {
    @meta.id
    id: string
    @@ @db.index.fulltext @@ refNo: number.int
}`,
  ],
  [
    "@db.sort.nulls on a required field",
    "Doc",
    `
@db.table 'ab_docs'
export interface Doc {
    @meta.id
    id: string
    @@ @db.sort.nulls 'last' @@ score: number
}`,
  ],
  [
    "@db.amount.currency.ref naming a number",
    "Price",
    `
@db.table 'ab_prices'
export interface Price {
    @meta.id
    id: string
    currency: number
    @@ @db.amount.currency.ref 'currency' @@ amount: decimal
}`,
  ],
  [
    "@db.writeOnly on a searchable field",
    "Doc",
    `
@db.table 'ab_docs'
export interface Doc {
    @meta.id
    id: string
    @db.column.searchable
    @@ @db.writeOnly @@ secret: string
}`,
  ],
  [
    "a conditional @db.agg.max on a required field",
    "OrderStats",
    `
@db.table 'ab_orders'
export interface Order {
    @meta.id
    id: string
    amount: number
    status: string
}
@db.view.for Order
export interface OrderStats {
    status: Order.status
    @@ @db.agg.max 'amount', \`Order.status = 'paid'\` @@ top: number
}`,
  ],
];

describe("db annotations in annotate blocks are checked on the field they land on", () => {
  it.each(ACCEPTED)("%s: accepted in every placement", async (_name, type, source) => {
    const result = await diagnosticsOfPlacements(source, type);
    expect(result.inline).toEqual([]);
    expect(result.mutating).toEqual([]);
    expect(result.alias).toEqual([]);
  });

  it.each(REFUSED)(
    "%s: the same diagnostics in every placement, on the annotation as written",
    async (_name, type, source) => {
      const result = await diagnosticsOfPlacements(source, type);
      expect(result.inline.length).toBeGreaterThan(0);
      expect(result.mutating).toEqual(result.inline);
      expect(result.alias).toEqual(result.inline);
      for (const line of result.blockLines) expect(result.lines).toContain(line);
    },
  );

  it("a nested entry is applied but not checked", async () => {
    const source = `
@db.table 'ab_docs'
export interface Doc {
    @meta.id
    id: string
    stats: {
        revision?: number
    }
}
annotate Doc {
    @db.onUpdate.inc
    stats.revision
}`;
    expect(await diagnosticsIn({ "fixture.as": source })).toEqual([]);
  });

  it("a nested entry's own annotations are still checked against each other", async () => {
    const source = `
@db.table 'ab_prices'
export interface Price {
    @meta.id
    id: string
    total: {
        currency: string
        amount: decimal
    }
}
annotate Price {
    @db.amount.currency 'EUR'
    @db.amount.currency.ref 'currency'
    total.amount
}`;
    expect((await diagnosticsIn({ "fixture.as": source })).map((d) => d.message)).toEqual([
      "@db.amount.currency cannot coexist with @db.amount.currency.ref on the same field — pick one form, not both",
      "@db.amount.currency.ref cannot coexist with @db.amount.currency on the same field — pick one form, not both",
    ]);
  });

  it("a block in another file checks the field in the file that declares it", async () => {
    const result = await diagnosticsIn({
      "posts.as": `${USER}
@db.table 'ab_posts'
export interface Post {
    @meta.id
    id: string
    @db.rel.FK
    authorId: User.id
    author?: User
    version?: number.int
}`,
      "extra.as": `import { Post } from './posts'

annotate Post {
    @db.rel.to
    author
    @db.column.version
    version
}`,
    });
    expect(result).toEqual([
      {
        file: "extra.as",
        line: 5,
        severity: 1,
        message:
          "@db.column.version requires a non-optional field — version columns are always populated (default 0)",
      },
    ]);
  });
});

describe("cross-field rules see the other fields a block writes", () => {
  const POST = `${USER}
@db.table 'ab_posts'
export interface Post {
    @meta.id
    id: string
    authorId: User.id
    author?: User
}
`;

  it.each(["annotate Post", "export annotate Post as PostCopy"])(
    "%s: a foreign key and its relation written in one block",
    async (head) => {
      const source = `${POST}${head} {
    @db.rel.FK
    authorId
    @db.rel.to
    author
}`;
      expect(await diagnosticsIn({ "fixture.as": source })).toEqual([]);
    },
  );
});

// A relation to the table the block writes into reads that table as the
// block lands it, so a self-relation can be completed in one block.
describe("a relation to the block's own table", () => {
  it("a self-referencing @db.rel.FK / .to / .from, the block in another file", async () => {
    const found = await diagnosticsIn({
      "category.as": `
@db.table 'ab_categories'
export interface Category {
    @meta.id
    id: string
    parentId?: Category.id
    parent?: Category
    children: Category[]
}`,
      "relations.as": `import { Category } from './category'

annotate Category {
    @db.rel.FK
    parentId
    @db.rel.to
    parent
    @db.rel.from
    children
}`,
    });
    expect(found).toEqual([]);
  });

  it("a foreign key to a unique key the same block declares", async () => {
    const source = `
@db.table 'ab_cats'
export interface Cat {
    @meta.id
    id: string
    code: string
    parentCode?: Cat.code
}
annotate Cat {
    @db.index.unique 'c'
    code
    @db.rel.FK
    parentCode
}`;
    expect(await diagnosticsIn({ "fixture.as": source })).toEqual([]);
  });

  it("a @db.rel.via whose junction is the block's own table", async () => {
    const source = `
@db.table 'ab_labels'
export interface Label {
    @meta.id
    id: string
}
@db.table 'ab_nodes'
export interface Node {
    @meta.id
    id: string
    parentId?: Node.id
    labelId: Label.id
    labels: Label[]
}
annotate Node {
    @db.rel.FK
    parentId
    @db.rel.FK
    labelId
    @db.rel.via Node
    labels
}`;
    expect(await diagnosticsIn({ "fixture.as": source })).toEqual([]);
  });
});

describe("type-level db annotations in annotate blocks are checked on the type they land on", () => {
  it.each([
    ["annotate User", "annotate User {\n}"],
    ["annotate User as Admin", "export annotate User as Admin {\n}"],
  ])("%s: the table's annotations see its @db.table", async (_name, block) => {
    const source = `${USER}
@db.table.sortable 'manual'
@db.table.filterable 'manual'
@db.depth.limit 2
${block}`;
    expect(await diagnosticsIn({ "fixture.as": source })).toEqual([]);
  });

  it("on a type that is no table they are refused, on the annotation", async () => {
    const result = await diagnosticsIn({
      "fixture.as": `
export interface Plain {
    @meta.id
    id: string
}
@db.table.sortable 'manual'
annotate Plain {
}`,
    });
    expect(result).toEqual([
      {
        file: "fixture.as",
        line: 5,
        severity: 1,
        message: "@db.table.sortable requires @db.table on the same interface",
      },
    ]);
  });

  it("@db.table on an annotate … as copy makes the copy a table for its fields' annotations", async () => {
    const source = `
export interface Plain {
    @meta.id
    id: string
    rating: string
}
@db.table 'ab_rated'
export annotate Plain as Rated {
    @db.column.sortable
    rating
}`;
    expect(await diagnosticsIn({ "fixture.as": source })).toEqual([]);
  });

  it("@db.table.preferredId.uniqueIndex sees the unique indexes of the type", async () => {
    const result = await diagnosticsIn({
      "fixture.as": `
@db.table 'ab_posts'
export interface Post {
    @meta.id
    id: string
    @db.index.unique "by_slug"
    slug: string
}
@db.table.preferredId.uniqueIndex "by_title"
annotate Post {
}`,
    });
    expect(result.map((d) => [d.line, d.message])).toEqual([
      [
        8,
        '@db.table.preferredId.uniqueIndex("by_title") does not match any declared @db.index.unique on this interface; declared groups: ["by_slug"].',
      ],
    ]);
  });
});

describe("editor scopes of db annotations in annotate blocks", () => {
  const SOURCE = `
@db.table 'ab_posts'
export interface Post {
    @meta.id
    id: string
    @db.rel.from
    comments: Comment[]
    currency: string
    title: string
    amount: decimal
}
@db.table 'ab_comments'
export interface Comment {
    @meta.id
    id: string
    @db.rel.FK
    postId: Post.id
    text: string
}
annotate Post {
    @db.rel.filter \`text != ''\`
    comments
    @db.amount.currency.ref 'currency'
    amount
}`;

  it("the scope of a query argument and the fields a sibling argument offers", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "annotate-block-lsp-"));
    writeFileSync(join(rootDir, "lsp.as"), SOURCE);
    const repo = await build({ rootDir, entries: ["lsp.as"], plugins: [tsPlugin(), dbPlugin()] });
    const doc = repo.getDoc(`file://${join(rootDir, "lsp.as")}`)!;
    expect(doc.getDiagMessages().map((m) => m.message)).toEqual([]);
    const filter = doc.annotations.find((a) => a.name === "db.rel.filter")!;
    expect(getQueryScope(filter.args[0], doc)).toEqual({
      allowedTypes: ["Comment"],
      unqualifiedTarget: "Comment",
    });
    const currency = doc.annotations.find((a) => a.name === "db.amount.currency.ref")!;
    expect(getValueCandidates(currency.token, 0, doc)?.map((c) => c.value)).toEqual([
      "id",
      "currency",
      "title",
    ]);
  });
});
