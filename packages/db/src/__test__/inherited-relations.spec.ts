import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, it, expect } from "vite-plus/test";

import dbPlugin from "../plugin";

// A table that extends another table inherits its `@db.rel.from` /
// `@db.rel.via` fields, but the child's (junction's) foreign key references
// the base table: the extending table cannot load or write them — a warning
// on its `@db.table` (writes are refused at run time).

const base = `
@db.table 'ir_parents'
export interface IrParent {
    @meta.id
    id: number

    @db.rel.from
    kids?: IrKid[]

    @db.rel.via IrParentTag
    tags?: IrTag[]
}

@db.table 'ir_kids'
export interface IrKid {
    @meta.id
    id: number

    @db.rel.FK
    parentId?: IrParent.id
}

@db.table 'ir_tags'
export interface IrTag {
    @meta.id
    id: number
}

@db.table 'ir_parent_tags'
export interface IrParentTag {
    @meta.id
    id: number

    @db.rel.FK
    parentId: IrParent.id

    @db.rel.FK
    tagId: IrTag.id
}
`;

async function diagnostics(extra: string): Promise<Array<{ severity: number; message: string }>> {
  const rootDir = mkdtempSync(join(tmpdir(), "inherited-relations-"));
  writeFileSync(join(rootDir, "fixture.as"), base + extra);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  return [...(await repo.diagnostics()).values()]
    .flat()
    .map((m) => ({ severity: m.severity!, message: m.message }));
}

describe("inherited FROM / VIA relations on a table with another name", () => {
  it("warns once per relation, naming both tables", async () => {
    const found = await diagnostics(`
@db.table 'ir_special'
export interface IrSpecial extends IrParent {
    extra?: string
}
`);
    expect(found).toEqual([
      {
        severity: 2,
        message:
          'Inherited relation "kids" (@db.rel.from) is linked to "ir_parents", not to "ir_special" — here its nested writes are refused and it loads nothing; redeclare "kids" with a @db.rel.FK referencing IrSpecial',
      },
      {
        severity: 2,
        message:
          'Inherited relation "tags" (@db.rel.via) is linked to "ir_parents", not to "ir_special" — here its nested writes are refused and it loads nothing; redeclare "tags" with a @db.rel.FK referencing IrSpecial',
      },
    ]);
  });

  it("no warning for the same table name or a non-table", async () => {
    expect(
      await diagnostics(`
@db.table 'ir_parents'
export interface IrParentV2 extends IrParent {
    extra?: string
}

export interface IrDto extends IrParent {
    extra?: string
}
`),
    ).toEqual([]);
  });
});
