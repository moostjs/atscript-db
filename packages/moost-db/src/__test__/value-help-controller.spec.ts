import { describe, it, expect, vi } from "vite-plus/test";
import { DbError } from "@atscript/db";
import { HttpError } from "@moostjs/event-http";

import { AsJsonValueHelpController } from "../as-json-value-help.controller";
import { makeValueHelpType } from "./actions-test-utils";

/**
 * Tests for `AsValueHelpController` + `AsJsonValueHelpController`.
 *
 * The bound interface is synthesised in-process so these tests don't depend on
 * the `@atscript/ui` plugin being loaded (unit scope). `@ui.dict.*` annotations
 * are client-side hints only — the server never rejects a request because a
 * field is missing one.
 */

type Status = { id: string; label: string; description?: string };

function makeApp() {
  return {
    getLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
    }),
  } as any;
}

const STATUSES: Status[] = [
  { id: "active", label: "Active", description: "Currently active" },
  { id: "archived", label: "Archived", description: "No longer used" },
  { id: "draft", label: "Draft", description: "In progress" },
];

/** A bound type carrying just a `@meta.id` primary key (no other props matter). */
function idOnlyType() {
  return makeValueHelpType({
    props: { id: { designType: "string", annotations: { "meta.id": true } } },
  });
}

/** Invoke the protected `query()` pipeline directly with an explicit filter/controls. */
function callQuery(
  ctrl: AsJsonValueHelpController<any, any>,
  filter: Record<string, unknown>,
  controls: Record<string, unknown> = {},
): Promise<{ data: any[]; count: number }> {
  return (
    ctrl as unknown as {
      query(c: { filter: unknown; controls: unknown }): Promise<{ data: any[]; count: number }>;
    }
  ).query({ filter, controls });
}

describe("AsJsonValueHelpController — basic plumbing", () => {
  it("getOne returns matching row by ID", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
      },
    });
    const controller = new AsJsonValueHelpController<typeof type, Status>(
      type,
      STATUSES,
      makeApp(),
    );
    const result = await controller.runGetOne("active");
    expect(result).toEqual(STATUSES[0]);
  });

  it("getOne returns 404 on miss", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
      },
    });
    const controller = new AsJsonValueHelpController<typeof type, Status>(
      type,
      STATUSES,
      makeApp(),
    );
    const result = await controller.runGetOne("does-not-exist");
    expect(result).toBeInstanceOf(HttpError);
    expect((result as HttpError).body.statusCode).toBe(404);
  });

  it("query returns all rows when no controls", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
      },
    });
    const controller = new AsJsonValueHelpController<typeof type, Status>(
      type,
      STATUSES,
      makeApp(),
    );
    const result = await controller.runQuery("");
    expect(result).toEqual(STATUSES);
  });
});

describe("AsValueHelpController — @ui.dict.* are hints, not gates", () => {
  it("filter is applied regardless of @ui.dict.filterable presence", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
      },
    });
    const controller = new AsJsonValueHelpController<typeof type, Status>(
      type,
      STATUSES,
      makeApp(),
    );
    const result = await controller.runQuery("?label=Active");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([STATUSES[0]]);
  });

  it("sort is applied regardless of @ui.dict.sortable presence", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
      },
    });
    const controller = new AsJsonValueHelpController<typeof type, Status>(
      type,
      STATUSES,
      makeApp(),
    );
    const result = await controller.runQuery("?$sort=label");
    expect(result).toEqual([STATUSES[0], STATUSES[1], STATUSES[2]]);
  });

  it("$search is accepted even without @ui.dict.searchable (defaults to all string props)", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
        description: { designType: "string" },
      },
    });
    const controller = new AsJsonValueHelpController<typeof type, Status>(
      type,
      STATUSES,
      makeApp(),
    );
    const result = await controller.runQuery("?$search=LONGER");
    // Matches 'archived' via its description "No longer used".
    expect(result).toEqual([STATUSES[1]]);
  });

  it("prop-level @ui.dict.searchable narrows $search to the annotated props only", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: {
          designType: "string",
          annotations: { "ui.dict.searchable": true },
        },
        description: { designType: "string" },
      },
    });
    const controller = new AsJsonValueHelpController<typeof type, Status>(
      type,
      STATUSES,
      makeApp(),
    );
    // 'LONGER' lives in description — not searchable with prop-level hint on label only.
    const missed = await controller.runQuery("?$search=LONGER");
    expect(missed).toEqual([]);
    // 'arch' matches label 'Archived'.
    const hit = await controller.runQuery("?$search=arch");
    expect(hit).toEqual([STATUSES[1]]);
  });
});

describe("AsJsonValueHelpController — pagination", () => {
  it("pages endpoint applies $skip + $limit and returns count", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
      },
    });
    const controller = new AsJsonValueHelpController<typeof type, Status>(
      type,
      STATUSES,
      makeApp(),
    );
    const result = await controller.runPages("?$page=1&$size=2&$sort=label");
    expect(result).not.toBeInstanceOf(HttpError);
    if (!(result instanceof HttpError)) {
      expect(result.count).toBe(3);
      expect(result.pages).toBe(2);
      expect(result.data.map((r) => r.id)).toEqual(["active", "archived"]);
    }
  });
});

describe("AsValueHelpController — meta response", () => {
  it("meta.fields reflect @ui.dict.* annotations as hints; ID name is reported", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: {
          designType: "string",
          annotations: {
            "ui.dict.filterable": true,
            "ui.dict.sortable": true,
          },
        },
        description: { designType: "string" },
      },
    });
    const controller = new AsJsonValueHelpController<typeof type, Status>(
      type,
      STATUSES,
      makeApp(),
    );
    const meta = await controller.meta();
    expect(meta.primaryKeys).toEqual(["id"]);
    expect(meta.searchable).toBe(true);
    expect(meta.fields.label).toEqual({ filterable: true, sortable: true });
    expect(meta.fields.description).toEqual({ filterable: false, sortable: false });
    expect(meta.crud.insert).toBeUndefined();
    expect(meta.crud.update).toBeUndefined();
    expect(meta.crud.replace).toBeUndefined();
    expect(meta.crud.remove).toBeUndefined();
  });
});

describe("AsJsonValueHelpController — shared db-memory engine semantics", () => {
  it("dot-path filter matches a nested field (a.b)", async () => {
    const type = idOnlyType();
    const rows = [
      { id: "1", meta: { code: "alpha" } },
      { id: "2", meta: { code: "beta" } },
    ];
    const ctrl = new AsJsonValueHelpController<typeof type, any>(type, rows, makeApp());
    const res = await callQuery(ctrl, { "meta.code": "beta" });
    expect(res.data).toEqual([rows[1]]);
    expect(res.count).toBe(1);
  });

  it("$exists treats present-null as present and excludes absent fields", async () => {
    const type = idOnlyType();
    const rows = [{ id: "has", note: "x" }, { id: "null", note: null }, { id: "absent" }];
    const ctrl = new AsJsonValueHelpController<typeof type, any>(type, rows, makeApp());
    const res = await callQuery(ctrl, { note: { $exists: true } });
    expect(res.data.map((r) => r.id)).toEqual(["has", "null"]);
  });

  it("$regex with /i flag matches case-insensitively (corrected flag parsing)", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
      },
    });
    const ctrl = new AsJsonValueHelpController<typeof type, Status>(type, STATUSES, makeApp());
    // `~=` maps to `$regex`; the `/active/i` literal is parsed for flags, so
    // "Active" matches case-insensitively (the old engine dropped the flags).
    const result = await ctrl.runQuery("?label~=/active/i");
    expect(result).toEqual([STATUSES[0]]);
  });

  it("nested-path $select returns the projected nested shape (no PK auto-add)", async () => {
    const type = idOnlyType();
    const rows = [{ id: "1", meta: { code: "alpha", extra: "drop" }, other: "x" }];
    const ctrl = new AsJsonValueHelpController<typeof type, any>(type, rows, makeApp());
    const res = await callQuery(ctrl, {}, { $select: ["meta.code"] });
    expect(res.data).toEqual([{ meta: { code: "alpha" } }]);
  });

  it("Mongo-like null: {field: null} matches explicit-null and missing", async () => {
    const type = idOnlyType();
    const rows = [
      { id: "present", parent: "p1" },
      { id: "explicit", parent: null },
      { id: "missing" },
    ];
    const ctrl = new AsJsonValueHelpController<typeof type, any>(type, rows, makeApp());
    const res = await callQuery(ctrl, { parent: null });
    expect(res.data.map((r) => r.id)).toEqual(["explicit", "missing"]);
  });

  it("Mongo-like null: {$ne: null} matches only concrete present values", async () => {
    const type = idOnlyType();
    const rows = [
      { id: "present", parent: "p1" },
      { id: "explicit", parent: null },
      { id: "missing" },
    ];
    const ctrl = new AsJsonValueHelpController<typeof type, any>(type, rows, makeApp());
    const res = await callQuery(ctrl, { parent: { $ne: null } });
    expect(res.data.map((r) => r.id)).toEqual(["present"]);
  });

  it("unsupported filter operator surfaces as DbError (INVALID_QUERY → 400)", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
      },
    });
    const ctrl = new AsJsonValueHelpController<typeof type, Status>(type, STATUSES, makeApp());
    await expect(callQuery(ctrl, { label: { $foo: "Active" } })).rejects.toBeInstanceOf(DbError);
  });
});

describe("AsJsonValueHelpController — regression guards after the engine swap", () => {
  it("$sort with '-' prefix sorts descending", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
      },
    });
    const ctrl = new AsJsonValueHelpController<typeof type, Status>(type, STATUSES, makeApp());
    const result = await ctrl.runQuery("?$sort=-label");
    expect(result).toEqual([STATUSES[2], STATUSES[1], STATUSES[0]]);
  });

  it("$search still narrows results (case-insensitive substring)", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
        description: { designType: "string" },
      },
    });
    const ctrl = new AsJsonValueHelpController<typeof type, Status>(type, STATUSES, makeApp());
    const result = await ctrl.runQuery("?$search=draft");
    expect(result).toEqual([STATUSES[2]]);
  });
});
