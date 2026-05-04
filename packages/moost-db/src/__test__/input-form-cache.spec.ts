import { describe, it, expect } from "vite-plus/test";
import { ValidatorError } from "@atscript/typescript/utils";
import { prepareTestHttpContext } from "@wooksjs/event-http";
import { current } from "@wooksjs/event-core";

import { dbActionBodySlot, dbActionInputSlot } from "../actions/input-form-cache";

/**
 * Coverage for the action request envelope — the single cached body slot
 * every per-param resolver (`@DbActionID*`, `@DbActionRow*`, `@InputForm`)
 * reads through. The shape is `{ ids?, input? }`; raw arrays/scalars are
 * rejected with a `ValidatorError` matching the existing strict-shape
 * envelope so the existing validation interceptor surfaces HTTP 400.
 */

const URL = "/api/users/actions/x";

function runWith<T>(rawBody: string, fn: () => Promise<T>) {
  return prepareTestHttpContext({
    url: URL,
    method: "POST",
    headers: { "content-type": "application/json" },
    rawBody,
  })(fn);
}

describe("dbActionBodySlot — envelope parsing", () => {
  it("returns the parsed envelope object on a valid `{ ids, input }` body", async () => {
    const env = await runWith('{"ids":{"id":"a"},"input":{"note":"hi"}}', async () => {
      return current().get(dbActionBodySlot);
    });
    expect(env).toEqual({ ids: { id: "a" }, input: { note: "hi" } });
  });

  it("returns `{}` for an empty `{}` body so table-level actions stay valid", async () => {
    const env = await runWith("{}", async () => {
      return current().get(dbActionBodySlot);
    });
    expect(env).toEqual({});
  });

  it("throws ValidatorError when the body root is an array (legacy multi-id shape)", async () => {
    let caught: unknown;
    await runWith('[{"id":"a"}]', async () => {
      try {
        await current().get(dbActionBodySlot);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ValidatorError);
  });

  it("throws ValidatorError when the body root is a scalar", async () => {
    let caught: unknown;
    await runWith('"abc"', async () => {
      try {
        await current().get(dbActionBodySlot);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(ValidatorError);
  });

  it("body parsing happens exactly once even with multiple readers", async () => {
    await runWith('{"ids":{"id":"a"},"input":{"note":"hi"}}', async () => {
      const ctx = current();
      const reads = await Promise.all([
        ctx.get(dbActionBodySlot),
        ctx.get(dbActionBodySlot),
        ctx.get(dbActionBodySlot),
      ]);
      expect(reads[0]).toBe(reads[1]);
      expect(reads[1]).toBe(reads[2]);
    });
  });
});

describe("dbActionInputSlot — `body.input` extraction", () => {
  it("returns the `input` field of the envelope", async () => {
    const input = await runWith('{"ids":{"id":"a"},"input":{"note":"x"}}', async () => {
      return current().get(dbActionInputSlot);
    });
    expect(input).toEqual({ note: "x" });
  });

  it("returns undefined when the envelope omits `input`", async () => {
    const input = await runWith('{"ids":{"id":"a"}}', async () => {
      return current().get(dbActionInputSlot);
    });
    expect(input).toBeUndefined();
  });

  it("shares the parsed envelope with dbActionBodySlot (no second parse)", async () => {
    await runWith('{"ids":{"id":"a"},"input":{"note":"x"}}', async () => {
      const ctx = current();
      const env = await ctx.get(dbActionBodySlot);
      const input = await ctx.get(dbActionInputSlot);
      // Same reference into the parsed envelope's `input` slot.
      expect(input).toBe(env.input);
    });
  });
});
