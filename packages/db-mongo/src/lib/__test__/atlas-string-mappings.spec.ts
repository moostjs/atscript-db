import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import dbPlugin from "@atscript/db/plugin";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import { MongoPlugin } from "../../plugin";

// `@db.mongo.search.text` and `@db.mongo.search.autocomplete` need a field
// whose declared type holds only strings (a string, string literals, or an
// array of them); on any other field they are a compile error.

async function errorsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "mongo-atlas-string-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin(), MongoPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()]
    .flat()
    .filter((m) => m.severity === 1)
    .map((m) => m.message);
}

/** A collection with a static Atlas index and `field` (its annotations included). */
const collection = (field: string, extra = "") => `${extra}
@db.table 'items'
@db.mongo.collection
@db.mongo.search.static
export interface Item {
    @meta.id
    _id: string

    ${field}
}
`;

const ANNOTATIONS = ["@db.mongo.search.text", "@db.mongo.search.autocomplete"];

const refusal = (ann: string, field: string, held: string, instead: string) =>
  `${ann} on "${field}" needs a field whose declared type holds only strings (a string, string literals, or an array of them), and this field holds ${held}; ${instead}`;

const STRING_FIELD = "annotate a string field instead";
const INTEGER =
  "to match it by exact number, list it in @db.index.fulltext; for text search, annotate a string field";

describe.each(ANNOTATIONS)("%s on a field that is not a string", (ann) => {
  it("refuses an integer, pointing at @db.index.fulltext", async () => {
    expect(await errorsFor(collection(`${ann}\n    refNo: number.int`))).toEqual([
      refusal(ann, "refNo", "an integer", INTEGER),
    ]);
  });

  it("refuses a number with @expect.int, pointing at @db.index.fulltext", async () => {
    expect(await errorsFor(collection(`${ann}\n    @expect.int\n    count: number`))).toEqual([
      refusal(ann, "count", "a number", INTEGER),
    ]);
  });

  it("refuses a floating-point number", async () => {
    expect(await errorsFor(collection(`${ann}\n    price: number`))).toEqual([
      refusal(ann, "price", "a number", STRING_FIELD),
    ]);
  });

  it("refuses a boolean", async () => {
    expect(await errorsFor(collection(`${ann}\n    active: boolean`))).toEqual([
      refusal(ann, "active", "a boolean", STRING_FIELD),
    ]);
  });

  it("refuses an object", async () => {
    expect(await errorsFor(collection(`${ann}\n    address: { city: string }`))).toEqual([
      refusal(ann, "address", "an object", STRING_FIELD),
    ]);
  });

  it("refuses a field typed with an interface", async () => {
    const extra = "export interface Address {\n    city: string\n}\n";
    expect(await errorsFor(collection(`${ann}\n    address: Address`, extra))).toEqual([
      refusal(ann, "address", "an object", STRING_FIELD),
    ]);
  });

  it("refuses an array of numbers", async () => {
    expect(await errorsFor(collection(`${ann}\n    codes: number.int[]`))).toEqual([
      refusal(ann, "codes", "an integer in an array", STRING_FIELD),
    ]);
  });

  it("refuses a union with a number member", async () => {
    expect(await errorsFor(collection(`${ann}\n    code: string | number`))).toEqual([
      refusal(ann, "code", "a number", STRING_FIELD),
    ]);
  });

  it("refuses a number literal", async () => {
    expect(await errorsFor(collection(`${ann}\n    level: 'low' | 2`))).toEqual([
      refusal(ann, "level", "the literal 2", STRING_FIELD),
    ]);
  });

  it("refuses a mongo.objectId", async () => {
    expect(await errorsFor(collection(`${ann}\n    ownerId: mongo.objectId`))).toEqual([
      refusal(ann, "ownerId", "a mongo.objectId", STRING_FIELD),
    ]);
  });

  it("refuses a mongo.objectId inside a nested object and an array of objects", async () => {
    expect(
      await errorsFor(
        collection(
          `owner: {\n        ${ann}\n        id: mongo.objectId\n    }\n    items: {\n        ${ann}\n        ref: mongo.objectId\n    }[]`,
        ),
      ),
    ).toEqual([
      refusal(ann, "id", "a mongo.objectId", STRING_FIELD),
      refusal(ann, "ref", "a mongo.objectId", STRING_FIELD),
    ]);
  });

  it("refuses a decimal", async () => {
    expect(await errorsFor(collection(`${ann}\n    amount: decimal`))).toEqual([
      refusal(ann, "amount", "a decimal", STRING_FIELD),
    ]);
  });

  it("refuses unknown", async () => {
    expect(await errorsFor(collection(`${ann}\n    data: unknown`))).toEqual([
      refusal(ann, "data", "an unknown value", STRING_FIELD),
    ]);
  });

  it("refuses a type alias of an integer", async () => {
    const extra = "type Code = number.int\n";
    expect(await errorsFor(collection(`${ann}\n    code: Code`, extra))).toEqual([
      refusal(ann, "code", "an integer", INTEGER),
    ]);
  });

  it("refuses a tuple with a number item", async () => {
    expect(await errorsFor(collection(`${ann}\n    pair: [string, number]`))).toEqual([
      refusal(ann, "pair", "a number", STRING_FIELD),
    ]);
  });
});

describe.each(ANNOTATIONS)("%s in an annotate block", (ann) => {
  const target = `
@db.table 'items'
@db.mongo.collection
@db.mongo.search.static
export interface Item {
    @meta.id
    _id: string
    title: string
    refNo: number.int
    home: {
        city: string
        active: boolean
    }
    @expect.int
    count: number
}
`;

  it("refuses the entries naming fields that are not strings", async () => {
    expect(
      await errorsFor(
        `${target}\nannotate Item {\n    ${ann}\n    refNo\n    ${ann}\n    home.active\n}\n`,
      ),
    ).toEqual([
      refusal(ann, "refNo", "an integer", INTEGER),
      refusal(ann, "home.active", "a boolean", STRING_FIELD),
    ]);
  });

  it("points an entry naming a number with @expect.int at @db.index.fulltext, as inline", async () => {
    expect(await errorsFor(`${target}\nannotate Item {\n    ${ann}\n    count\n}\n`)).toEqual([
      refusal(ann, "count", "a number", INTEGER),
    ]);
  });

  it("accepts the entries naming string fields", async () => {
    expect(
      await errorsFor(
        `${target}\nannotate Item {\n    ${ann}\n    title\n    ${ann}\n    home.city\n}\n`,
      ),
    ).toEqual([]);
  });
});

describe.each(ANNOTATIONS)("%s on a field holding strings only", (ann) => {
  it.each([
    "name: string",
    "email: string.email",
    "nick?: string",
    "note: string | null",
    "maybe: string | undefined",
    "tags: string[]",
    "pair: [string, string.email]",
    "level: 'low' | 'high'",
    "label: Label",
  ])("accepts %s", async (field) => {
    const extra = "type Label = string\n";
    expect(await errorsFor(collection(`${ann}\n    ${field}`, extra))).toEqual([]);
  });

  it("accepts a string inside an array of objects", async () => {
    expect(
      await errorsFor(collection(`people: {\n        ${ann}\n        name: string\n    }[]`)),
    ).toEqual([]);
  });

  it("accepts a view field reading a string field", async () => {
    expect(
      await errorsFor(`
@db.table 'items'
@db.mongo.collection
export interface Item {
    @meta.id
    id: string
    title: string
}

@db.view 'item_view'
@db.view.for Item
export interface ItemView {
    id: Item.id
    ${ann}
    title: Item.title
}
`),
    ).toEqual([]);
  });
});
