import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { AsDbReadableController } from "../as-db-readable.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, errorsOf, prepareFixtures } from "./test-utils";

// Computed view columns (`@db.compute`, since 0.1.147) over HTTP: a computed
// field is visible only while every operand is (`salaryBand = salary * 1`
// would otherwise leak a hidden `salary`), it is sealed out of the read
// projection with a hidden operand, and `/meta` flags it `computed: true`.

let fx: Record<string, any>;

/** Paths the scoped controller hides — reset per test. */
let HIDDEN = new Set<string>();

class ScopedController extends AsDbReadableController {
  protected override hasField(path: string): boolean {
    return super.hasField(path) && !HIDDEN.has(path);
  }
}

function bind(Ctrl: new (...args: any[]) => AsDbReadableController = ScopedController) {
  const db = new DbSpace(() => new MockAdapter());
  db.getTable(fx.CvEmployee);
  const view = db.getView(fx.CvPay);
  return { controller: new Ctrl(makeApp(), view as any), view };
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/computed-view.as");
});

beforeEach(() => {
  HIDDEN = new Set();
});

describe("computed view columns over HTTP", () => {
  it("/meta flags computed fields; they sort and filter like any number column", async () => {
    const meta = await bind(AsDbReadableController).controller.meta();
    expect(meta.fields.salaryBand).toMatchObject({
      computed: true,
      sortable: true,
      filterable: true,
    });
    expect(meta.fields.total).toMatchObject({ computed: true });
    expect(meta.fields.salary).not.toHaveProperty("computed");
  });

  it("a computed field over a hidden operand (directly or transitively) is an unknown field", async () => {
    HIDDEN = new Set(["salary"]);
    const { controller } = bind();
    for (const [qs, path] of [
      ["$select=salaryBand", "salaryBand"],
      ["$sort=total", "total"],
      ["total>5", "total"],
    ]) {
      expect(errorsOf(await controller.query(`?${qs}`))?.[0], qs).toEqual({
        path,
        message: `Unknown field "${path}"`,
      });
    }
  });

  it("…and is sealed out of the read projection", () => {
    HIDDEN = new Set(["bonus"]);
    const { controller, view } = bind();
    const sealed = (controller as any).fieldVisibility.sealedFor(view);
    expect([...sealed]).toEqual(["total"]);
  });

  it("a hidden intermediate computed field hides and seals its dependents", async () => {
    // `total = coalesce(bonus, 0) + salaryBand`: with `bonus` visible,
    // `total - bonus` would give back the hidden `salaryBand`
    HIDDEN = new Set(["salaryBand"]);
    const { controller, view } = bind();
    expect([...(controller as any).fieldVisibility.sealedFor(view)]).toEqual(["total"]);
    expect((controller as any).fieldVisibility.isVisible("total")).toBe(false);
    for (const qs of ["$sort=total", "total>5", "$select=total"]) {
      const res = await controller.query(`?${qs}`);
      expect((res as any).body.statusCode, qs).toBe(400);
      expect(errorsOf(res)?.[0], qs).toEqual({ path: "total", message: 'Unknown field "total"' });
    }
  });

  it("visible operands keep the computed fields", async () => {
    HIDDEN = new Set(["name"]);
    const { controller, view } = bind();
    expect([...(controller as any).fieldVisibility.sealedFor(view)]).toEqual([]);
    expect(Array.isArray(await controller.query("?$sort=total&$select=salaryBand"))).toBe(true);
  });
});
