import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import { DbSpace } from "../index";
import dbPlugin from "../plugin";
import { MockAdapter, prepareFixtures } from "./test-utils";

// Search / index features never read ciphertext (since 0.1.162): refused on
// an @db.encrypted field (now incl. @db.column.searchable), on a field inside
// an encrypted object, and on a view field over an encrypted source — at
// compile time and when the metadata is built.

async function errorsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "encrypted-search-"));
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

const FEATURES: Array<[string, string]> = [
  ["@db.column.searchable", "note: string"],
  ["@db.index.fulltext 'ft'", "note: string"],
  ["@db.index.geo", "loc: db.geoPoint"],
  ["@db.search.vector 256", "emb: db.vector"],
  ["@db.search.filter 'emb'", "note: string"],
];

describe("compile time", () => {
  it("refuses @db.column.searchable on an @db.encrypted field", async () => {
    const found = await errorsFor(`
@db.table 'es_own'
export interface Own {
    @meta.id
    id: number.int
    @db.encrypted
    @db.column.searchable
    note?: string
}
`);
    expect(found).toEqual([
      "@db.encrypted cannot coexist with @db.column.searchable — search over ciphertext is impossible",
    ]);
  });

  it.each(FEATURES)("refuses %s inside an encrypted object", async (ann, decl) => {
    const found = await errorsFor(`
@db.table 'es_nested'
export interface Nested {
    @meta.id
    id: number.int
    @db.encrypted
    secret?: {
        ${ann}
        ${decl}
    }
}
`);
    const name = decl.split(":")[0];
    expect(found).toContain(
      `${ann.split(" ")[0]} on "${name}" — it is inside the @db.encrypted field "secret"; search over ciphertext is impossible`,
    );
  });

  it.each(FEATURES)(
    "refuses %s inside the type of a ref-typed encrypted field",
    async (ann, decl) => {
      const found = await errorsFor(`
export interface Secret {
    ${ann}
    ${decl}
}

@db.table 'es_ref'
export interface RefOwner {
    @meta.id
    id: number.int
    @db.encrypted
    secret?: { inner?: Secret }
}
`);
      const name = decl.split(":")[0];
      expect(found).toContain(
        `@db.encrypted on "secret" — its type declares @${ann.split(" ")[0].slice(1)} on "secret.inner.${name}"; search over ciphertext is impossible`,
      );
    },
  );

  it("accepts a ref-typed encrypted field whose type has no search feature, and skips relations", async () => {
    expect(
      await errorsFor(`
@db.table 'es_users'
export interface User {
    @meta.id
    id: number.int
    @db.column.searchable
    name: string
}

export interface Profile {
    bio: string
}

@db.table 'es_ref_ok'
export interface RefOk {
    @meta.id
    id: number.int
    @db.encrypted
    profile?: Profile
    @db.rel.FK
    userId: User.id
}
`),
    ).toEqual([]);
  });

  it.each([
    ["@db.column.searchable", "token?: Account.token"],
    ["@db.index.fulltext 'ft'", "token?: Account.token"],
    ["@db.search.vector 256", "emb?: Account.emb"],
  ])("refuses %s on a view field over an encrypted source (%s)", async (ann, decl) => {
    const found = await errorsFor(`
@db.table 'es_accounts'
export interface Account {
    @meta.id
    id: number.int
    @db.encrypted
    token?: string
    @db.encrypted
    emb?: db.vector
}

@db.view 'es_account_view'
@db.view.for Account
export interface AccountView {
    id: Account.id
    ${ann}
    ${decl}
}
`);
    const name = decl.split("?")[0];
    expect(found).toEqual([
      `${ann.split(" ")[0]} on "${name}" — it reads a @db.encrypted source field; search over ciphertext is impossible`,
    ]);
  });

  it("accepts search features on plain fields", async () => {
    expect(
      await errorsFor(`
@db.table 'es_plain'
export interface Plain {
    @meta.id
    id: number.int
    @db.column.searchable
    title: string
    profile: {
        @db.index.fulltext 'ft'
        bio: string
    }
}
`),
    ).toEqual([]);
  });
});

describe("metadata build", () => {
  const ENCRYPTION = { defaultKeyId: "k1", keys: { k1: randomBytes(32) } };
  const space = () => new DbSpace(() => new MockAdapter(), { encryption: ENCRYPTION });
  const leaf = (metadata: Array<[string, unknown]> = []) =>
    ({
      __is_atscript_annotated_type: true,
      type: { kind: "", designType: "string", tags: new Set() },
      metadata: new Map(metadata),
    }) as any;
  const obj = (props: Record<string, any>, metadata: Array<[string, unknown]> = []) =>
    ({
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(Object.entries(props)) },
      metadata: new Map(metadata),
    }) as any;
  let seq = 0;
  const table = (props: Record<string, any>) =>
    obj({ id: leaf([["meta.id", true]]), ...props }, [["db.table", `es_rt_${seq++}`]]);

  it("refuses @db.column.searchable on an @db.encrypted field", () => {
    const type = table({
      note: leaf([
        ["db.encrypted", true],
        ["db.column.searchable", true],
      ]),
    });
    expect(() => space().getTable(type).getMetadata()).toThrow(
      /@db\.encrypted on "note" cannot coexist with @db\.column\.searchable/,
    );
  });

  it.each([
    ["db.column.searchable", true],
    ["db.index.fulltext", [true]],
  ])("refuses @%s on a field inside an encrypted object", (key, value) => {
    const type = table({
      secret: obj({ note: leaf([[key, value]]) }, [["db.encrypted", true]]),
    });
    expect(() => space().getTable(type).getMetadata()).toThrow(
      `@${key} on "secret.note" — it is inside the @db.encrypted field "secret"; search over ciphertext is impossible`,
    );
  });

  it("refuses a search feature on a view column over an encrypted source", async () => {
    await prepareFixtures();
    const fx: Record<string, any> = await import("./fixtures/view-seals.as");
    // Bypasses the compiler (the plugin refuses it): the view column inherits
    // the source's @db.encrypted seal, and the metadata build refuses it.
    fx.SlAccountView.type.props.get("token").metadata.set("db.column.searchable", true);
    expect(() => space().getView(fx.SlAccountView).getMetadata()).toThrow(
      /@db\.encrypted on "token" cannot coexist with @db\.column\.searchable/,
    );
  });
});
