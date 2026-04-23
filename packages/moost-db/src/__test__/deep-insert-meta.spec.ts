import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { build } from "@atscript/core";
import { tsPlugin as ts } from "@atscript/typescript";
import dbPlugin from "@atscript/db/plugin";

import { AsDbReadableController } from "../as-db-readable.controller";

/**
 * Meta-serializer integration for `@db.deep.insert`. Each scenario hits the
 * real atscript build + `serializeAnnotatedType` path — this is the contract
 * the db-client runtime observes on the wire, not just the controller's
 * `refDepth` option value.
 */

async function prepareFixtures() {
  const wd = path.join(path.dirname(import.meta.url.slice(7)), "fixtures");
  const repo = await build({
    rootDir: wd,
    include: ["**/*.as"],
    plugins: [ts(), dbPlugin()],
  });
  const out = await repo.generate({ outDir: ".", format: "js" });
  const outDts = await repo.generate({ outDir: ".", format: "dts" });
  for (const file of [...out, ...outDts]) {
    if (existsSync(file.target)) {
      const content = readFileSync(file.target).toString();
      if (content !== file.content) {
        writeFileSync(file.target, file.content);
      }
    } else {
      writeFileSync(file.target, file.content);
    }
  }
}

function makeReadable(type: any) {
  return {
    tableName: "t",
    isView: false,
    type,
    flatMap: new Map([["", {} as any]]),
    primaryKeys: ["id"],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map(),
    fieldDescriptors: [],
    isSearchable: () => false,
    isVectorSearchable: () => false,
    getSearchIndexes: () => [],
  } as any;
}

function makeApp() {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    log: () => {},
    debug: () => {},
  };
  return { getLogger: () => logger } as any;
}

/** Exposes the protected `getSerializeOptions` so tests can assert on it directly. */
class ExposedController extends AsDbReadableController {
  public expose() {
    return this.getSerializeOptions();
  }
  public serialize() {
    return this.getSerializedType();
  }
}

function findFkRef(serialized: any, fkField: string): any {
  const props = serialized?.type?.props ?? serialized?.props;
  if (!props) return undefined;
  const entry = props[fkField] ?? props.get?.(fkField);
  return entry?.ref;
}

describe("AsDbReadableController — @db.deep.insert meta serialization", () => {
  let RootZero: any;
  let RootTwo: any;
  let RootNone: any;

  beforeAll(async () => {
    await prepareFixtures();
    const mod = await import("./fixtures/deep-insert-meta.as");
    RootZero = mod.RootZero;
    RootTwo = mod.RootTwo;
    RootNone = mod.RootNone;
  });

  // ── Wire-shape checks — exercise the full serializer path ────────────

  it("sets refDepth = 0.5 when @db.deep.insert 0", () => {
    const c = new ExposedController(makeReadable(RootZero), makeApp());
    const opts = c.expose();
    expect(opts.refDepth).toBe(0.5);
  });

  it("sets refDepth = 2.5 when @db.deep.insert 2", () => {
    const c = new ExposedController(makeReadable(RootTwo), makeApp());
    const opts = c.expose();
    expect(opts.refDepth).toBe(2.5);
  });

  it("sets refDepth = 0.5 when no annotation (breaking default)", () => {
    const c = new ExposedController(makeReadable(RootNone), makeApp());
    const opts = c.expose();
    expect(opts.refDepth).toBe(0.5);
  });

  it("@db.deep.insert 0 → FK ref.type is the shallow { id, metadata } shape", () => {
    const c = new ExposedController(makeReadable(RootZero), makeApp());
    const serialized = c.serialize();
    const ref = findFkRef(serialized, "leafId");
    expect(ref).toBeDefined();
    expect(ref.type).toBeDefined();
    // Shallow ref: no `type` kind / props expansion — only id + metadata
    expect(ref.type.props).toBeUndefined();
    expect(ref.type.kind).toBeUndefined();
    expect("id" in ref.type).toBe(true);
    expect("metadata" in ref.type).toBe(true);
  });

  it("no annotation → FK ref.type is the shallow shape (BREAKING vs prior refDepth: 1)", () => {
    const c = new ExposedController(makeReadable(RootNone), makeApp());
    const serialized = c.serialize();
    const ref = findFkRef(serialized, "leafId");
    expect(ref).toBeDefined();
    expect(ref.type.props).toBeUndefined();
    expect(ref.type.kind).toBeUndefined();
    expect("id" in ref.type).toBe(true);
  });

  it("@db.deep.insert 2 → first FK level is fully expanded, second shallow", () => {
    const c = new ExposedController(makeReadable(RootTwo), makeApp());
    const serialized = c.serialize();
    const midRef = findFkRef(serialized, "midId");
    expect(midRef).toBeDefined();
    // Level 1: Mid is fully expanded — has props.
    expect(midRef.type.type?.props ?? midRef.type.props).toBeDefined();
    // Level 2: Mid.leafId → Leaf should be shallow.
    const leafRef = findFkRef(midRef.type, "leafId");
    expect(leafRef).toBeDefined();
    expect(leafRef.type.props).toBeUndefined();
    expect(leafRef.type.kind).toBeUndefined();
    expect("id" in leafRef.type).toBe(true);
  });
});
