import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace, AtscriptDbView, isAtscriptDbView, translateQueryTree } from "../index";
import { resolveViewSource } from "../table/view-source";

import { MockAdapter, prepareFixtures } from "./test-utils";

let fixtures: Record<string, any>;
let vs: Record<string, any>;
let docFx: Record<string, any>;
let vg: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fixtures = await import("./fixtures/view-hash.as");
  vs = await import("./fixtures/view-source.as");
  docFx = await import("./fixtures/doc-renames.as");
  vg = await import("./fixtures/view-agg.as");
});

/** A document-store adapter (nested objects kept inline, like MongoDB). */
class NestedMockAdapter extends MockAdapter {
  override supportsNestedObjects(): boolean {
    return true;
  }
}

function space(): DbSpace {
  return new DbSpace(() => new MockAdapter());
}

// ── @db.ignore on views (since 0.1.128) ─────────────────────────────────

describe("AtscriptDbView.getViewColumnMappings", () => {
  it("excludes @db.ignore fields — they have no column anywhere", () => {
    const view = space().getView(fixtures.VhPlain);
    const mappings = view.getViewColumnMappings();
    expect(mappings.map((m) => m.viewColumn)).toEqual(["id", "title"]);
    expect(mappings.some((m) => m.viewColumn === "computed")).toBe(false);
    // The same source of truth tables use
    expect(view.ignoredFields.has("computed")).toBe(true);
  });

  it("still maps ref-backed and aggregate columns", () => {
    const mappings = space().getView(fixtures.VhHavingA).getViewColumnMappings();
    expect(mappings).toEqual([
      {
        viewColumn: "status",
        viewPath: "status",
        sourceTable: "vh_tasks",
        sourceColumn: "status",
      },
      {
        viewColumn: "total",
        viewPath: "total",
        sourceTable: "vh_tasks",
        sourceColumn: "amount",
        aggFn: "sum",
        aggField: "amount",
      },
    ]);
  });
});

// ── Structural view guard (since 0.1.128) ────────────────────────────────

describe("isAtscriptDbView", () => {
  it("is structural: true for any readable reporting isView, false for tables", () => {
    const s = space();
    const view = s.getView(fixtures.VhPlain);
    const table = s.getTable(fixtures.VhTask);
    expect(isAtscriptDbView(view)).toBe(true);
    expect(isAtscriptDbView(table)).toBe(false);

    // A duck-typed readable from "another copy" of the package
    const duck = { isView: true, tableName: "x" } as any;
    expect(duck instanceof AtscriptDbView).toBe(false);
    expect(isAtscriptDbView(duck)).toBe(true);
  });
});

// ── Physical source resolution (since 0.1.136) ─────────────────────────

describe("getViewColumnMappings — physical source names", () => {
  function byView(type: any, nested = false) {
    const s = new DbSpace(() => (nested ? new NestedMockAdapter() : new MockAdapter()));
    return new Map(
      s
        .getView(type)
        .getViewColumnMappings()
        .map((m) => [m.viewPath, m]),
    );
  }

  it("resolves flattened, renamed and nested-renamed sources", () => {
    const m = byView(vs.VsUserView);
    expect(m.get("firstName")).toMatchObject({
      viewColumn: "firstName",
      sourceColumn: "first_name",
    });
    expect(m.get("city")).toMatchObject({
      sourceColumn: "address__city",
    });
    expect(m.get("zip")).toMatchObject({ sourceColumn: "address__zip_code" });
  });

  it("uses the view field's own physical name (view-side @db.column)", () => {
    expect(byView(vs.VsUserView).get("lat")).toMatchObject({
      viewColumn: "lat_view",
      sourceColumn: "address__geo__lat",
    });
  });

  it("reads a JSON leaf as the JSON column plus a typed path", () => {
    const m = byView(vs.VsUserView);
    expect(m.get("theme")).toMatchObject({
      sourceColumn: "settings",
      json: { path: ["theme"], type: "string" },
    });
    expect(m.get("size")!.json).toEqual({ path: ["size"], type: "number" });
    expect(m.get("dark")!.json).toEqual({ path: ["dark"], type: "boolean" });
    expect(m.get("mode")!.json).toEqual({ path: ["inner", "mode"], type: "string" });
    // The whole JSON column (view field has @db.json) and an array column: no path
    expect(m.get("settings")).toMatchObject({ viewColumn: "settings", sourceColumn: "settings" });
    expect(m.get("settings")!.json).toBeUndefined();
    expect(m.get("tags")).toMatchObject({ sourceColumn: "tags" });
  });

  it("expands an object field over a flattened source into one mapping per leaf", () => {
    const m = byView(vs.VsUserView);
    expect(m.has("address")).toBe(false);
    expect(m.get("address.city")).toMatchObject({
      viewColumn: "address__city",
      sourceColumn: "address__city",
    });
    expect(m.get("address.zip")).toMatchObject({
      viewColumn: "address__zip_code",
      sourceColumn: "address__zip_code",
    });
    expect(m.get("address.geo.lat")).toMatchObject({ sourceColumn: "address__geo__lat" });
  });

  it("rejects an object field over a JSON column without @db.json on the view field", () => {
    const view = new DbSpace(() => new MockAdapter()).getView(vs.VsBadJsonObject);
    expect(() => view.getViewColumnMappings()).toThrow(
      'View "vs_bad_json" field "settings": source is a JSON column — add @db.json to the view field',
    );
  });

  it("resolves aggregate fields physically and keeps aggField raw", () => {
    const m = byView(vs.VsRegionStats);
    expect(m.get("latSum")).toMatchObject({
      sourceColumn: "address__geo__lat",
      aggFn: "sum",
      aggField: "address.geo.lat",
    });
    expect(m.get("users")).toMatchObject({ sourceColumn: "*", aggFn: "count", aggField: "*" });
  });

  it("uses document paths on a nested-object adapter (no expansion, no JSON path)", () => {
    const m = byView(vs.VsUserView, true);
    expect(m.get("firstName")).toMatchObject({ sourceColumn: "first_name" });
    expect(m.get("city")).toMatchObject({ sourceColumn: "address.city" });
    expect(m.get("theme")).toMatchObject({ sourceColumn: "settings.theme" });
    expect(m.get("theme")!.json).toBeUndefined();
    expect(m.get("address")).toMatchObject({ viewColumn: "address", sourceColumn: "address" });
    expect(m.has("address.city")).toBe(false);
  });

  it("resolves predicate refs to physical table.column", () => {
    const view = new DbSpace(() => new MockAdapter()).getView(vs.VsUserView);
    const filter = vs.VsUserView.metadata.get("db.view.filter");
    expect(view.resolveFieldRef(filter.left)).toBe('"vs_users"."address__city"');
    expect(() => view.resolveFieldRef({ type: () => vs.VsUser, field: "settings.theme" })).toThrow(
      "JSON paths are not supported in view conditions",
    );
  });
});

const paritySpace = (Adapter: typeof MockAdapter) =>
  new DbSpace(() => new Adapter(), {
    encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
  });

/** `path` or an ancestor segment is declared optional (in TableMetadata's flatMap). */
const optionalChain = (meta: any, path: string) => {
  const segments = path.split(".");
  return segments.some((_, i) => meta.flatMap.get(segments.slice(0, i + 1).join("."))?.optional);
};

const inSetOrUnder = (set: ReadonlySet<string>, path: string) =>
  [...set].find((p) => path === p || path.startsWith(`${p}.`));

describe("resolveViewSource — parity with TableMetadata", () => {
  it("matches every stored column of the relational fixtures (name, JSON column, optional)", () => {
    const s = paritySpace(MockAdapter);
    for (const type of [vs.VsUser, vs.VsRegion, vs.VsCountry, vs.VsParity]) {
      const meta = s.getTable(type).getMetadata();
      expect(meta.descriptorByPath.size).toBeGreaterThan(0);
      for (const [path, fd] of meta.descriptorByPath) {
        const source = resolveViewSource(type, path, false);
        expect(source.column, path).toBe(fd.physicalName);
        expect(source.jsonPath, path).toBeUndefined();
        expect(source.optional, path).toBe(optionalChain(meta, path));
      }
    }
  });

  it("reads a path inside a JSON column as that column plus the remaining segments", () => {
    const s = paritySpace(MockAdapter);
    let checked = 0;
    for (const type of [vs.VsUser, vs.VsParity]) {
      const meta = s.getTable(type).getMetadata();
      for (const path of meta.flatMap.keys()) {
        const root = [...meta.jsonParents].find((p) => path.startsWith(`${p}.`));
        if (!root || inSetOrUnder(meta.navFields, path)) continue;
        const source = resolveViewSource(type, path, false);
        expect(source.column, path).toBe(meta.descriptorByPath.get(root)!.physicalName);
        expect(source.jsonPath, path).toEqual(path.slice(root.length + 1).split("."));
        expect(source.optional, path).toBe(true);
        checked++;
      }
    }
    // Arrays / @db.json inside a JSON column are part of it, not separate roots
    expect(resolveViewSource(vs.VsParity, "prefs.deep.a", false)).toMatchObject({
      column: "prefs",
      jsonPath: ["deep", "a"],
    });
    expect(resolveViewSource(vs.VsParity, "list.value", false)).toMatchObject({
      column: "list",
      jsonPath: ["value"],
    });
    expect(checked).toBeGreaterThan(5);
  });

  it("rejects paths inside an encrypted field and paths without storage", () => {
    const s = paritySpace(MockAdapter);
    const meta = s.getTable(vs.VsParity).getMetadata();
    for (const path of meta.flatMap.keys()) {
      const encrypted = [...meta.encryptedFields].find((p) => path.startsWith(`${p}.`));
      if (encrypted) {
        expect(() => resolveViewSource(vs.VsParity, path, false), path).toThrow(
          `inside the @db.encrypted field "${encrypted}"`,
        );
      }
    }
    expect(resolveViewSource(vs.VsParity, "secret", false).column).toBe("secret");
    for (const path of ["computed", "region", "region.name"]) {
      expect(() => resolveViewSource(vs.VsParity, path, false), path).toThrow("has no column");
      expect(() => resolveViewSource(vs.VsParity, path, true), path).toThrow("has no column");
    }
  });

  it("matches documentPath for every stored path on a nested-object adapter", () => {
    const s = paritySpace(NestedMockAdapter);
    for (const type of [vs.VsUser, vs.VsParity, docFx.DocRename]) {
      const meta = s.getTable(type).getMetadata();
      for (const path of meta.flatMap.keys()) {
        if (!path || inSetOrUnder(meta.ignoredFields, path)) continue;
        const source = resolveViewSource(type, path, true);
        expect(source.column, path).toBe(meta.documentPath(path));
        expect(source.jsonPath, path).toBeUndefined();
      }
    }
  });

  it("classifies flattened objects, JSON leaves and optionality", () => {
    expect(resolveViewSource(vs.VsUser, "address", false)).toMatchObject({
      designType: "object",
      flattened: true,
    });
    expect(resolveViewSource(vs.VsUser, "settings.inner.mode", false)).toMatchObject({
      column: "settings",
      jsonPath: ["inner", "mode"],
      designType: "string",
    });
    expect(resolveViewSource(vs.VsUser, "regionId", false).optional).toBe(true);
    expect(resolveViewSource(vs.VsUser, "id", false).optional).toBe(false);
    // An optional ancestor makes its leaves optional too
    expect(resolveViewSource(vs.VsParity, "meta.kind", false)).toMatchObject({
      column: "meta__the_kind",
      optional: true,
    });
    // An undeclared path resolves to itself
    expect(resolveViewSource(vs.VsUser, "nope", false).column).toBe("nope");
  });
});

describe("getViewColumnMappings — nullable sources, memo", () => {
  it("flags sources that may be missing: left-joined, optional, JSON leaves", () => {
    const chain = mappingsOf(vs.VsChain);
    expect(chain.get("id")!.nullable).toBeUndefined();
    expect(chain.get("regionName")!.nullable).toBe(true); // left join
    expect(chain.get("countryName")!.nullable).toBeUndefined(); // inner join, required
    const user = mappingsOf(vs.VsUserView);
    expect(user.get("firstName")!.nullable).toBeUndefined();
    expect(user.get("theme")!.nullable).toBe(true); // inside a JSON column
    expect(mappingsOf(vs.VsRegionStats).get("latSum")!.nullable).toBeUndefined();
  });

  it("computes the mappings once per view", () => {
    const view = new DbSpace(() => new MockAdapter()).getView(vs.VsUserView);
    expect(view.getViewColumnMappings()).toBe(view.getViewColumnMappings());
  });
});

describe("translateQueryTree", () => {
  const ref = { field: "a" };
  it("keeps `not exists` (right: false) — `exists` alone is right: true", () => {
    expect(translateQueryTree({ left: ref, op: "$exists", right: true }, (r) => r.field)).toEqual({
      a: { $exists: true },
    });
    expect(translateQueryTree({ left: ref, op: "$exists", right: false }, (r) => r.field)).toEqual({
      a: { $exists: false },
    });
  });
});

describe("view joins — kind and chains", () => {
  it("parses the join kind (inner by default) in declaration order", () => {
    const plan = new DbSpace(() => new MockAdapter()).getView(vs.VsChain).viewPlan;
    expect(plan.joins.map((j) => [j.targetTable, j.kind])).toEqual([
      ["vs_regions", "left"],
      ["vs_countries", "inner"],
    ]);
  });

  it("resolves a chained join condition that references an earlier join", () => {
    const view = new DbSpace(() => new MockAdapter()).getView(vs.VsChain);
    const cond = view.viewPlan.joins[1].condition as any;
    expect(view.resolveFieldRef(cond.left)).toBe('"vs_countries"."id"');
    expect(view.resolveFieldRef(cond.right)).toBe('"vs_regions"."countryId"');
    const m = view.getViewColumnMappings();
    expect(m.find((c) => c.viewPath === "regionName")).toMatchObject({
      sourceTable: "vs_regions",
      sourceColumn: "region_name",
    });
  });
});

// ── Conditional aggregates + countDistinct (since 0.1.136) ─────────────────

const mappingsOf = (type: any) =>
  new Map(
    new DbSpace(() => new MockAdapter())
      .getView(type)
      .getViewColumnMappings()
      .map((m) => [m.viewPath, m]),
  );

describe("getViewColumnMappings — @db.agg.* shapes", () => {
  it("compiles every @db.agg.* to { field?, condition? }", () => {
    const meta = (field: string) => vg.VgStats.type.props.get(field).metadata;
    expect(meta("orders").get("db.agg.count")).toEqual({});
    expect(meta("buyers").get("db.agg.countDistinct")).toEqual({ field: "customerId" });
    expect(meta("paidOrders").get("db.agg.count")).toMatchObject({
      field: "*",
      condition: { left: { field: "status" }, op: "$eq", right: "paid" },
    });
  });

  it("maps countDistinct and conditional aggregates (aggFilter = the condition)", () => {
    const m = mappingsOf(vg.VgStats);
    expect(m.get("orders")).toEqual({
      viewColumn: "orders",
      viewPath: "orders",
      sourceTable: "vg_orders",
      sourceColumn: "*",
      aggFn: "count",
      aggField: "*",
    });
    expect(m.get("buyers")).toMatchObject({
      sourceColumn: "customerId",
      aggFn: "countDistinct",
      aggField: "customerId",
    });
    expect(m.get("buyers")!.aggFilter).toBeUndefined();
    expect(m.get("paidOrders")).toMatchObject({
      sourceColumn: "*",
      aggFn: "count",
      aggField: "*",
      aggFilter: { left: { field: "status" }, op: "$eq", right: "paid" },
    });
    const paidTotal = m.get("paidTotal")!;
    expect(paidTotal).toMatchObject({
      sourceColumn: "amount_cents",
      aggFn: "sum",
      aggField: "amount",
    });
    expect(paidTotal.aggFilter).toHaveProperty("$and");
    expect(m.get("bigBuyers")).toMatchObject({
      aggFn: "countDistinct",
      aggFilter: { left: { field: "amount" }, op: "$gte", right: 100 },
    });
    expect(m.get("paidAvg")).toMatchObject({ aggFn: "avg", sourceColumn: "amount_cents" });
  });

  it("normalizes the pre-0.1.136 shapes (true, a string) like the object shape", () => {
    const before = mappingsOf(vg.VgStats);
    const props = vg.VgStats.type.props;
    const saved = [
      props.get("orders").metadata.get("db.agg.count"),
      props.get("buyers").metadata.get("db.agg.countDistinct"),
    ];
    try {
      props.get("orders").metadata.set("db.agg.count", true);
      props.get("buyers").metadata.set("db.agg.countDistinct", "customerId");
      const after = mappingsOf(vg.VgStats);
      expect(after.get("orders")).toEqual(before.get("orders"));
      expect(after.get("buyers")).toEqual(before.get("buyers"));
    } finally {
      props.get("orders").metadata.set("db.agg.count", saved[0]);
      props.get("buyers").metadata.set("db.agg.countDistinct", saved[1]);
    }
  });

  it("rejects '*' on an aggregate other than count where the mapping is built", () => {
    const meta = vg.VgStats.type.props.get("paidTotal").metadata;
    const saved = meta.get("db.agg.sum");
    try {
      meta.set("db.agg.sum", { field: "*" });
      expect(() => mappingsOf(vg.VgStats)).toThrow(
        'View "vg_stats" field "paidTotal": aggregate "sum" needs a field — only count accepts *',
      );
    } finally {
      meta.set("db.agg.sum", saved);
    }
  });

  it("resolves conditional-aggregate refs like @db.view.filter (unqualified → entry table)", () => {
    const view = new DbSpace(() => new MockAdapter()).getView(vg.VgStats);
    const filter = mappingsOf(vg.VgStats).get("bigBuyers")!.aggFilter as any;
    expect(view.resolveFieldRef(filter.left)).toBe('"vg_orders"."amount_cents"');
    const paid = mappingsOf(vg.VgStats).get("paidOrders")!.aggFilter as any;
    expect(view.resolveFieldRef(paid.left)).toBe('"vg_orders"."status"');
  });
});
