import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  build,
  getFieldPathCompletionScope,
  getQueryCompletionScope,
  getQueryScope,
  resolveFieldRefAt,
} from "@atscript/core";
import type { AtscriptDoc, SemanticNode, Token } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it, beforeAll } from "vite-plus/test";

import dbPlugin from "../plugin";

// Editor scopes the db plugin declares on its annotation arguments (since
// 0.1.141): what the VSCode extension completes, hovers and jumps to inside
// `@db.view.filter` / `.joins` / `.having`, `@db.agg.*` conditions and field
// names, `@db.rel.filter`, and which types a ref argument offers. Every
// scope is the one the validators check — see plugin/lsp-scopes.ts.

const SOURCE = `
@db.table 'ls_orders'
export interface LsOrder {
    @meta.id
    id: number

    @db.rel.FK
    customerId?: LsCustomer.id

    amount: number
    status: string
    settings: {
        level: number
    }

    @db.rel.via LsOrderTag
    @db.rel.filter \`LsOrderTag.weight > 1 and label != ''\`
    tags: LsTag[]
}

@db.table 'ls_customers'
export interface LsCustomer {
    @meta.id
    id: number
    name: string
    regionId?: number
    parentId?: number

    @db.rel.from
    @db.rel.filter \`LsOrder.status = 'paid'\`
    orders: LsOrder[]
}

@db.table 'ls_regions'
export interface LsRegion {
    @meta.id
    id: number
    name: string
}

@db.table 'ls_tags'
export interface LsTag {
    @meta.id
    id: number
    label: string
}

@db.table 'ls_order_tags'
export interface LsOrderTag {
    @meta.id
    id: number

    @db.rel.FK
    orderId: LsOrder.id

    @db.rel.FK
    tagId: LsTag.id

    weight: number
}

@db.alias LsCustomer
export type LsParent = LsCustomer

export interface LsPlain {
    x: number
}

@db.view 'ls_order_details'
@db.view.for LsOrder
@db.view.joins LsCustomer, \`LsCustomer.id = LsOrder.customerId\`
@db.view.joins LsRegion, \`LsRegion.id = LsCustomer.regionId\`, 'left'
@db.view.joins LsParent, \`LsParent.id = LsCustomer.parentId\`, 'left'
@db.view.filter \`status = 'paid' and LsParent.name != ''\`
export interface LsOrderDetails {
    id: LsOrder.id
    customerName: LsCustomer.name
    regionName?: LsRegion.name
    parentName?: LsParent.name
}

@db.view 'ls_paid'
@db.view.for LsOrderDetails
@db.view.filter \`customerName != ''\`
export interface LsPaid {
    id: LsOrderDetails.id
    customerName: LsOrderDetails.customerName
}

@db.view 'ls_totals'
@db.view.for LsOrder
@db.view.joins LsCustomer, \`LsCustomer.id = LsOrder.customerId\`
@db.view.having \`total > 100\`
export interface LsTotals {
    status: LsOrder.status

    @db.agg.sum 'amount', \`LsCustomer.name != 'x' and amount > 0\`
    total: number

    @db.agg.max 'settings.level'
    maxLevel?: number

    @db.agg.max 'name'
    topCustomer?: LsCustomer.name
}
`;

let doc: AtscriptDoc;

beforeAll(async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "db-lsp-scopes-"));
  writeFileSync(join(rootDir, "lsp.as"), SOURCE);
  const repo = await build({
    rootDir,
    entries: ["lsp.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  doc = repo.getDoc(`file://${join(rootDir, "lsp.as")}`)!;
  expect(doc).toBeDefined();
});

/** The arguments of the `nth` annotation named `name` in the document. */
function argsOf(name: string, nth = 0): Token[] {
  const annotations = doc.annotations.filter((a) => a.name === name);
  expect(annotations.length, `@${name} #${nth}`).toBeGreaterThan(nth);
  return annotations[nth].args;
}

/** Position of `needle` (plus `shift` characters) in the document text. */
function posOf(needle: string, shift = 0) {
  const index = doc.text.indexOf(needle);
  expect(index, needle).toBeGreaterThanOrEqual(0);
  const before = doc.text.slice(0, index + shift);
  const line = before.split("\n").length - 1;
  return { line, character: before.length - before.lastIndexOf("\n") - 1 };
}

function tokenAt(needle: string, shift = 0): Token {
  const { line, character } = posOf(needle, shift);
  const token = doc.tokensIndex.at(line, character);
  expect(token, `token at ${needle}+${shift}`).toBeDefined();
  return token!;
}

function decl(name: string): SemanticNode {
  const owner = doc.getDeclarationOwnerNode(name);
  expect(owner?.node, name).toBeDefined();
  return owner!.node!;
}

function refFilterOf(annotation: string, index = 0) {
  const filter = doc.resolveAnnotation(annotation)?.arguments[index]?.refFilter;
  expect(typeof filter, `${annotation} refFilter`).toBe("function");
  return (name: string) => filter!(decl(name), doc);
}

describe("db plugin editor scopes", () => {
  it("the fixture compiles without diagnostics", () => {
    expect(doc.getDiagMessages().map((m) => m.message)).toEqual([]);
  });

  it("every db query argument declares its own scope — core's legacy @db.* rules are never used", () => {
    for (const name of [
      "db.view.filter",
      "db.view.joins",
      "db.view.having",
      "db.rel.filter",
      "db.agg.sum",
      "db.agg.count",
    ]) {
      const queryArgs = doc.resolveAnnotation(name)!.arguments.filter((a) => a.type === "query");
      expect(queryArgs.length, name).toBeGreaterThan(0);
      expect(
        queryArgs.every((a) => typeof a.fieldScope === "function"),
        name,
      ).toBe(true);
    }
  });

  describe("@db.view.filter", () => {
    it("scopes the entry table and every join, aliases included; unqualified fields belong to the entry", () => {
      const [filter] = argsOf("db.view.filter");
      expect(getQueryScope(filter, doc)).toEqual({
        allowedTypes: ["LsOrder", "LsCustomer", "LsRegion", "LsParent"],
        unqualifiedTarget: "LsOrder",
      });
      const completion = getQueryCompletionScope(filter, doc)!;
      expect(completion.typeNames).toEqual(["LsOrder", "LsCustomer", "LsRegion", "LsParent"]);
      // an alias completes the fields of the table it stands for
      expect(completion.getFields("LsParent").map((p) => p.id)).toEqual([
        "id",
        "name",
        "regionId",
        "parentId",
        "orders",
      ]);
    });

    it("resolves qualified and unqualified field refs to their props", () => {
      const viaAlias = resolveFieldRefAt(tokenAt("LsParent.name != ''", "LsParent.".length), doc);
      expect(viaAlias?.typeName).toBe("LsParent");
      expect(viaAlias?.prop.id).toBe("name");
      expect(viaAlias?.prop.ownerNode?.ownerNode?.id).toBe("LsCustomer");

      const unqualified = resolveFieldRefAt(tokenAt("status = 'paid' and"), doc);
      expect(unqualified?.typeName).toBe("LsOrder");
      expect(unqualified?.prop.id).toBe("status");
    });

    it("a view over a view scopes the upstream view and completes its fields", () => {
      const [filter] = argsOf("db.view.filter", 1);
      expect(getQueryScope(filter, doc)).toEqual({
        allowedTypes: ["LsOrderDetails"],
        unqualifiedTarget: "LsOrderDetails",
      });
      expect(
        getQueryCompletionScope(filter, doc)!
          .getFields("LsOrderDetails")
          .map((p) => p.id),
      ).toEqual(["id", "customerName", "regionName", "parentName"]);
      const ref = resolveFieldRefAt(tokenAt("customerName != ''"), doc);
      expect(ref?.prop.id).toBe("customerName");
      expect(ref?.prop.ownerNode?.ownerNode?.id).toBe("LsOrderDetails");
    });
  });

  describe("@db.view.joins", () => {
    it("scopes the target, the entry and the joins declared before it (chained joins)", () => {
      expect(getQueryScope(argsOf("db.view.joins", 0)[1], doc)).toEqual({
        allowedTypes: ["LsCustomer", "LsOrder"],
        unqualifiedTarget: "LsOrder",
      });
      expect(getQueryScope(argsOf("db.view.joins", 1)[1], doc)).toEqual({
        allowedTypes: ["LsRegion", "LsOrder", "LsCustomer"],
        unqualifiedTarget: "LsOrder",
      });
      expect(getQueryScope(argsOf("db.view.joins", 2)[1], doc)).toEqual({
        allowedTypes: ["LsParent", "LsOrder", "LsCustomer", "LsRegion"],
        unqualifiedTarget: "LsOrder",
      });
    });

    it("resolves an alias qualifier in a join condition", () => {
      const ref = resolveFieldRefAt(
        tokenAt("LsParent.id = LsCustomer.parentId", "LsParent.".length),
        doc,
      );
      expect(ref?.typeName).toBe("LsParent");
      expect(ref?.prop.id).toBe("id");
      const earlier = resolveFieldRefAt(
        tokenAt("LsParent.id = LsCustomer.parentId", "LsParent.id = LsCustomer.".length),
        doc,
      );
      expect(earlier?.typeName).toBe("LsCustomer");
      expect(earlier?.prop.id).toBe("parentId");
    });
  });

  describe("@db.view.having", () => {
    it("scopes the view's own fields, unqualified", () => {
      const [having] = argsOf("db.view.having");
      expect(getQueryScope(having, doc)).toEqual({
        allowedTypes: [],
        unqualifiedTarget: "LsTotals",
      });
      expect(
        getQueryCompletionScope(having, doc)!
          .getFields("LsTotals")
          .map((p) => p.id),
      ).toEqual(["status", "total", "maxLevel", "topCustomer"]);
      const ref = resolveFieldRefAt(tokenAt("total > 100"), doc);
      expect(ref?.typeName).toBe("LsTotals");
      expect(ref?.prop.id).toBe("total");
    });
  });

  describe("@db.agg.*", () => {
    it("a condition has the scope of the owner view's filter", () => {
      const [, condition] = argsOf("db.agg.sum");
      expect(getQueryScope(condition, doc)).toEqual({
        allowedTypes: ["LsOrder", "LsCustomer"],
        unqualifiedTarget: "LsOrder",
      });
      expect(resolveFieldRefAt(tokenAt("amount > 0"), doc)?.prop.id).toBe("amount");
      expect(
        resolveFieldRefAt(tokenAt("LsCustomer.name != 'x'", "LsCustomer.".length), doc)?.prop.id,
      ).toBe("name");
    });

    it("the field string is a field path of the entry table", () => {
      const [field] = argsOf("db.agg.sum");
      const scope = getFieldPathCompletionScope(field, doc, field.range.start.character + 2)!;
      expect(scope.typeName).toBe("LsOrder");
      expect(scope.chain).toEqual([]);
      expect(scope.fields.map((p) => p.id)).toContain("amount");
      expect(resolveFieldRefAt(field, doc)?.prop.id).toBe("amount");
    });

    it("a dotted field completes level by level and resolves its last segment", () => {
      const [field] = argsOf("db.agg.max");
      const afterDot = field.range.start.character + "'settings.".length + 1;
      const scope = getFieldPathCompletionScope(field, doc, afterDot)!;
      expect(scope.typeName).toBe("LsOrder");
      expect(scope.chain).toEqual(["settings"]);
      expect(scope.fields.map((p) => p.id)).toEqual(["level"]);
      expect(resolveFieldRefAt(field, doc)?.prop.id).toBe("level");
    });

    it("on a chain-ref field the field string is a path of the referenced type", () => {
      const [field] = argsOf("db.agg.max", 1);
      expect(
        getFieldPathCompletionScope(field, doc, field.range.start.character + 2)?.typeName,
      ).toBe("LsCustomer");
      expect(resolveFieldRefAt(field, doc)?.prop.id).toBe("name");
    });
  });

  describe("@db.rel.filter", () => {
    it("scopes the related type of a @db.rel.from", () => {
      const [filter] = argsOf("db.rel.filter", 1);
      expect(getQueryScope(filter, doc)).toEqual({
        allowedTypes: ["LsOrder"],
        unqualifiedTarget: "LsOrder",
      });
      expect(
        resolveFieldRefAt(tokenAt("LsOrder.status = 'paid'", "LsOrder.".length), doc)?.prop.id,
      ).toBe("status");
    });

    it("scopes the related type and the junction of a @db.rel.via", () => {
      const [filter] = argsOf("db.rel.filter", 0);
      expect(getQueryScope(filter, doc)).toEqual({
        allowedTypes: ["LsTag", "LsOrderTag"],
        unqualifiedTarget: "LsTag",
      });
      expect(
        resolveFieldRefAt(tokenAt("LsOrderTag.weight > 1", "LsOrderTag.".length), doc)?.prop.id,
      ).toBe("weight");
      expect(resolveFieldRefAt(tokenAt("label != ''"), doc)?.prop.id).toBe("label");
    });
  });

  describe("ref argument completion filters", () => {
    it("@db.view.for offers tables and views — not aliases or plain interfaces", () => {
      const accepts = refFilterOf("db.view.for");
      expect(accepts("LsOrder")).toBe(true);
      expect(accepts("LsOrderDetails")).toBe(true);
      expect(accepts("LsParent")).toBe(false);
      expect(accepts("LsPlain")).toBe(false);
    });

    it("@db.view.joins offers tables, views and aliases", () => {
      const accepts = refFilterOf("db.view.joins");
      expect(accepts("LsOrder")).toBe(true);
      expect(accepts("LsOrderDetails")).toBe(true);
      expect(accepts("LsParent")).toBe(true);
      expect(accepts("LsPlain")).toBe(false);
    });

    it("@db.alias offers tables and views — never another alias", () => {
      const accepts = refFilterOf("db.alias");
      expect(accepts("LsCustomer")).toBe(true);
      expect(accepts("LsOrderDetails")).toBe(true);
      expect(accepts("LsParent")).toBe(false);
    });

    it("@db.rel.via offers tables only", () => {
      const accepts = refFilterOf("db.rel.via");
      expect(accepts("LsOrderTag")).toBe(true);
      expect(accepts("LsOrderDetails")).toBe(false);
      expect(accepts("LsParent")).toBe(false);
    });
  });
});
