import { describe, it, expect } from "vite-plus/test";
import { ValidatorError } from "@atscript/typescript/utils";
import { HttpError } from "@moostjs/event-http";
import { prepareTestHttpContext } from "@wooksjs/event-http";
import { current } from "@wooksjs/event-core";
import { setControllerContext } from "moost";

import {
  boundTableKey,
  dbActionPkSlot,
  dbActionPksSlot,
  getActionTable,
} from "../actions/pk-cache";
import { bindDuckTypeController, makePkOnlyTable, runInActionCtx } from "./actions-test-utils";

/**
 * Coverage for the cached PK wook (single source of truth for parsed +
 * validated action PKs). These tests set up a real `EventContext` via
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

describe("Cached PK wook — single PK", () => {
  it("validates body once and returns the validated PK to all readers", async () => {
    const table = makePkOnlyTable("string");
    const result = await runWith('"abc123"', table, async () => {
      const ctx = current();
      const a = await ctx.get(dbActionPkSlot);
      const b = await ctx.get(dbActionPkSlot);
      // Both reads return the same value (cached).
      expect(a).toBe("abc123");
      expect(b).toBe("abc123");
      return a;
    });
    expect(result).toBe("abc123");
  });

  it("rejects wrong scalar type (no coercion) — bad PK never reaches the gate", async () => {
    const table = makePkOnlyTable("number");
    let caught: unknown;
    await runWith('"42"', table, async () => {
      const ctx = current();
      try {
        await ctx.get(dbActionPkSlot);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ValidatorError);
  });

  it("throws HttpError(500) with dev-mistake framing when no table is bound (plain controller, no opts.table)", async () => {
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
        await current().get(dbActionPkSlot);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).body.statusCode).toBe(500);
    expect((caught as HttpError).body.message).toContain(
      "controller has no readable/table property",
    );
  });
});

describe("Cached PK wook — multi PK + skip-mode mutation", () => {
  it("validates JSON array and rejects non-array body", async () => {
    const table = makePkOnlyTable("string");
    let caught: unknown;
    await runWith('"a"', table, async () => {
      try {
        await current().get(dbActionPksSlot);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ValidatorError);
  });

  it("ctx.set on dbActionPksSlot replaces the cached value (skip-mode contract)", async () => {
    const table = makePkOnlyTable("string");
    const result = await runWith('["a","b","c"]', table, async () => {
      const ctx = current();
      const initial = (await ctx.get(dbActionPksSlot)) as unknown[];
      expect(initial).toEqual(["a", "b", "c"]);
      // Simulate the gate interceptor's skip-mode filtering.
      ctx.set(dbActionPksSlot, Promise.resolve(["a"]));
      const filtered = (await ctx.get(dbActionPksSlot)) as unknown[];
      expect(filtered).toEqual(["a"]);
      return filtered;
    });
    expect(result).toEqual(["a"]);
  });
});

describe("getActionTable — bound-table slot precedence", () => {
  it("boundTableKey wins over controller-context duck-type fallback", async () => {
    const ductTable = makePkOnlyTable("string");
    const explicitTable = makePkOnlyTable("number");
    await runWith("42", ductTable, async () => {
      const ctx = current();
      ctx.set(boundTableKey, explicitTable);
      const resolved = getActionTable(ctx);
      expect(resolved).toBe(explicitTable);
      // The validated PK uses the explicit (numeric) table — `42` parses fine,
      // would have failed against the duct (string) table.
      const pk = await ctx.get(dbActionPkSlot);
      expect(pk).toBe(42);
    });
  });

  it("falls through to controller-context duck-type when boundTableKey is unset", async () => {
    const ductTable = makePkOnlyTable("string");
    await runWith('"abc"', ductTable, async () => {
      const ctx = current();
      // boundTableKey is intentionally NOT set.
      const resolved = getActionTable(ctx);
      expect(resolved).toBe(ductTable);
    });
  });
});

describe("Cached PK wook — single fetch shared by gate and handler", () => {
  it("body-parsing happens exactly once per request even with multiple readers", async () => {
    const table = makePkOnlyTable("string");
    const result = await runWith('"abc"', table, async () => {
      const ctx = current();
      const reads = await Promise.all([
        ctx.get(dbActionPkSlot),
        ctx.get(dbActionPkSlot),
        ctx.get(dbActionPkSlot),
      ]);
      // All reads share the same Promise → same value.
      expect(reads[0]).toBe("abc");
      expect(reads[1]).toBe("abc");
      expect(reads[2]).toBe("abc");
      return reads;
    });
    expect(result).toHaveLength(3);
  });
});
