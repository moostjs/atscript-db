import { describe, it, expect, beforeAll } from "vite-plus/test";
import { createAdapter } from "@atscript/db-memory";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { AsDbController } from "../as-db.controller";
import { AsReadableController } from "../as-readable.controller";
import { discoverActions } from "../actions/discover";
import { fakeOverview, idMate, inputFormMate, makeApp } from "./actions-test-utils";
import { createMockApp } from "./test-utils";

/**
 * Annotations whose arguments are refs (a binding to another type, as
 * `@ui.valueHelp` is) reach `/meta` and `/meta/form/:name` with their target
 * serialized as `{ id, metadata }` — including `db.http.path` — and travel
 * through chain refs and `extends` (atscript 0.1.100 serializer + codegen).
 * The `vhx.bind` spec below stands in for the ui plugin's annotation.
 */

let VhDict: any;
let VhItem: any;
let VhItemView: any;
let VhForm: any;
let VhExtended: any;
let VhItemBoundView: any;

beforeAll(async () => {
  ({ VhDict } = await import("./fixtures-vh/vh-dict.as"));
  ({ VhItem, VhItemView, VhItemBoundView, VhForm, VhExtended } =
    await import("./fixtures-vh/vh-host.as"));
  VhDict.metadata.set("db.http.path", "/dict");
});

const bindingOf = (serializedType: any, prop: string) =>
  serializedType.type.props[prop].metadata["vhx.bind"];

describe("ref-valued annotations in /meta", () => {
  it("/meta carries the binding target with its db.http.path (other db.* stripped)", async () => {
    const table = createAdapter().getTable(VhItem);
    const meta = await new AsDbController(createMockApp(), table as any).meta();
    const binding = bindingOf(meta.type, "color");
    expect(binding.field).toBe("value");
    expect(binding.target.id).toBe("VhDict");
    expect(binding.target.metadata["db.http.path"]).toBe("/dict");
    expect(binding.target.metadata["db.table"]).toBeUndefined();
    expect(() => JSON.stringify(meta)).not.toThrow();
    expect(JSON.parse(JSON.stringify(bindingOf(meta.type, "color"))).target.id).toBe("VhDict");
  });

  it("a binding inherited through a view's chain ref arrives on the view field", async () => {
    const view = createAdapter().getView(VhItemView);
    const meta = await new AsDbController(createMockApp(), view as any).meta();
    expect(bindingOf(meta.type, "color").target.metadata["db.http.path"]).toBe("/dict");
  });

  it("a binding declared on a @db.view's own column reaches the view's /meta", async () => {
    const view = createAdapter().getView(VhItemBoundView);
    const meta = await new AsDbController(createMockApp(), view as any).meta();
    const binding = bindingOf(meta.type, "tint");
    expect(binding.field).toBe("value");
    expect(binding.target.id).toBe("VhDict");
    expect(binding.target.metadata["db.http.path"]).toBe("/dict");
    expect(binding.target.metadata["db.table"]).toBeUndefined();
    // the chain-ref column keeps its own type; the plain column carries no binding
    expect(bindingOf(meta.type, "id")).toBeUndefined();
    expect(() => JSON.stringify(meta)).not.toThrow();
  });

  it("/meta/form/:name carries the binding target the same way", async () => {
    class FormCtrl extends AsReadableController {
      protected hasField(): boolean {
        return true;
      }
    }
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(FormCtrl, [
        {
          method: "approve",
          httpMethod: "POST",
          path: "/x/actions/approve",
          action: { name: "approve", opts: { label: "Approve" } },
          paramMates: [idMate(), inputFormMate(VhForm)],
        },
      ]),
    ]);
    discoverActions(FormCtrl, ctx.app, ctx.logger);
    const bound = {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    } as unknown as TAtscriptAnnotatedType;
    const schema = await new FormCtrl(bound, "test", ctx.app).metaForm("VhForm");
    const binding = bindingOf(schema, "shade");
    expect(binding.field).toBe("value");
    expect(binding.target.id).toBe("VhDict");
    expect(binding.target.metadata["db.http.path"]).toBe("/dict");
    expect(binding.target.metadata["db.table"]).toBeUndefined();
    expect(() => JSON.stringify(schema)).not.toThrow();
  });

  it("is carried through extends", () => {
    // the inherited annotation's ref is bound in the extending file (no ReferenceError)
    const binding = VhExtended.type.props.get("shade").metadata.get("vhx.bind");
    expect(binding.target().id ?? binding.target().name).toBeDefined();
    expect(VhForm.type.props.get("shade").metadata.get("vhx.bind")).toBeDefined();
  });
});
