import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { build } from "@atscript/core";
import { tsPlugin as ts } from "@atscript/typescript";
import dbPlugin from "@atscript/db/plugin";
import { HttpError } from "@moostjs/event-http";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { AsReadableController } from "../as-readable.controller";
import { discoverActions } from "../actions/discover";
import { fakeOverview, idMate, inputFormMate, makeApp } from "./actions-test-utils";

/**
 * Coverage for `GET /meta/form/:name` — the per-controller form schema
 * endpoint. Uses real compiled `.as` form interfaces so `serializeAnnotatedType`
 * sees the same shape it does at runtime.
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

function makeBoundType(): TAtscriptAnnotatedType {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
    metadata: new Map(),
  } as unknown as TAtscriptAnnotatedType;
}

describe("AsReadableController.metaForm", () => {
  let CommentForm: TAtscriptAnnotatedType & { name: string };

  beforeAll(async () => {
    await prepareFixtures();
    const mod = await import("./fixtures/input-form.as");
    CommentForm = mod.CommentForm as unknown as TAtscriptAnnotatedType & { name: string };
  });

  it("returns a serialized schema for a registered form", async () => {
    class WithFormCtrl extends AsReadableController {
      protected hasField(): boolean {
        return true;
      }
    }
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(WithFormCtrl, [
        {
          method: "approve",
          httpMethod: "POST",
          path: "/x/actions/approve",
          action: { name: "approve", opts: { label: "Approve" } },
          paramMates: [idMate(), inputFormMate(CommentForm)],
        },
      ]),
    ]);
    discoverActions(WithFormCtrl, ctx.app, ctx.logger);

    const ctrl = new WithFormCtrl(makeBoundType(), "test", ctx.app);
    const schema = await ctrl.metaForm("CommentForm");
    expect(schema).toBeDefined();
    expect(typeof schema).toBe("object");
  });

  it("throws HttpError(404) when the form name is not registered", async () => {
    class EmptyCtrl extends AsReadableController {
      protected hasField(): boolean {
        return true;
      }
    }
    const ctx = makeApp();
    ctx.setOverview([fakeOverview(EmptyCtrl, [])]);
    const ctrl = new EmptyCtrl(makeBoundType(), "test", ctx.app);
    await expect(ctrl.metaForm("Unknown")).rejects.toBeInstanceOf(HttpError);
  });

  it("triggers discovery lazily — works even before /meta has been hit", async () => {
    class FreshCtrl extends AsReadableController {
      protected hasField(): boolean {
        return true;
      }
    }
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(FreshCtrl, [
        {
          method: "approve",
          httpMethod: "POST",
          path: "/x/actions/approve",
          action: { name: "approve", opts: { label: "Approve" } },
          paramMates: [idMate(), inputFormMate(CommentForm)],
        },
      ]),
    ]);
    const ctrl = new FreshCtrl(makeBoundType(), "test", ctx.app);
    // No prior call to .meta() or discoverActions() — metaForm should still resolve.
    const schema = await ctrl.metaForm("CommentForm");
    expect(schema).toBeDefined();
  });

  it("caches the serialized schema (subsequent reads return the same object)", async () => {
    class CachedCtrl extends AsReadableController {
      protected hasField(): boolean {
        return true;
      }
    }
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(CachedCtrl, [
        {
          method: "approve",
          httpMethod: "POST",
          path: "/x/actions/approve",
          action: { name: "approve", opts: { label: "Approve" } },
          paramMates: [idMate(), inputFormMate(CommentForm)],
        },
      ]),
    ]);
    const ctrl = new CachedCtrl(makeBoundType(), "test", ctx.app);
    const a = await ctrl.metaForm("CommentForm");
    const b = await ctrl.metaForm("CommentForm");
    expect(a).toBe(b);
  });
});
