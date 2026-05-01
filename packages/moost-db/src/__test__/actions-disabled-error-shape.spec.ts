import { describe, it, expect } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { ActionDisabledError } from "../actions/action-disabled-error";

/**
 * Server-side `ActionDisabledError` SHALL extend `HttpError` and produce a
 * 409 response whose body matches the wire contract:
 *
 * ```
 * { name: 'ActionDisabledError', message: <human-readable>, statusCode: 409,
 *   action: <name>, pk?: <pk>, pks?: <failing pks> }
 * ```
 *
 * `pk` is set on `'row'`-level rejections (pks omitted); `pks` is set on
 * `'rows'`-level rejections (pk omitted).
 */

describe("ActionDisabledError — server-side error shape", () => {
  it("extends HttpError", () => {
    const err = new ActionDisabledError("ship", 42);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toBeInstanceOf(ActionDisabledError);
  });

  it("populates wire body for row-level rejection (pk set, pks omitted)", () => {
    const err = new ActionDisabledError("ship", 42);
    expect(err.body.statusCode).toBe(409);
    expect((err.body as { name?: unknown }).name).toBe("ActionDisabledError");
    expect((err.body as { action?: unknown }).action).toBe("ship");
    expect((err.body as { pk?: unknown }).pk).toBe(42);
    expect(err.body).not.toHaveProperty("pks");
    expect(err.body.message).toBe('Action "ship" is disabled for this row');
  });

  it("populates wire body for rows-level rejection (pks set, pk omitted)", () => {
    const err = new ActionDisabledError("archive", undefined, [1, 2, 3]);
    expect(err.body.statusCode).toBe(409);
    expect((err.body as { name?: unknown }).name).toBe("ActionDisabledError");
    expect((err.body as { action?: unknown }).action).toBe("archive");
    expect((err.body as { pks?: unknown }).pks).toEqual([1, 2, 3]);
    expect(err.body).not.toHaveProperty("pk");
    expect(err.body.message).toContain("3 of the selected rows");
  });

  it("populates message for empty pks array (skip-mode zero-survivors edge case)", () => {
    const err = new ActionDisabledError("archive", undefined, []);
    expect(err.body.message).toContain("0 of the selected rows");
    expect((err.body as { pks?: unknown }).pks).toEqual([]);
  });

  it("composite-PK row rejection threads the object PK as `pk`", () => {
    const compositePk = { tenantId: "acme", userId: "u1" };
    const err = new ActionDisabledError("promote", compositePk);
    expect((err.body as { pk?: unknown }).pk).toEqual(compositePk);
  });
});
