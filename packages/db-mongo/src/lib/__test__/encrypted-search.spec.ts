import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { DbSpace } from "@atscript/db";
import dbPlugin from "@atscript/db/plugin";
import { tsPlugin } from "@atscript/typescript";
import type { Db } from "mongodb";
import { describe, expect, it } from "vite-plus/test";

import { MongoPlugin } from "../../plugin";
import { MongoAdapter } from "../mongo-adapter";

// Atlas Search over an `@db.encrypted` field's ciphertext is refused at
// compile time and when the collection's metadata is built (since 0.1.162).

async function errorsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "mongo-encrypted-search-"));
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

describe("compile time", () => {
  it("refuses @db.mongo.search.dynamic on a collection with an encrypted field", async () => {
    const found = await errorsFor(`
@db.table 'secrets'
@db.mongo.collection
@db.mongo.search.dynamic
export interface Secret {
    title: string
    profile: {
        @db.encrypted
        token?: string
    }
}
`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /@db\.mongo\.search\.dynamic indexes every field, including the @db\.encrypted field "profile\.token"/,
    );
  });

  it("accepts @db.mongo.search.dynamic without encrypted fields", async () => {
    expect(
      await errorsFor(`
@db.table 'notes'
@db.mongo.collection
@db.mongo.search.dynamic
export interface Note {
    title: string
}
`),
    ).toEqual([]);
  });

  it("accepts @db.mongo.search.dynamic when only a related collection has an encrypted field", async () => {
    expect(
      await errorsFor(`
@db.table 'users'
@db.mongo.collection
export interface User {
    @meta.id
    id: string
    @db.encrypted
    ssn?: string
}

@db.table 'posts'
@db.mongo.collection
@db.mongo.search.dynamic
export interface Post {
    @meta.id
    id: string
    title: string
    @db.rel.FK
    authorId: User.id
    @db.rel.to
    author?: User
}
`),
    ).toEqual([]);
  });

  it.each(["@db.mongo.search.text", "@db.mongo.search.autocomplete"])(
    "refuses %s inside an encrypted object",
    async (ann) => {
      const found = await errorsFor(`
@db.table 'secrets'
@db.mongo.collection
@db.mongo.search.static
export interface Secret {
    @db.encrypted
    profile?: {
        ${ann}
        name: string
    }
}
`);
      expect(found).toEqual([
        `${ann} on "name" — it is inside the @db.encrypted field "profile"; search over ciphertext is impossible`,
      ]);
    },
  );

  it.each(["@db.mongo.search.text", "@db.mongo.search.autocomplete"])(
    "refuses %s inside the type of a ref-typed encrypted field",
    async (ann) => {
      const found = await errorsFor(`
export interface Profile {
    ${ann}
    name: string
}

@db.table 'secrets'
@db.mongo.collection
@db.mongo.search.static
export interface Secret {
    @db.encrypted
    profile?: Profile
}
`);
      expect(found).toEqual([
        `@db.encrypted on "profile" — its type declares @${ann.slice(1)} on "profile.name"; search over ciphertext is impossible`,
      ]);
    },
  );

  it.each(["@db.mongo.search.text", "@db.mongo.search.autocomplete"])(
    "refuses %s on a view field over an encrypted source",
    async (ann) => {
      const found = await errorsFor(`
@db.table 'secrets'
@db.mongo.collection
export interface Secret {
    @meta.id
    id: string
    @db.encrypted
    token?: string
}

@db.view 'secret_view'
@db.view.for Secret
export interface SecretView {
    id: Secret.id
    ${ann}
    token?: Secret.token
}
`);
      expect(found).toEqual([
        `${ann} on "token" — it reads a @db.encrypted source field; search over ciphertext is impossible`,
      ]);
    },
  );
});

describe("metadata build", () => {
  const leaf = (metadata: Array<[string, unknown]> = []) =>
    ({
      __is_atscript_annotated_type: true,
      type: { kind: "", designType: "string", tags: new Set() },
      metadata: new Map(metadata),
    }) as any;

  it("refuses a dynamic Atlas index over a collection with an encrypted field", () => {
    const type = {
      __is_atscript_annotated_type: true,
      type: {
        kind: "object",
        props: new Map([
          ["_id", leaf([["meta.id", true]])],
          ["title", leaf()],
          ["token", leaf([["db.encrypted", true]])],
        ]),
      },
      metadata: new Map<string, unknown>([
        ["db.table", "enc_dynamic"],
        ["db.mongo.collection", true],
        ["db.mongo.search.dynamic", { analyzer: "lucene.standard" }],
      ]),
    } as any;
    const space = new DbSpace(() => new MongoAdapter({} as Db), {
      encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
    });
    expect(() => space.getTable(type).getMetadata()).toThrow(
      /@db\.mongo\.search\.dynamic indexes every field, including the @db\.encrypted field "token"/,
    );
  });
});
