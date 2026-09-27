import { describe, it, expect, expectTypeOf, beforeAll } from "vite-plus/test";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { AsDbController } from "../as-db.controller";
import {
  DbActions,
  DbRowActions,
  DbRowsActions,
  DbTableActions,
} from "../actions/db-actions.decorator";
import type { TDbActionsEntry } from "../actions/types";
import { fakeOverview, idMate, inputFormMate, makeApp, makeTable } from "./actions-test-utils";
import { prepareFixtures } from "./test-utils";

describe("Class-level action decorators — @DbActions / @DbTableActions / @DbRowActions / @DbRowsActions", () => {
  it("@DbRowActions emits a navigate row entry with the supplied URL", async () => {
    @DbRowActions({
      edit: { label: "Edit", processor: "navigate", value: "/users/$1/edit" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([
      {
        name: "edit",
        label: "Edit",
        level: "row",
        processor: "navigate",
        value: "/users/$1/edit",
      },
    ]);
  });

  it("@DbTableActions emits a custom entry with value === <action key>", async () => {
    @DbTableActions({
      exportCsv: { label: "Export CSV", processor: "custom" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([
      {
        name: "exportCsv",
        label: "Export CSV",
        level: "table",
        processor: "custom",
        value: "exportCsv",
      },
    ]);
  });

  it("@DbRowActions emits a backend entry with the dict-supplied path verbatim (no handler validation)", async () => {
    @DbRowActions({
      block: { label: "Block", processor: "backend", value: "/admin/users/block" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    // Empty overview: meta builder must NOT validate that the path is bound.
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([
      {
        name: "block",
        label: "Block",
        level: "row",
        processor: "backend",
        value: "/admin/users/block",
      },
    ]);
  });

  it("rejects navigate entries with missing/null/empty value", async () => {
    @DbRowActions({
      a: { label: "A", processor: "navigate" } as never,
      b: { label: "B", processor: "navigate", value: null as unknown as string },
      c: { label: "C", processor: "navigate", value: "" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    // One warning per dropped entry.
    expect(ctx.logger.warn.mock.calls.length).toBe(3);
  });

  it("rejects backend entries with missing value", async () => {
    @DbTableActions({
      syncAll: { label: "Sync All", processor: "backend" } as never,
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('processor "backend"'));
  });

  it("rejects custom entries that supply value (forbidden)", async () => {
    @DbTableActions({
      exportCsv: {
        label: "Export CSV",
        processor: "custom",
        value: "should-not-be-here",
      } as never,
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('processor "custom" forbids'),
    );
  });

  it("@DbActions requires explicit level on each entry; entries lacking it are dropped", async () => {
    @DbActions({
      foo: { label: "Foo", processor: "navigate", value: "/foo" } as never,
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("requires a level"));
  });

  it("@DbRowsActions injects level: 'rows' into each entry", async () => {
    @DbRowsActions({
      lockMany: { label: "Lock", processor: "custom" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions[0].level).toBe("rows");
  });

  it("class-level backend row entry surfaces alongside method-decorator backend (positive coexistence)", async () => {
    @DbRowActions({
      block: { label: "Block", processor: "backend", value: "/admin/users/block" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "approve",
          httpMethod: "POST",
          path: "/c/approve",
          action: { name: "approve", opts: { label: "Approve" } },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    const names = meta.actions.map((a) => a.name).toSorted();
    expect(names).toEqual(["approve", "block"]);
  });
});

// since 0.1.136 — class-level entries can declare an input form.
describe("Class-level action entries — inputForm", () => {
  type FormType = TAtscriptAnnotatedType & { name: string };
  let CommentForm: FormType;

  beforeAll(async () => {
    await prepareFixtures();
    const mod = await import("./fixtures/input-form.as");
    CommentForm = mod.CommentForm as unknown as FormType;
  });

  it("a type inputForm emits inputForm: Type.name (no formUrl)", async () => {
    @DbRowActions({
      ship: {
        label: "Ship",
        processor: "backend",
        value: "/api/shipping/ship",
        inputForm: CommentForm,
      },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([
      {
        name: "ship",
        label: "Ship",
        level: "row",
        processor: "backend",
        value: "/api/shipping/ship",
        inputForm: "CommentForm",
      },
    ]);
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });

  it("an { name, url } inputForm emits inputForm + formUrl verbatim", async () => {
    @DbTableActions({
      importRows: {
        label: "Import",
        processor: "custom",
        inputForm: { name: "ImportForm", url: "/api/imports/meta/form/ImportForm" },
      },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([
      {
        name: "importRows",
        label: "Import",
        level: "table",
        processor: "custom",
        value: "importRows",
        inputForm: "ImportForm",
        formUrl: "/api/imports/meta/form/ImportForm",
      },
    ]);
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });

  it("inputForm is a compiled type or { name, url } — other shapes are type errors", () => {
    type Backend = Extract<TDbActionsEntry, { processor: "backend" }>;
    type Navigate = Extract<TDbActionsEntry, { processor: "navigate" }>;
    type Form = NonNullable<Backend["inputForm"]>;
    expectTypeOf<{ name: string; url: string }>().toMatchTypeOf<Form>();
    expectTypeOf<string>().not.toMatchTypeOf<Form>();
    expectTypeOf<{ name: string }>().not.toMatchTypeOf<Form>();
    expectTypeOf<"formUrl" extends keyof Backend ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<Navigate["inputForm"]>().toEqualTypeOf<undefined>();
  });

  it("drops invalid shapes (JS callers) and navigate forms with one warning each", async () => {
    const remote = { name: "CForm", url: "/api/x/meta/form/CForm" };
    @DbRowActions({
      navigate: {
        label: "A",
        processor: "navigate",
        value: "/a/$1",
        inputForm: remote,
      } as never,
      nameString: { label: "B", processor: "backend", value: "/b", inputForm: "BForm" as never },
      noUrl: { label: "C", processor: "backend", value: "/c", inputForm: { name: "C" } as never },
      emptyUrl: {
        label: "D",
        processor: "backend",
        value: "/d",
        inputForm: { name: "D", url: "" },
      },
      emptyName: {
        label: "E",
        processor: "backend",
        value: "/e",
        inputForm: { name: "", url: "/e" },
      },
      nullForm: { label: "F", processor: "backend", value: "/f", inputForm: null as never },
      ok: { label: "OK", processor: "backend", value: "/ok" },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions.map((a) => a.name)).toEqual(["ok"]);
    const warnings = ctx.logger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnings).toHaveLength(6);
    expect(warnings[0]).toContain('processor "navigate" cannot take an `inputForm`');
    for (const w of warnings.slice(1)) {
      expect(w).toContain("compiled .as interface or `{ name, url }`");
    }
  });

  it("drops a class-level type whose name clashes with a different method-level form", async () => {
    // Same wire name as the method-level `@InputForm(CommentForm)`, different type.
    const Imposter = {
      ...CommentForm,
      __is_atscript_annotated_type: true,
      name: "CommentForm",
    } as unknown as FormType;
    @DbRowActions({
      other: { label: "Other", processor: "backend", value: "/o", inputForm: Imposter },
    })
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "approve",
          httpMethod: "POST",
          path: "/c/approve",
          action: { name: "approve", opts: { label: "Approve" } },
          paramMates: [idMate(), inputFormMate(CommentForm)],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions.map((a) => a.name)).toEqual(["approve"]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('form name "CommentForm" already registered'),
    );
  });
});
