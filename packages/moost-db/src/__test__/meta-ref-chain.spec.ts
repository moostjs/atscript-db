import { describe, it, expect, beforeAll } from "vite-plus/test";
import {
  deserializeAnnotatedType,
  serializeAnnotatedType,
  type TAtscriptAnnotatedType,
} from "@atscript/typescript/utils";

import { AsDbReadableController } from "../as-db-readable.controller";
import { AsReadableController } from "../as-readable.controller";
import { resolveTerminalRef } from "../meta/terminal-ref";
import {
  fakeOverview,
  idMate,
  inputFormMate,
  makeApp as makeActionApp,
} from "./actions-test-utils";
import { createMockReadable, prepareFixtures } from "./test-utils";

/**
 * Finding 60 (since 0.1.128): `/meta` and `/meta/form/:name` re-point every
 * reference chain to its TERMINAL field and inherit `db.rel.FK` through the
 * chain, at the unchanged `refDepth: 0.5`, so value-help pickers on view
 * fields (and form fields) declared through a chain target the dictionary.
 */

function makeReadable(type: any) {
  return createMockReadable({ tableName: "t", type, fieldDescriptors: [] }, { fields: [] });
}

const makeApp = () => makeActionApp().app;

class ExposedController extends AsDbReadableController {
  public serialize() {
    return this.getSerializedType();
  }
  public options() {
    return this.getSerializeOptions();
  }
}

let Dict: any;
let Issue: any;
let IssueView: any;
let Deep: any;
let Plain: any;
let Self: any;
let RefForm: any;
let VersionedDoc: any;

const serializedOf = (type: any) =>
  new ExposedController(makeApp(), makeReadable(type)).serialize() as any;

beforeAll(async () => {
  await prepareFixtures();
  ({ Dict, Issue, IssueView, Deep, Plain, Self, RefForm, VersionedDoc } =
    await import("./fixtures/meta-ref-chain.as"));
  // Simulate the dictionary controller having stamped its public path.
  Dict.metadata.set("db.http.path", "/dicts");
});

describe("resolveTerminalRef", () => {
  it("walks the chain to the terminal prop and reports FK inheritance", () => {
    const viewCode = (IssueView.type.props as Map<string, TAtscriptAnnotatedType>).get("code")!;
    const t = resolveTerminalRef(viewCode)!;
    expect(t.type).toBe(Dict);
    expect(t.field).toBe("code");
    expect(t.fk).toBe(true);
    const deepX = (Deep.type.props as Map<string, TAtscriptAnnotatedType>).get("x")!;
    expect(resolveTerminalRef(deepX)).toMatchObject({ type: Dict, field: "code", fk: true });
    const plainNote = (Plain.type.props as Map<string, TAtscriptAnnotatedType>).get("note")!;
    expect(resolveTerminalRef(plainNote)).toMatchObject({ type: Issue, field: "title", fk: false });
    const selfParent = (Self.type.props as Map<string, TAtscriptAnnotatedType>).get("parentId")!;
    expect(resolveTerminalRef(selfParent)).toMatchObject({ type: Self, field: "id", fk: true });
  });
});

describe("/meta — terminal refs", () => {
  it("view field one hop from the FK: ref re-pointed to Dict.code, shallow, FK marker inherited", () => {
    const s = serializedOf(IssueView);
    const code = s.type.props.code;
    expect(code.ref.field).toBe("code");
    expect(code.ref.type.id).toBe("Dict");
    expect(code.ref.type.props).toBeUndefined();
    expect(code.ref.type.metadata["db.http.path"]).toBe("/dicts");
    expect(code.metadata["db.rel.FK"]).toBe(true);
    // A view field referencing a plain column / the PK keeps its direct hop and gains no marker.
    expect(s.type.props.title.ref).toMatchObject({ field: "title", type: { id: "Issue" } });
    expect(s.type.props.title.metadata["db.rel.FK"]).toBeUndefined();
    expect(s.type.props.id.ref).toMatchObject({ field: "id", type: { id: "Issue" } });
  });

  it("three-hop chain resolves to the dictionary", () => {
    const x = serializedOf(Deep).type.props.x;
    expect(x.ref).toMatchObject({ field: "code", type: { id: "Dict" } });
    expect(x.ref.type.props).toBeUndefined();
    expect(x.metadata["db.rel.FK"]).toBe(true);
  });

  it("a chain that never passes an FK is re-pointed but not marked", () => {
    const note = serializedOf(Plain).type.props.note;
    expect(note.ref).toMatchObject({ field: "title", type: { id: "Issue" } });
    expect(note.metadata["db.rel.FK"]).toBeUndefined();
  });

  it("direct FKs and self references serialize byte-identically to plain serializeAnnotatedType", () => {
    const ctrl = new ExposedController(makeApp(), makeReadable(Issue));
    expect(JSON.stringify(ctrl.serialize())).toBe(
      JSON.stringify(serializeAnnotatedType(Issue, ctrl.options())),
    );
    const selfCtrl = new ExposedController(makeApp(), makeReadable(Self));
    expect(JSON.stringify(selfCtrl.serialize())).toBe(
      JSON.stringify(serializeAnnotatedType(Self, selfCtrl.options())),
    );
    expect(ctrl.options().refDepth).toBe(0.5);
  });

  it("round-trips through deserializeAnnotatedType: the picker sees Dict's db.http.path and field code", () => {
    const runtime = deserializeAnnotatedType(serializedOf(IssueView));
    const code = (runtime.type as any).props.get("code") as TAtscriptAnnotatedType;
    expect(code.metadata.has("db.rel.FK")).toBe(true);
    expect(code.ref!.field).toBe("code");
    expect(code.ref!.type().metadata.get("db.http.path")).toBe("/dicts");
  });

  it("the runtime type is never mutated", () => {
    serializedOf(IssueView);
    const viewCode = (IssueView.type.props as Map<string, TAtscriptAnnotatedType>).get("code")!;
    expect(viewCode.metadata.has("db.rel.FK")).toBe(false);
    expect(viewCode.ref!.type()).toBe(Issue);
  });
});

describe("/meta — annotation allow-list", () => {
  it("keeps db.column.version (db-client skips the server-managed version on insert) and still strips other db.* keys", () => {
    const s = serializedOf(VersionedDoc);
    expect(s.type.props.version.metadata["db.column.version"]).toBe(true);
    expect(s.type.props.slug.metadata["db.column"]).toBeUndefined();
    expect(s.type.props.slug.metadata["db.index.plain"]).toBeUndefined();
    expect(s.metadata["db.table"]).toBeUndefined();
    expect(s.type.props.id.metadata["meta.id"]).toBe(true);
  });
});

describe("/meta/form/:name — terminal refs", () => {
  it("a form field declared through the chain gets the terminal ref and the FK marker", async () => {
    class FormCtrl extends AsReadableController {
      protected hasField(): boolean {
        return true;
      }
    }
    const ctx = makeActionApp();
    ctx.setOverview([
      fakeOverview(FormCtrl, [
        {
          method: "assign",
          httpMethod: "POST",
          path: "/x/actions/assign",
          action: { name: "assign", opts: { label: "Assign" } },
          paramMates: [idMate(), inputFormMate(RefForm)],
        },
      ]),
    ]);
    const ctrl = new FormCtrl(Issue, "issues", ctx.app);
    const schema = (await ctrl.metaForm("RefForm")) as any;
    expect(schema.type.props.code.ref).toMatchObject({ field: "code", type: { id: "Dict" } });
    expect(schema.type.props.code.ref.type.metadata["db.http.path"]).toBe("/dicts");
    expect(schema.type.props.code.metadata["db.rel.FK"]).toBe(true);
    expect(schema.type.props.note.ref).toBeUndefined();
    // Cached per form name.
    expect(await ctrl.metaForm("RefForm")).toBe(schema);
  });
});
