import { describe, it, expect, beforeAll } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { AsReadableController } from "../as-readable.controller";
import { discoverActions } from "../actions/discover";
import { DbRowActions } from "../actions/db-actions.decorator";
import { fakeOverview, idMate, inputFormMate, makeApp } from "./actions-test-utils";
import { prepareFixtures } from "./test-utils";

/**
 * Coverage for `GET /meta/form/:name` — the per-controller form schema
 * endpoint. Uses real compiled `.as` form interfaces so `serializeAnnotatedType`
 * sees the same shape it does at runtime.
 */

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

  // since 0.1.136
  it("serves a form declared as a type on a class-level entry", async () => {
    @DbRowActions({
      ship: {
        label: "Ship",
        processor: "backend",
        value: "/api/shipping/ship",
        inputForm: CommentForm,
      },
    })
    class ClassLevelCtrl extends AsReadableController {
      protected hasField(): boolean {
        return true;
      }
    }
    const ctx = makeApp();
    const ctrl = new ClassLevelCtrl(makeBoundType(), "test", ctx.app);
    const schema = await ctrl.metaForm("CommentForm");
    expect(schema).toBeDefined();
    expect(typeof schema).toBe("object");
  });

  it("does not register { name, url } forms (served elsewhere)", async () => {
    @DbRowActions({
      ship: {
        label: "Ship",
        processor: "backend",
        value: "/api/shipping/ship",
        inputForm: { name: "ShipForm", url: "/api/shipping/meta/form/ShipForm" },
      },
    })
    class RemoteFormCtrl extends AsReadableController {
      protected hasField(): boolean {
        return true;
      }
    }
    const ctx = makeApp();
    const ctrl = new RemoteFormCtrl(makeBoundType(), "test", ctx.app);
    await expect(ctrl.metaForm("ShipForm")).rejects.toBeInstanceOf(HttpError);
  });
});
