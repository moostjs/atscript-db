import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { build } from "@atscript/core";
import { tsPlugin as ts } from "@atscript/typescript";
import dbPlugin from "@atscript/db/plugin";

import { AsDbReadableController } from "../as-db-readable.controller";

/**
 * `/meta` serialization shape contract. Every scenario confirms that the meta
 * serializer ships a fixed `refDepth: 0.5` — independent of `@db.depth.limit`,
 * which is a security guard on nested writes and deliberately decoupled from
 * wire shape. Each case hits the real atscript build + `serializeAnnotatedType`
 * path so the observed shape matches what db-client sees at runtime.
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

describe("AsDbReadableController — /meta serialization shape", () => {
  let RootZero: any;
  let RootTwo: any;
  let RootNone: any;

  beforeAll(async () => {
    await prepareFixtures();
    const mod = await import("./fixtures/depth-limit-meta.as");
    RootZero = mod.RootZero;
    RootTwo = mod.RootTwo;
    RootNone = mod.RootNone;
  });

  // ── refDepth is statically 0.5 — not derived from @db.depth.limit ─────

  it("ships refDepth = 0.5 for @db.depth.limit 0", () => {
    const c = new ExposedController(makeReadable(RootZero), makeApp());
    expect(c.expose().refDepth).toBe(0.5);
  });

  it("ships refDepth = 0.5 even when @db.depth.limit 2 (annotation does not raise ref expansion)", () => {
    const c = new ExposedController(makeReadable(RootTwo), makeApp());
    expect(c.expose().refDepth).toBe(0.5);
  });

  it("ships refDepth = 0.5 when no annotation is present", () => {
    const c = new ExposedController(makeReadable(RootNone), makeApp());
    expect(c.expose().refDepth).toBe(0.5);
  });

  // ── Wire-shape: every FK ref is shallow regardless of annotation ──────

  it("@db.depth.limit 0 → FK ref.type is the shallow { id, metadata } shape", () => {
    const c = new ExposedController(makeReadable(RootZero), makeApp());
    const ref = findFkRef(c.serialize(), "leafId");
    expect(ref).toBeDefined();
    expect(ref.type.props).toBeUndefined();
    expect(ref.type.kind).toBeUndefined();
    expect("id" in ref.type).toBe(true);
    expect("metadata" in ref.type).toBe(true);
  });

  it("no annotation → FK ref.type is the shallow shape", () => {
    const c = new ExposedController(makeReadable(RootNone), makeApp());
    const ref = findFkRef(c.serialize(), "leafId");
    expect(ref).toBeDefined();
    expect(ref.type.props).toBeUndefined();
    expect(ref.type.kind).toBeUndefined();
    expect("id" in ref.type).toBe(true);
  });

  it("@db.depth.limit 2 → FK ref.type is STILL the shallow shape (annotation does not trigger expansion)", () => {
    const c = new ExposedController(makeReadable(RootTwo), makeApp());
    const midRef = findFkRef(c.serialize(), "midId");
    expect(midRef).toBeDefined();
    // With refDepth: 0.5 the first FK hop is already shallow — the annotation
    // does not open up deeper ref expansion in meta, only the write-acceptance
    // gate (which is tested in packages/db/src/__test__/depth-limit-enforcement.spec.ts).
    expect(midRef.type.props).toBeUndefined();
    expect(midRef.type.kind).toBeUndefined();
    expect("id" in midRef.type).toBe(true);
    expect("metadata" in midRef.type).toBe(true);
  });
});
