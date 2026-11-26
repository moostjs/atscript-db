import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, it, expect } from "vite-plus/test";

import dbPlugin from "../plugin";

/**
 * `@db.rel.store` (since 0.1.196): a navigation without foreign keys,
 * correlated by the store — valid only on a table whose adapter reads
 * relations in-read, loaded with `$with`, never written.
 */

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "rel-store-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  return [...(await repo.diagnostics()).values()].flat().map((m) => m.message);
}

// ── Compile rules (K1) ──────────────────────────────────────────────────────

const TABLES = `
  @db.table 'k_people'
  export interface KPerson {
    @meta.id
    id: number
  }
  export interface KPlain {
    id: number
  }
`;

describe("K1: where @db.rel.store compiles", () => {
  it("the fixture compiles: to-one and to-many store navigations, with @db.rel.filter / .filterable", async () => {
    const messages = await diagnosticsFor(`${TABLES}
      @db.table 'k_teams'
      export interface KTeam {
        @meta.id
        id: number
        @db.rel.store
        @db.rel.filterable
        @db.rel.filter \`KPerson.id > 0\`
        members: KPerson[]
        @db.rel.store
        lead?: KPerson
      }
    `);
    expect(messages).toEqual([]);
  });

  it("only on a field of a @db.table interface", async () => {
    const messages = await diagnosticsFor(`${TABLES}
      export interface KForm {
        @db.rel.store
        lead?: KPerson
      }
    `);
    expect(messages).toContain("@db.rel.store is only valid on fields of a @db.table interface");
  });

  it("typed as a @db.table entity or an array of one, no union", async () => {
    const messages = await diagnosticsFor(`${TABLES}
      @db.table 'k_teams'
      export interface KTeam {
        @meta.id
        id: number
        @db.rel.store
        plain?: KPlain
        @db.rel.store
        name?: string
        @db.rel.store
        inline?: { a: number }
        @db.rel.store
        either?: KPerson | KPlain
      }
    `);
    expect(messages).toEqual(
      expect.arrayContaining([
        "@db.rel.store target 'KPlain' is not a @db.table entity",
        "@db.rel.store target 'string' is not a @db.table entity",
        "@db.rel.store requires a @db.table type or an array of one (e.g. User or Comment[])",
        "@db.rel.store does not support union types — use separate relations",
      ]),
    );
  });

  it("not with @db.rel.to / .from / .via or @db.rel.FK (F6 and V6 count it too)", async () => {
    const messages = await diagnosticsFor(`${TABLES}
      @db.table 'k_links'
      export interface KLink {
        @meta.id
        id: number
        @db.rel.FK
        teamId: KTeam.id
        @db.rel.FK
        personId: KPerson.id
      }
      @db.table 'k_teams'
      export interface KTeam {
        @meta.id
        id: number
        @db.rel.store
        @db.rel.FK
        ownerId: KPerson.id
        @db.rel.store
        @db.rel.via KLink
        people: KPerson[]
      }
    `);
    expect(messages).toEqual(
      expect.arrayContaining([
        "@db.rel.store cannot be combined with @db.rel.FK — it is a relation without foreign keys",
        "A field cannot be both a foreign key and a navigational property",
        "@db.rel.store cannot be combined with @db.rel.via — it is a relation without foreign keys",
        "@db.rel.via is self-sufficient — cannot be combined with @db.rel.to, @db.rel.from or @db.rel.store",
      ]),
    );
  });

  it("an inherited store relation is not one of another table's foreign keys (no warning)", async () => {
    const messages = await diagnosticsFor(`${TABLES}
      @db.table 'k_base'
      export interface KBase {
        @meta.id
        id: number
        @db.rel.store
        lead?: KPerson
      }
      @db.table 'k_child'
      export interface KChild extends KBase {
        note?: string
      }
    `);
    expect(messages).toEqual([]);
  });
});
