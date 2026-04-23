import { describe, it, expect, vi } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { AsJsonValueHelpController } from "../as-json-value-help.controller";

/**
 * Tests for `AsValueHelpController` + `AsJsonValueHelpController`.
 *
 * The bound interface is synthesised in-process so these tests don't depend on
 * the `@atscript/ui` plugin being loaded (unit scope). `@ui.dict.*` annotations
 * are client-side hints only — the server never rejects a request because a
 * field is missing one.
 */

type Status = { id: string; label: string; description?: string };

function makeProp(designType: string, annotations: Record<string, unknown> = {}) {
  return {
    type: { kind: "", designType, tags: new Set() },
    metadata: new Map(Object.entries(annotations)),
  } as any;
}

function makeValueHelpType(options: {
  interfaceAnnotations?: Record<string, unknown>;
  props: Record<string, { designType: string; annotations?: Record<string, unknown> }>;
}) {
  const props = new Map<string, any>();
  for (const [name, def] of Object.entries(options.props)) {
    props.set(name, makeProp(def.designType, def.annotations ?? {}));
  }
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "object", props, propsPatterns: [], tags: new Set() },
    metadata: new Map(Object.entries(options.interfaceAnnotations ?? {})),
  } as any;
}

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

describe("AsJsonValueHelpController — basic plumbing", () => {
  it("getOne returns matching row by PK", async () => {
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
  it("meta.fields reflect @ui.dict.* annotations as hints; PK name is reported", async () => {
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
    expect(meta.readOnly).toBe(true);
  });
});
