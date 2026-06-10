import { randomBytes } from "node:crypto";

import { describe, it, expect } from "vite-plus/test";

import { DbSpace } from "../table/db-space";
import { MockAdapter } from "./test-utils";

// Build-time constraint checks (field-encryption spec §6, geo-index spec §3).
// Hand-built annotated types are used on purpose: the AnnotationSpec-level
// `validate()` hooks reject these combinations at .as compile time, so a
// compiled fixture can never carry them — the runtime metadata-build guards
// exist exactly for type definitions that bypass the compiler.

const ENCRYPTION = { defaultKeyId: "k1", keys: { k1: randomBytes(32) } };

function leaf(
  designType: string,
  metadata: Array<[string, unknown]> = [],
  opts: { optional?: boolean; tags?: string[] } = {},
) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "", designType, tags: new Set(opts.tags ?? []) },
    metadata: new Map(metadata),
    optional: opts.optional,
  } as any;
}

function geoLeaf(metadata: Array<[string, unknown]> = []) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "array", of: leaf("number"), tags: new Set(["db", "geoPoint"]) },
    metadata: new Map(metadata),
  } as any;
}

function objLeaf(props: Record<string, any>, metadata: Array<[string, unknown]> = []) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "object", props: new Map(Object.entries(props)) },
    metadata: new Map(metadata),
  } as any;
}

let tableSeq = 0;
function buildTable(props: Record<string, any>) {
  const type = {
    __is_atscript_annotated_type: true,
    type: { kind: "object", props: new Map(Object.entries(props)) },
    metadata: new Map([["db.table", `constraints_${tableSeq++}`]]),
  } as any;
  const table = new DbSpace(() => new MockAdapter(), { encryption: ENCRYPTION }).getTable(type);
  table.getMetadata();
  return table;
}

const id = () => leaf("string", [["meta.id", true]]);

describe("@db.encrypted — rejected combinations (metadata build)", () => {
  it.each([
    [
      "@meta.id",
      [
        ["db.encrypted", true],
        ["meta.id", true],
      ],
    ],
    [
      "@db.rel.FK",
      [
        ["db.encrypted", true],
        ["db.rel.FK", true],
      ],
    ],
    [
      "@db.index.plain",
      [
        ["db.encrypted", true],
        ["db.index.plain", [true]],
      ],
    ],
    [
      "@db.index.unique",
      [
        ["db.encrypted", true],
        ["db.index.unique", [true]],
      ],
    ],
    [
      "@db.index.fulltext",
      [
        ["db.encrypted", true],
        ["db.index.fulltext", [true]],
      ],
    ],
    [
      "@db.search.vector",
      [
        ["db.encrypted", true],
        ["db.search.vector", { dimensions: 3 }],
      ],
    ],
    [
      "@db.search.filter",
      [
        ["db.encrypted", true],
        ["db.search.filter", ["idx"]],
      ],
    ],
    [
      "@db.column.version",
      [
        ["db.encrypted", true],
        ["db.column.version", true],
      ],
    ],
    [
      "@db.default.increment",
      [
        ["db.encrypted", true],
        ["db.default.increment", true],
      ],
    ],
    [
      "@db.default.now",
      [
        ["db.encrypted", true],
        ["db.default.now", true],
      ],
    ],
    [
      "@db.mongo.search.text",
      [
        ["db.encrypted", true],
        ["db.mongo.search.text", [{}]],
      ],
    ],
    [
      '@db.patch.strategy "merge"',
      [
        ["db.encrypted", true],
        ["db.patch.strategy", "merge"],
      ],
    ],
  ] as Array<[string, Array<[string, unknown]>]>)("rejects @db.encrypted + %s", (_label, meta) => {
    expect(() => buildTable({ id: id(), secret: leaf("string", meta) })).toThrow(/@db.encrypted/);
  });

  it("rejects an FK referencing an encrypted target field", () => {
    const target = objLeaf({ token: leaf("string", [["db.encrypted", true]]) }, [
      ["db.table", "fk_target"],
    ]);
    const fkField = leaf("string", [["db.rel.FK", true]]);
    fkField.ref = { type: () => target, field: "token" };
    expect(() => buildTable({ id: id(), tokenRef: fkField })).toThrow(/encrypted field/);
  });
});

describe("@db.index.geo — rejected combinations (metadata build)", () => {
  it("rejects @db.index.geo on a non-geoPoint field", () => {
    expect(() => buildTable({ id: id(), name: leaf("string", [["db.index.geo", true]]) })).toThrow(
      /db.geoPoint/,
    );
  });

  it("rejects @db.index.geo + @db.encrypted", () => {
    expect(() =>
      buildTable({
        id: id(),
        geo: geoLeaf([
          ["db.index.geo", true],
          ["db.encrypted", true],
        ]),
      }),
    ).toThrow();
  });

  it("rejects @db.index.geo + @db.json", () => {
    expect(() =>
      buildTable({
        id: id(),
        geo: geoLeaf([
          ["db.index.geo", true],
          ["db.json", true],
        ]),
      }),
    ).toThrow(/db.json/);
  });

  it("rejects geo fields in the PK", () => {
    expect(() =>
      buildTable({
        geo: geoLeaf([
          ["db.index.geo", true],
          ["meta.id", true],
        ]),
      }),
    ).toThrow(/primary key/);
  });

  it("rejects geo fields in a unique index", () => {
    expect(() =>
      buildTable({
        id: id(),
        geo: geoLeaf([
          ["db.index.geo", true],
          ["db.index.unique", [true]],
        ]),
      }),
    ).toThrow(/unique/);
  });

  it("rejects geo fields as FKs", () => {
    expect(() =>
      buildTable({
        id: id(),
        geo: geoLeaf([
          ["db.index.geo", true],
          ["db.rel.FK", true],
        ]),
      }),
    ).toThrow(/foreign key/);
  });

  it("rejects nested geo indexes (v1 top-level only)", () => {
    expect(() =>
      buildTable({
        id: id(),
        loc: objLeaf({ point: geoLeaf([["db.index.geo", true]]) }),
      }),
    ).toThrow(/top-level/);
  });

  it("accepts a structurally identical number[] field", () => {
    const numericArray = {
      __is_atscript_annotated_type: true,
      type: { kind: "array", of: leaf("number"), tags: new Set() },
      metadata: new Map([["db.index.geo", true]]),
    } as any;
    const table = buildTable({ id: id(), coords: numericArray });
    expect([...table.indexes.values()].some((i) => i.type === "geo")).toBe(true);
  });
});
