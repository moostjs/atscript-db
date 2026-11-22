import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";
import { mergeStrategyPaths } from "../shared/merge-paths";
import { prepareFixtures } from "./test-utils";

// Since 0.1.184 a merge strategy applies only where a patch reaches the object
// by its own path (`mergeStrategyPaths`); elsewhere it is inert. Written where
// it can never apply — on a `@db.json` / `@db.encrypted` field, or inside an
// array element or such a field — it is a build error.

// ── Where the strategy applies ──────────────────────────────────────────────

describe("mergeStrategyPaths", () => {
  it("lists only the objects and arrays a patch reaches by their own path", async () => {
    await prepareFixtures();
    const { PsjRef } = await import("./fixtures/patch-strategy-json.as");
    // `PsjPrefs.theme` applies under `flat` and `maybe` (a `T | null` is a
    // `T`); not under `json`, `secret`, `list`, `union` or `tuple`
    expect([...mergeStrategyPaths(PsjRef)].toSorted()).toEqual([
      "flat",
      "flat.theme",
      "keyed",
      "maybe.theme",
    ]);
  });
});

// ── Build errors ────────────────────────────────────────────────────────────

async function diagnosticsFor(source: string) {
  const rootDir = mkdtempSync(join(tmpdir(), "patch-strategy-json-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  return [...(await repo.diagnostics()).values()]
    .flat()
    .map((m) => ({ message: m.message, severity: m.severity as number }));
}

const PRELUDE = `
export interface PsjG {
    a?: string
}
`;

/** The error messages of a table with `body` (none but the merge ones are expected). */
async function errorsOf(body: string) {
  const source = `${PRELUDE}
@db.table 'psj_t'
export interface PsjT {
    @meta.id
    id: number
    ${body}
}
`;
  return (await diagnosticsFor(source)).filter((m) => m.severity === 1).map((m) => m.message);
}

const MERGE = `@db.patch.strategy 'merge'`;
const GEO = `${MERGE}
        geo?: { lat: number, lng: number }`;
const KEY = `@expect.array.key
            k: string`;

describe('@db.patch.strategy "merge" build errors', () => {
  it.each([
    ["@db.json, before", `@db.json\n    ${MERGE}\n    settings: { a?: string }`, "@db.json"],
    ["@db.json, after", `${MERGE}\n    @db.json\n    settings: { a?: string }`, "@db.json"],
    [
      "@db.json on an array (double quotes)",
      `@db.json\n    @db.patch.strategy "merge"\n    list: {\n            ${KEY}\n    }[]`,
      "@db.json",
    ],
    ["@db.encrypted", `@db.encrypted\n    ${MERGE}\n    secret: { a?: string }`, "@db.encrypted"],
  ])("on the same field as %s", async (_case, body, other) => {
    expect(await errorsOf(body)).toEqual([
      expect.stringContaining(`@db.patch.strategy "merge" cannot coexist with ${other}`),
    ]);
  });

  it.each([
    [
      "a @db.json field",
      `@db.json\n    payload: {\n        ${GEO}\n    }`,
      "a @db.json field ('payload')",
    ],
    [
      "a @db.json field, deeper",
      `@db.json\n    payload: {\n        mid: {\n        ${GEO}\n        }\n    }`,
      "a @db.json field ('payload')",
    ],
    [
      "a @db.encrypted field",
      `@db.encrypted\n    secret: {\n        ${GEO}\n    }`,
      "a @db.encrypted field ('secret')",
    ],
    [
      "an array element (keyed, merge array)",
      `${MERGE}\n    items: {\n            ${KEY}\n        ${GEO}\n    }[]`,
      "an array element ('items')",
    ],
    [
      "an array element (an array)",
      `items: {\n        ${MERGE}\n        tags: {\n            ${KEY}\n        }[]\n    }[]`,
      "an array element ('items')",
    ],
  ])("inside %s", async (_case, body, where) => {
    expect(await errorsOf(body)).toEqual([
      expect.stringContaining(
        `@db.patch.strategy "merge" cannot sit inside ${where} — it is written as one value`,
      ),
    ]);
  });

  // The build sees where the annotation is written and walks up through
  // arrays only: a referenced type's merge field (`jprefs`, `list`) and one
  // inside a type group (`| null`, `&`, a union, a tuple — whose members have
  // no owner node to walk up from) are inert at runtime, not build errors.
  it("keeps the valid, referenced and type-group placements free of diagnostics", async () => {
    const d = await diagnosticsFor(`${PRELUDE}
export interface PsjPrefs {
    ${MERGE}
    theme?: { dark?: boolean }
}

@db.table 'psj_t'
export interface PsjT {
    @meta.id
    id: number
    ${MERGE}
    stats: {
        views?: number
        nested?: {
            ${MERGE}
            leaf?: { x?: string }
        }
    }
    outer?: {
        a?: string
        ${MERGE}
        inner?: { x?: string, y?: string }
        ${MERGE}
        lines?: {
            ${KEY}
            v?: string
        }[]
    }
    maybe?: {
        ${GEO}
    } | null
    both?: PsjG & {
        ${GEO}
    }
    ${MERGE}
    attributes: {
        ${KEY}
        value?: string
    }[]
    @db.patch.strategy 'replace'
    @db.json
    blob: { a: string }
    @db.json
    doc: { inner: { x: string } }
    @db.json
    tags: string[]
    prefs: PsjPrefs
    @db.json
    jprefs: PsjPrefs
    list: PsjPrefs[]
    nullables: ({
        ${GEO}
    } | null)[]
    intersections: (PsjG & {
        ${GEO}
    })[]
    pair: [{
        ${GEO}
    }, number]
    loc: {
        ${GEO}
    } | string
    ${MERGE}
    nullableInline?: { a?: string } | null
    ${MERGE}
    nullableRef?: PsjG | null
}`);
    expect(d).toEqual([]);
  });

  // An object `T | null` is a `T` (since 0.1.184): merge on it applies at
  // runtime. Array operators are refused on a `T[] | null`, so merge never
  // applies there.
  it.each([
    ["a union of objects", `${MERGE}\n    u?: PsjG | { b?: string }`],
    ["a nullable string", `${MERGE}\n    s?: string | null`],
    ["a nullable array of objects", `${MERGE}\n    a?: {\n            ${KEY}\n    }[] | null`],
    ["a nullable array of strings", `${MERGE}\n    t?: string[] | null`],
  ])("still requires an object or array, not %s", async (_case, body) => {
    expect(await errorsOf(body)).toEqual([
      "@db.patch.strategy requires a field of type object or array",
    ]);
  });
});
