import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import type { TMetaResponse } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import type { TDbDecorateContext } from "../as-db-readable.controller";
import { AsJsonValueHelpController } from "../as-json-value-help.controller";
import { DbDecorations } from "../decorations/db-decorations.decorator";
import { createMockApp, prepareFixtures } from "./test-utils";

/**
 * `@DbDecorations` (since 0.1.148): declared display-only fields — `/meta`
 * (`fields[key].decoration`, `decorations`), the request gate (selectable,
 * never filtered / sorted / grouped), the projection split / widen / strip
 * around `decorateRows`, and visibility that follows the declared sources.
 */

let DecoTicket: any;
let DecoTicketDecorations: any;
let DecoColliding: any;

const TICKETS = [
  { id: 1, title: "one", ownerId: 10, status: "open", secret: "s1" },
  { id: 2, title: "two", ownerId: 11, status: "open", secret: "s2" },
];

interface TOpts {
  /** `hasField` hides these paths. */
  hide?: string[];
  /** `transformProjection` removes these paths from an inclusion list. */
  strip?: string[];
  /** The `requires` map (default: ownerName ← ownerId). */
  requires?: Record<string, string[]>;
  /** Extra `$`-key the hook sets. */
  badge?: boolean;
  /** Overlay: delete `decorations.type.props[key]`. */
  overlayDrop?: string;
  noHook?: boolean;
}

async function bind(opts: TOpts = {}) {
  const space = createAdapter();
  const table = space.getTable(DecoTicket);
  await table.insertMany(structuredClone(TICKETS) as never);
  const calls: Array<{ rows: Record<string, unknown>[]; ctx: TDbDecorateContext }> = [];

  @DbDecorations(DecoTicketDecorations, {
    requires: opts.requires ?? { ownerName: ["ownerId"] },
  })
  class Ctrl extends AsDbController {
    protected override hasField(path: string): boolean {
      return !(opts.hide ?? []).includes(path) && super.hasField(path);
    }

    protected override transformProjection(projection?: any): any {
      if (!opts.strip || projection === undefined) return projection;
      if (Array.isArray(projection))
        return projection.filter((p: string) => !opts.strip!.includes(p));
      return Object.fromEntries(
        Object.entries(projection).filter(([p]) => !opts.strip!.includes(p)),
      );
    }

    protected override applyMetaOverlay(meta: TMetaResponse): TMetaResponse {
      const drop = opts.overlayDrop;
      if (!drop || !meta.decorations) return meta;
      const { [drop]: _gone, ...props } = (meta.decorations.type as any).props;
      return {
        ...meta,
        decorations: { ...meta.decorations, type: { ...meta.decorations.type, props } as never },
      };
    }
  }
  if (!opts.noHook) {
    (Ctrl.prototype as any).decorateRows = function (
      rows: Record<string, unknown>[],
      ctx: TDbDecorateContext,
    ) {
      calls.push({ rows: rows.map((r) => ({ ...r })), ctx });
      for (const row of rows) {
        if (ctx.decorations.has("unreadCount")) row.unreadCount = Number(row.id) * 10;
        if (ctx.decorations.has("ownerName")) row.ownerName = `owner-${String(row.ownerId)}`;
        if (opts.badge) row.$badge = "b";
        // a declared key outside ctx.decorations: must be stripped afterwards
        row.ownerName ??= undefined;
        if (!ctx.decorations.has("ownerName")) row.ownerName = "leak";
      }
    };
  }
  const app = createMockApp();
  const controller = new Ctrl(app, table as any);
  const findMany = vi.spyOn(table, "findMany");
  const selects = () =>
    findMany.mock.calls.map(
      (c) => (c[0] as { controls?: { $select?: unknown } }).controls?.$select,
    );
  return { controller, table, calls, findMany, selects, app };
}

/** A hand-built object interface (for key shapes atscript cannot declare). */
function synthetic(keys: string[], metadata: Record<string, unknown> = {}): any {
  const field = () => ({
    __is_atscript_annotated_type: true,
    type: { kind: "", designType: "string", tags: new Set() },
    metadata: new Map(),
  });
  return {
    __is_atscript_annotated_type: true,
    type: {
      kind: "object",
      props: new Map(keys.map((k) => [k, field()])),
      propsPatterns: [],
      tags: new Set(),
    },
    metadata: new Map(Object.entries(metadata)),
  };
}

const row = (rows: unknown, i = 0) => (rows as Array<Record<string, unknown>>)[i];
const bad = (res: unknown): HttpError => {
  expect(res).toBeInstanceOf(HttpError);
  return res as HttpError;
};
const messageOf = (res: unknown): string =>
  ((bad(res).body as any).errors?.[0]?.message ?? (bad(res).body as any).message) as string;

beforeAll(async () => {
  await prepareFixtures();
  ({ DecoTicket, DecoTicketDecorations, DecoColliding } =
    await import("./fixtures/decorations.as"));
});

describe("@DbDecorations — boot validation", () => {
  const construct = async (decorations: any, requires: Record<string, string[]> = {}) => {
    const table = createAdapter().getTable(DecoTicket);
    @DbDecorations(decorations, { requires } as never)
    class Ctrl extends AsDbController {}
    return () => new Ctrl(createMockApp(), table as any);
  };

  it("a key that is a field of the readable", async () => {
    expect(await construct(DecoColliding)).toThrow(/\[moost-db\].*"title" collides/);
  });

  it("keys must be plain top-level identifiers", async () => {
    expect(await construct(synthetic(["$unread"]))).toThrow(/"\$unread" must be a plain/);
    expect(await construct(synthetic(["a.b"]))).toThrow(/"a\.b" must be a plain/);
  });

  it("an interface that is a table or a view is refused", async () => {
    expect(await construct(DecoTicket)).toThrow(/must not carry @db.table/);
  });

  it("`requires` must name declared keys and own, readable fields", async () => {
    expect(await construct(DecoTicketDecorations, { nope: ["ownerId"] })).toThrow(
      /not a declared decoration/,
    );
    expect(await construct(DecoTicketDecorations, { ownerName: ["missing"] })).toThrow(
      /not an own field/,
    );
    expect(await construct(DecoTicketDecorations, { ownerName: ["secret"] })).toThrow(
      /@db.writeOnly/,
    );
  });

  it("is refused on a value-help controller", () => {
    expect(() => {
      @DbDecorations(DecoTicketDecorations)
      class VH extends AsJsonValueHelpController<any, any> {}
      return VH;
    }).toThrow(/value-help controller/);
  });

  it("warns once when decorateRows is not implemented", async () => {
    const { app } = await bind({ noHook: true });
    const logger = app.getLogger.mock.results[0].value;
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toMatch(/does not implement decorateRows/);
  });
});

describe("@DbDecorations — /meta", () => {
  it("lists each decoration in fields and its type in `decorations`, not in `type`", async () => {
    const { controller } = await bind();
    const meta = (await controller.meta()) as TMetaResponse;
    expect(meta.fields.unreadCount).toEqual({
      sortable: false,
      filterable: false,
      decoration: true,
    });
    expect(meta.fields.ownerName).toEqual({ sortable: false, filterable: false, decoration: true });
    const props = (meta.decorations!.type as any).props;
    expect(Object.keys(props)).toEqual(["unreadCount", "ownerName"]);
    expect(props.unreadCount.metadata["meta.label"]).toBe("Unread");
    expect(Object.keys((meta.type.type as any).props)).not.toContain("unreadCount");
  });

  it("a decoration whose source is hidden is left out of fields and decorations", async () => {
    const { controller } = await bind({ hide: ["ownerId"] });
    const meta = (await controller.meta()) as TMetaResponse;
    expect(meta.fields.ownerName).toBeUndefined();
    expect(meta.fields.unreadCount?.decoration).toBe(true);
    expect(Object.keys((meta.decorations!.type as any).props)).toEqual(["unreadCount"]);
  });

  it("no decoration left → no `decorations`", async () => {
    const { controller } = await bind({
      requires: { unreadCount: ["ownerId"], ownerName: ["ownerId"] },
      hide: ["ownerId"],
    });
    const meta = (await controller.meta()) as TMetaResponse;
    expect(meta.decorations).toBeUndefined();
  });

  it("an overlay may hide one by deleting its prop; overlays never see the fields entries", async () => {
    const { controller } = await bind({ overlayDrop: "unreadCount" });
    const meta = (await controller.meta()) as TMetaResponse;
    expect(meta.fields.unreadCount).toBeUndefined();
    expect(meta.fields.ownerName?.decoration).toBe(true);
  });

  it("without @DbDecorations the envelope has no `decorations`", async () => {
    const table = createAdapter().getTable(DecoTicket);
    class Plain extends AsDbController {}
    const meta = (await new Plain(createMockApp(), table as any).meta()) as TMetaResponse;
    expect(meta.decorations).toBeUndefined();
  });
});

describe("@DbDecorations — reads", () => {
  it("$select naming only a decoration reads its requires + the preferred id; no requires-only column leaks", async () => {
    const { controller, selects } = await bind();
    const rows = await controller.query("?$select=ownerName");
    expect(selects().at(-1)).toEqual(expect.arrayContaining(["ownerId", "id"]));
    expect(Object.keys(row(rows))).toEqual(expect.arrayContaining(["id", "ownerName"]));
    expect(row(rows).ownerId).toBeUndefined();
    expect(row(rows).ownerName).toBe("owner-10");
    // a decoration with no sources: the preferred id alone
    const plain = await controller.query("?$select=unreadCount");
    expect(selects().at(-1)).toEqual(["id"]);
    expect(row(plain)).toEqual({ id: 1, unreadCount: 10 });
  });

  it("a source the client selected stays in the row", async () => {
    const { controller } = await bind();
    const rows = await controller.query("?$select=ownerName,ownerId");
    expect(row(rows).ownerId).toBe(10);
    expect(row(rows).ownerName).toBe("owner-10");
  });

  it("no $select: every declared decoration is served", async () => {
    const { controller, calls } = await bind();
    const rows = await controller.query("?$sort=id");
    expect(row(rows)).toMatchObject({ id: 1, ownerId: 10, unreadCount: 10, ownerName: "owner-10" });
    expect([...calls[0].ctx.decorations]).toEqual(["unreadCount", "ownerName"]);
  });

  it("no $select: a decoration whose source is hidden is dropped silently", async () => {
    const { controller, calls } = await bind({ hide: ["ownerId"] });
    const rows = await controller.query("?$sort=id");
    expect(row(rows).unreadCount).toBe(10);
    expect(row(rows).ownerName).toBeUndefined();
    expect([...calls[0].ctx.decorations]).toEqual(["unreadCount"]);
  });

  it("an exclusion $select: the excluded decoration goes, the others are served", async () => {
    const { controller, calls } = await bind();
    const rows = await controller.query("?$select=-unreadCount");
    expect(row(rows).unreadCount).toBeUndefined();
    expect(row(rows).ownerName).toBe("owner-10");
    expect([...calls[0].ctx.decorations]).toEqual(["ownerName"]);
  });

  it("an excluded source is still read for the hook and stripped from the row", async () => {
    const { controller } = await bind();
    const rows = await controller.query("?$select=-ownerId");
    expect(row(rows).ownerName).toBe("owner-10");
    expect(row(rows).ownerId).toBeUndefined();
  });

  it("transformProjection stripping a source silently drops the decoration", async () => {
    const { controller, calls } = await bind({ strip: ["ownerId"] });
    const rows = await controller.query("?$select=title,ownerName,unreadCount");
    expect(row(rows).ownerName).toBeUndefined();
    expect(row(rows).unreadCount).toBe(10);
    expect([...calls[0].ctx.decorations]).toEqual(["unreadCount"]);
  });

  it("ctx.decorations holds only the requested keys; the rest is stripped after the hook", async () => {
    const { controller, calls } = await bind();
    const rows = await controller.query("?$select=title,unreadCount");
    expect([...calls[0].ctx.decorations]).toEqual(["unreadCount"]);
    // the hook wrote `ownerName: "leak"` for a key outside ctx.decorations
    expect(row(rows)).toEqual({ id: 1, title: "one", unreadCount: 10 });
  });

  it("undeclared $-keys keep working", async () => {
    const { controller } = await bind({ badge: true });
    const rows = await controller.query("?$select=unreadCount");
    expect(row(rows).$badge).toBe("b");
  });

  it("/pages, /one and $count", async () => {
    const { controller } = await bind();
    const page = (await controller.pages("?$select=ownerName&$page=1&$size=5")) as any;
    expect(page.data[0]).toMatchObject({ ownerName: "owner-10" });
    expect(page.data[0].ownerId).toBeUndefined();
    const one = (await controller.getOne("2", "?$select=ownerName")) as any;
    expect(one).toMatchObject({ id: 2, ownerName: "owner-11" });
    expect(one.ownerId).toBeUndefined();
    expect(await controller.query("?$select=unreadCount&$count=true")).toBe(2);
  });
});

describe("@DbDecorations — the request gate", () => {
  it("a decoration in a filter, $sort, $groupBy is a 400 display-only", async () => {
    const { controller } = await bind();
    for (const url of [
      "?unreadCount=1",
      "?$sort=unreadCount",
      "?$groupBy=unreadCount&$select=unreadCount",
    ]) {
      const err = bad(await controller.query(url));
      expect(err.body.statusCode, url).toBe(400);
      expect(messageOf(err), url).toMatch(/Field "unreadCount" is display-only/);
    }
  });

  it("$exists, $having, aggregates, buckets and a grouped $select are refused too", async () => {
    const { controller } = await bind();
    const gate = (parsed: object) =>
      (controller as any).checkCapabilities(parsed) as HttpError | undefined;
    for (const parsed of [
      { filter: { unreadCount: { $exists: true } } },
      { controls: { $groupBy: ["title"], $having: { unreadCount: { $gt: 1 } } } },
      { controls: { $groupBy: ["title"], $select: [{ $fn: "sum", $field: "unreadCount" }] } },
      { controls: { $groupBy: ["title"], $select: ["unreadCount"] } },
    ]) {
      expect(messageOf(gate(parsed)), JSON.stringify(parsed)).toMatch(/display-only/);
    }
  });

  it("an aggregate $select without $groupBy refuses a decoration (the core's aggregate mode)", async () => {
    const { controller } = await bind();
    const gate = (parsed: object) =>
      (controller as any).checkCapabilities(parsed) as HttpError | undefined;
    for (const parsed of [
      { controls: { $select: ["unreadCount", { $fn: "count", $field: "*" }] } },
      { controls: { $select: ["ownerName", { $fn: "sum", $field: "id" }] } },
    ]) {
      expect(messageOf(gate(parsed)), JSON.stringify(parsed)).toMatch(
        /is display-only and cannot be used in a grouped \$select/,
      );
    }
    // a plain (non-aggregate) $select still accepts it
    expect(gate({ controls: { $select: ["unreadCount"] } })).toBeUndefined();
  });

  it("a hidden source answers like an unknown field everywhere", async () => {
    const { controller } = await bind({ hide: ["ownerId"] });
    for (const url of [
      "?$select=ownerName",
      "?ownerName=x",
      "?$sort=ownerName",
      "?$select=-ownerName",
    ]) {
      expect(messageOf(await controller.query(url)), url).toBe('Unknown field "ownerName"');
    }
  });

  it("a dotted path under a decoration key is unknown", async () => {
    const { controller } = await bind();
    expect(messageOf(await controller.query("?$select=unreadCount.x"))).toMatch(/Unknown field/);
  });
});

describe("@DbDecorations — nested sources through the controller", () => {
  const NESTED = [
    {
      id: 1,
      title: "one",
      secret: { hash: "h1", salt: "s1" },
      contact: { phone: "p1", email: "e1" },
      items: [
        { sku: "a", qty: 1 },
        { sku: "b", qty: 2 },
      ],
    },
  ];

  async function nested(requires: Record<string, string[]>) {
    const { DecoNested, DecoNestedDecorations } = await import("./fixtures/decorations-nested.as");
    const table = createAdapter().getTable(DecoNested);
    await table.insertMany(structuredClone(NESTED) as never);
    const hookSaw: Array<Record<string, unknown>> = [];

    @DbDecorations(DecoNestedDecorations, { requires } as never)
    class Ctrl extends AsDbController {}
    (Ctrl.prototype as any).decorateRows = function (
      rows: Record<string, unknown>[],
      ctx: TDbDecorateContext,
    ) {
      for (const row of rows) {
        hookSaw.push(structuredClone(row));
        if (ctx.decorations.has("digest")) row.digest = "d";
      }
    };
    return { controller: new Ctrl(createMockApp(), table as any), hookSaw };
  }

  it("NEW-4: excluding a descendant of a required path still serves the decoration (hook reads it fully, then only the excluded descendant is stripped)", async () => {
    const { controller, hookSaw } = await nested({ digest: ["secret"] });
    const rows = await controller.query("?$select=-secret.hash");
    expect(row(rows).digest).toBe("d");
    // the hook saw the whole required path
    expect(hookSaw[0].secret).toEqual({ hash: "h1", salt: "s1" });
    // the client's exclusion still applies to the response
    expect(row(rows).secret).toEqual({ salt: "s1" });
    expect(row(rows).title).toBe("one");
  });

  it("NEW-5: arrays of objects are pruned to the client-selected items[].field", async () => {
    const { controller, hookSaw } = await nested({ digest: ["items"] });
    const rows = await controller.query("?$select=items.sku,digest");
    expect(row(rows).digest).toBe("d");
    expect(hookSaw[0].items).toEqual([
      { sku: "a", qty: 1 },
      { sku: "b", qty: 2 },
    ]);
    expect(row(rows).items).toEqual([{ sku: "a" }, { sku: "b" }]);
  });

  it("NEW-5: a hook-only array source is removed from the response", async () => {
    const { controller } = await nested({ digest: ["items.qty"] });
    const rows = await controller.query("?$select=title,digest");
    expect(row(rows).digest).toBe("d");
    expect(Object.keys(row(rows)).toSorted()).toEqual(["digest", "id", "title"]);
  });

  it("NEW-6: a hook-only nested path leaves no empty parent behind", async () => {
    const { controller } = await nested({ digest: ["contact.phone"] });
    const rows = await controller.query("?$select=title,digest");
    expect(row(rows).digest).toBe("d");
    expect(row(rows).contact).toBeUndefined();
    expect("contact" in row(rows)).toBe(false);
    // a sibling the client selected itself keeps the parent, minus the hook-only path
    const both = await controller.query("?$select=title,contact.email,digest");
    expect(row(both).contact).toEqual({ email: "e1" });
  });
});
