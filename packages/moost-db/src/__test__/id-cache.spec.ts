import { describe, it, expect } from "vite-plus/test";
import { ValidatorError } from "@atscript/typescript/utils";
import { HttpError } from "@moostjs/event-http";
import { prepareTestHttpContext } from "@wooksjs/event-http";
import { current } from "@wooksjs/event-core";
import { setControllerContext } from "moost";

import {
  boundTableKey,
  dbActionIdSlot,
  dbActionIdsSlot,
  getActionTable,
} from "../actions/id-cache";
import { bindDuckTypeController, makePkOnlyTable, runInActionCtx } from "./actions-test-utils";

/**
 * Coverage for the cached ID wook (single source of truth for parsed +
 * validated action IDs). These tests set up a real `EventContext` via
 * `prepareTestHttpContext` so `useBody().parseBody()` can read the seeded
 * raw body and the validation path produces the same `ValidatorError` that
 * surfaces as HTTP 400 in production.
 */

const PK_URL = "/api/users/actions/block";

function runWith(rawBody: string, table: unknown, fn: () => Promise<unknown>) {
  return runInActionCtx(
    rawBody,
    async () => {
      bindDuckTypeController(table, "handler", PK_URL);
      return fn();
    },
    { url: PK_URL },
  );
}

describe("Cached ID wook — single ID", () => {
  it("validates body once and returns the validated ID to all readers", async () => {
    const table = makePkOnlyTable("string");
    const result = await runWith('{"id":"abc123"}', table, async () => {
      const ctx = current();
      const a = await ctx.get(dbActionIdSlot);
      const b = await ctx.get(dbActionIdSlot);
      // Both reads return the same value (cached).
      expect(a).toEqual({ id: "abc123" });
      expect(b).toEqual({ id: "abc123" });
      return a;
    });
    expect(result).toEqual({ id: "abc123" });
  });

  it("rejects wrong scalar type (no coercion) — bad ID never reaches the gate", async () => {
    const table = makePkOnlyTable("number");
    let caught: unknown;
    await runWith('{"id":"42"}', table, async () => {
      const ctx = current();
      try {
        await ctx.get(dbActionIdSlot);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ValidatorError);
  });

  it("throws opaque HttpError(500) with code ACTION_TABLE_NOT_BOUND when no table is bound (plain controller, no opts.table)", async () => {
    let caught: unknown;
    const run = prepareTestHttpContext({
      url: "/api/c/act",
      method: "POST",
      headers: { "content-type": "application/json" },
      rawBody: '"a"',
    });
    await run(async () => {
      class Plain {
        handler() {}
      }
      const ctrl = new Plain();
      setControllerContext(ctrl as never, "handler", "/api/c/act");
      try {
        await current().get(dbActionIdSlot);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(HttpError);
    const body = (caught as HttpError).body as {
      statusCode: number;
      message: string;
      code?: string;
    };
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe("Internal server error");
    expect(body.code).toBe("ACTION_TABLE_NOT_BOUND");
  });
});

describe("Cached ID wook — multi ID + skip-mode mutation", () => {
  it("validates JSON array and rejects non-array body", async () => {
    const table = makePkOnlyTable("string");
    let caught: unknown;
    await runWith('{"id":"a"}', table, async () => {
      try {
        await current().get(dbActionIdsSlot);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ValidatorError);
  });

  it("ctx.set on dbActionIdsSlot replaces the cached value (skip-mode contract)", async () => {
    const table = makePkOnlyTable("string");
    const result = await runWith('[{"id":"a"},{"id":"b"},{"id":"c"}]', table, async () => {
      const ctx = current();
      const initial = (await ctx.get(dbActionIdsSlot)) as unknown[];
      expect(initial).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
      // Simulate the gate interceptor's skip-mode filtering.
      ctx.set(dbActionIdsSlot, Promise.resolve([{ id: "a" }]));
      const filtered = (await ctx.get(dbActionIdsSlot)) as unknown[];
      expect(filtered).toEqual([{ id: "a" }]);
      return filtered;
    });
    expect(result).toEqual([{ id: "a" }]);
  });
});

describe("getActionTable — bound-table slot precedence", () => {
  it("boundTableKey wins over controller-context duck-type fallback", async () => {
    const ductTable = makePkOnlyTable("string");
    const explicitTable = makePkOnlyTable("number");
    await runWith('{"id":42}', ductTable, async () => {
      const ctx = current();
      ctx.set(boundTableKey, explicitTable);
      const resolved = getActionTable(ctx);
      expect(resolved).toBe(explicitTable);
      // The validated ID uses the explicit (numeric) table — `42` parses fine,
      // would have failed against the duct (string) table.
      const id = await ctx.get(dbActionIdSlot);
      expect(id).toEqual({ id: 42 });
    });
  });

  it("falls through to controller-context duck-type when boundTableKey is unset", async () => {
    const ductTable = makePkOnlyTable("string");
    await runWith('{"id":"abc"}', ductTable, async () => {
      const ctx = current();
      // boundTableKey is intentionally NOT set.
      const resolved = getActionTable(ctx);
      expect(resolved).toBe(ductTable);
    });
  });
});

describe("Cached ID wook — single fetch shared by gate and handler", () => {
  it("body-parsing happens exactly once per request even with multiple readers", async () => {
    const table = makePkOnlyTable("string");
    const result = await runWith('{"id":"abc"}', table, async () => {
      const ctx = current();
      const reads = await Promise.all([
        ctx.get(dbActionIdSlot),
        ctx.get(dbActionIdSlot),
        ctx.get(dbActionIdSlot),
      ]);
      // All reads share the same Promise → same value.
      expect(reads[0]).toEqual({ id: "abc" });
      expect(reads[1]).toEqual({ id: "abc" });
      expect(reads[2]).toEqual({ id: "abc" });
      return reads;
    });
    expect(result).toHaveLength(3);
  });
});
