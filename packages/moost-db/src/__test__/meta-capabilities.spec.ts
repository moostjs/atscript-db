import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import type { TDbFieldMeta } from "@atscript/db";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, errorsOf, prepareFixtures } from "./test-utils";

/**
 * Invariant I-0 (finding 13 / 62, since 0.1.128): for every path listed in
 * `/meta.fields`, `sortable ⇔ $sort accepted` and `filterable ⇔ filter
 * accepted`; paths NOT listed are never accepted for filter / sort / groupBy.
 * Asserted property-style over real compiled metadata on both adapter
 * families (relational-style MockAdapter, nested-object subclass).
 */

const KEYS = { k1: randomBytes(32) };

class NestedMockAdapter extends MockAdapter {
  override supportsNestedObjects(): boolean {
    return true;
  }
  override canFilterField(fd: TDbFieldMeta): boolean {
    return !fd.encrypted;
  }
}

let CapRow: any;
let CapTarget: any;
let CapManual: any;

function bind(family: "sql" | "nested", type: any) {
  const db = new DbSpace(() => (family === "sql" ? new MockAdapter() : new NestedMockAdapter()), {
    encryption: { defaultKeyId: "k1", keys: KEYS },
  });
  db.getTable(CapTarget);
  const table = db.getTable(type);
  return { table, controller: new AsDbController(makeApp(), table as any) };
}

/** `true` when the request is accepted by BOTH the HTTP gate and the core guard. */
async function accepted(run: () => Promise<unknown>): Promise<boolean> {
  try {
    const result = await run();
    return !(result instanceof HttpError);
  } catch {
    return false;
  }
}

beforeAll(async () => {
  await prepareFixtures();
  ({ CapRow, CapTarget, CapManual } = await import("./fixtures/capabilities.as"));
});

describe.each(["sql", "nested"] as const)(
  "/meta ⇔ runtime parity (%s adapter family)",
  (family) => {
    it("every listed field: sortable ⇔ $sort accepted, filterable ⇔ filter accepted", async () => {
      const { controller } = bind(family, CapRow);
      const meta = await controller.meta();
      expect(Object.keys(meta.fields).length).toBeGreaterThan(5);
      for (const [path, f] of Object.entries(meta.fields)) {
        const sortOk = await accepted(() => controller.query(`?$sort=${path}`));
        expect(sortOk, `sortable parity for "${path}"`).toBe(f.sortable);
        const filterOk = await accepted(() => controller.query(`?${path}=1`));
        expect(filterOk, `filterable parity for "${path}"`).toBe(f.filterable);
      }
    });

    it("every listed field: $exists accepted ⇔ filterable ∨ filterOps ∋ $exists (both polarities)", async () => {
      const { controller } = bind(family, CapRow);
      const meta = await controller.meta();
      for (const [path, f] of Object.entries(meta.fields)) {
        const expected = f.filterable || (f.filterOps ?? []).includes("$exists");
        if (f.filterable)
          expect(f.filterOps, `filterOps only when !filterable ("${path}")`).toBe(undefined);
        for (const url of [`?$exists=${path}`, `?$!exists=${path}`]) {
          expect(await accepted(() => controller.query(url)), url).toBe(expected);
        }
      }
    });

    it("every type path NOT listed is rejected for filter, $sort and $groupBy", async () => {
      const { table, controller } = bind(family, CapRow);
      const meta = await controller.meta();
      const unlisted = [...table.flatMap.keys()].filter((p) => p && !(p in meta.fields));
      expect(unlisted).toEqual(expect.arrayContaining(["contact", "target", "target.name"]));
      for (const path of unlisted) {
        expect(await accepted(() => controller.query(`?${path}=1`)), `filter "${path}"`).toBe(
          false,
        );
        expect(
          await accepted(() => controller.query(`?$exists=${path}`)),
          `$exists "${path}"`,
        ).toBe(false);
        expect(await accepted(() => controller.query(`?$sort=${path}`)), `$sort "${path}"`).toBe(
          false,
        );
        expect(
          await accepted(() => controller.query(`?$groupBy=${path}&$select=${path},count()`)),
          `$groupBy "${path}"`,
        ).toBe(false);
      }
    });

    it("navigation paths are never listed and never accepted; the 400 carries the $with hint", async () => {
      const { controller } = bind(family, CapRow);
      const meta = await controller.meta();
      expect(meta.fields.target).toBeUndefined();
      expect(meta.fields["target.name"]).toBeUndefined();
      expect(meta.fields["target.id"]).toBeUndefined();
      const res = await controller.query("?$select=target.name");
      expect(res).toBeInstanceOf(HttpError);
      expect((res as HttpError).message).toContain("$with=target");
      expect(errorsOf(res)[0].path).toBe("target.name");
    });

    it("flags: indexed (PK + explicit index only), encrypted, geo, writeOnly", async () => {
      const { controller } = bind(family, CapRow);
      const meta = await controller.meta();
      expect(meta.fields.id.indexed).toBe(true);
      expect(meta.fields.rank.indexed).toBe(true);
      expect(meta.fields.title.indexed).toBeUndefined();
      expect(meta.fields.title.sortable).toBe(true);
      expect(meta.fields.secret).toMatchObject({
        encrypted: true,
        filterable: false,
        sortable: false,
      });
      expect(meta.fields.geo).toMatchObject({ geo: true, sortable: false });
      expect(meta.fields.apiSecret).toMatchObject({
        writeOnly: true,
        filterable: false,
        sortable: false,
      });
      // Array / @db.json columns: never sortable on any adapter (D2 base veto).
      expect(meta.fields.tags.sortable).toBe(false);
      expect(meta.fields.prefs.sortable).toBe(false);
    });
  },
);

describe("/meta contract per adapter family", () => {
  it("relational: JSON descendants are not listed; the flattened parent's leaves are", async () => {
    const { controller } = bind("sql", CapRow);
    const meta = await controller.meta();
    expect(meta.fields["prefs.theme"]).toBeUndefined();
    expect(meta.fields["items.sku"]).toBeUndefined();
    expect(meta.fields["contact.email"]).toMatchObject({ filterable: true, sortable: true });
    expect(meta.fields.contact).toBeUndefined();
    expect(meta.fields.prefs).toMatchObject({ filterable: false, sortable: false });
    expect(meta.fields.tags).toMatchObject({ filterable: false, sortable: false });
  });

  it("relational: JSON / array / geoPoint columns advertise the narrower predicates they accept", async () => {
    const { controller } = bind("sql", CapRow);
    const meta = await controller.meta();
    expect(meta.fields.prefs).toEqual({
      filterable: false,
      sortable: false,
      filterOps: ["$exists"],
    });
    expect(meta.fields.tags.filterOps).toEqual(["$exists"]);
    expect(meta.fields.items.filterOps).toEqual(["$exists"]);
    // MockAdapter is not geo-searchable, so `$geoWithin` is not advertised.
    expect(meta.fields.geo.filterOps).toEqual(["$exists"]);
    // Vetoes that apply to every predicate leave nothing to advertise.
    expect(meta.fields.secret.filterOps).toBeUndefined();
    expect(meta.fields.apiSecret.filterOps).toBeUndefined();
    expect(meta.fields.title.filterOps).toBeUndefined();
  });

  it("relational: $geoWithin is advertised in filterOps ⇔ the gate accepts it (geo-searchable or not)", async () => {
    const geoFilter = { geo: { $geoWithin: { center: [0, 0], radius: 10 } } };
    for (const geoSearchable of [false, true]) {
      class GeoMockAdapter extends MockAdapter {
        override isGeoSearchable(): boolean {
          return geoSearchable;
        }
      }
      const db = new DbSpace(() => new GeoMockAdapter(), {
        encryption: { defaultKeyId: "k1", keys: KEYS },
      });
      db.getTable(CapTarget);
      const controller = new AsDbController(makeApp(), db.getTable(CapRow) as any);
      const meta = await controller.meta();
      const advertised = (meta.fields.geo.filterOps ?? []).includes("$geoWithin");
      expect(advertised, `geoSearchable=${geoSearchable}`).toBe(geoSearchable);
      expect(meta.fields.geo.filterOps).toEqual(
        geoSearchable ? ["$exists", "$geoWithin"] : ["$exists"],
      );
      // `$geoWithin` has no URL syntax — ask the gate with the parsed shape directly.
      const verdict = (controller as any).checkCapabilities({ filter: geoFilter, controls: {} });
      expect(verdict === undefined, `gate geoSearchable=${geoSearchable}`).toBe(advertised);
    }
  });

  it("relational: existence on a JSON column is judged per occurrence over HTTP", async () => {
    const { table, controller } = bind("sql", CapRow);
    const calls: unknown[] = [];
    const orig = table.findMany.bind(table);
    (table as any).findMany = (q: Parameters<typeof orig>[0]) => {
      calls.push(q);
      return orig(q);
    };
    for (const url of [
      "?$exists=prefs",
      "?$!exists=prefs,tags",
      "?title=a&$exists=items",
      "?(title=a^$exists=prefs)",
      "?!($exists=prefs)",
    ]) {
      expect(await controller.query(url), url).not.toBeInstanceOf(HttpError);
    }
    expect(calls.map((q) => (q as { filter: unknown }).filter)).toEqual([
      { prefs: { $exists: true } },
      { prefs: { $exists: false }, tags: { $exists: false } },
      { title: "a", items: { $exists: true } },
      { $or: [{ title: "a" }, { prefs: { $exists: true } }] },
      { $not: { prefs: { $exists: true } } },
    ]);
    for (const url of [
      "?$exists=prefs&prefs=x",
      "?(title=a^prefs=x)&$exists=prefs",
      "?!(prefs=x)&$exists=prefs",
      "?prefs!=null",
    ]) {
      const res = await controller.query(url);
      expect(res, url).toBeInstanceOf(HttpError);
      expect(errorsOf(res)[0], url).toEqual({
        path: "prefs",
        message:
          'Filtering on field "prefs" is not permitted — adapter cannot filter on this storage type (accepted operators: $exists).',
      });
    }
    // Descendants, writeOnly and encrypted stay rejected for existence too.
    const desc = await controller.query("?$exists=prefs.theme");
    expect(errorsOf(desc)[0].path).toBe("prefs.theme");
    expect((desc as HttpError).message).toContain('JSON-stored column "prefs"');
    const sealed = await controller.query("?$exists=apiSecret");
    expect(errorsOf(sealed)[0].message).toContain("@db.writeOnly");
    const enc = await controller.query("?$exists=secret");
    expect(errorsOf(enc)[0].message).toContain("@db.encrypted");
    // Sort / groupBy positions are unchanged.
    expect(await controller.query("?$exists=prefs&$sort=prefs")).toBeInstanceOf(HttpError);
    expect(
      await controller.query("?$exists=prefs&$groupBy=prefs&$select=prefs,count()"),
    ).toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(5);
  });

  it("nested-object: JSON descendants are listed and queryable; nav descendants are gone (contract change)", async () => {
    const { controller } = bind("nested", CapRow);
    const meta = await controller.meta();
    expect(meta.fields["prefs.theme"]).toMatchObject({ filterable: true, sortable: true });
    expect(meta.fields["prefs.deep.leaf"]).toMatchObject({ filterable: true, sortable: true });
    expect(meta.fields["items.sku"]).toBeDefined();
    expect(meta.fields.contact).toBeUndefined();
    expect(meta.fields["contact.email"]).toBeDefined();
    expect(meta.fields.prefs).toMatchObject({ filterable: true, sortable: false });
    expect(meta.fields.tags).toMatchObject({ filterable: true, sortable: false });
    expect(Object.keys(meta.fields).some((p) => p === "target" || p.startsWith("target."))).toBe(
      false,
    );
    expect(meta.fields.targetId).toBeDefined();
  });

  it("manual mode: policy narrows filter/$sort to annotated fields; adapter veto still wins on JSON", async () => {
    const { controller } = bind("sql", CapManual);
    const meta = await controller.meta();
    expect(meta.fields.name).toEqual({ filterable: true, sortable: true });
    expect(meta.fields.other).toEqual({ filterable: false, sortable: false });
    // Existence obeys the same policy gate: annotated `prefs` accepts `$exists`, `other` does not.
    expect(meta.fields.prefs).toEqual({
      filterable: false,
      sortable: false,
      filterOps: ["$exists"],
    });
    expect(await accepted(() => controller.query("?$exists=prefs"))).toBe(true);
    const other = await controller.query("?$exists=other");
    expect(errorsOf(other)[0]).toEqual({
      path: "other",
      message: 'Filtering on field "other" is not permitted — add @db.column.filterable to enable.',
    });
    expect(await accepted(() => controller.query("?other=x"))).toBe(false);
    expect(await accepted(() => controller.query("?$sort=other"))).toBe(false);
    expect(await accepted(() => controller.query("?name=x&$sort=-name"))).toBe(true);
    const json = await controller.query("?$sort=prefs");
    expect((json as HttpError).message).toContain("adapter");
    // Manual-mode policy applies to filter / $sort only — $groupBy uses physical capability.
    expect(await accepted(() => controller.query("?$groupBy=other&$select=other,count()"))).toBe(
      true,
    );
  });
});
