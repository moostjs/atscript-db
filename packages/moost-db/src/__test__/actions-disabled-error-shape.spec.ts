import { describe, it, expect } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { ActionDisabledError } from "../actions/action-disabled-error";

/**
 * Server-side `ActionDisabledError` SHALL extend `HttpError` and produce a
 * 409 response whose body matches the wire contract:
 *
 * ```
 * { name: 'ActionDisabledError', message: <human-readable>, statusCode: 409,
 *   action: <name>, id?: <id>, ids?: <failing ids> }
 * ```
 *
 * `id` is set on `'row'`-level rejections (ids omitted); `ids` is set on
 * `'rows'`-level rejections (id omitted).
 */

describe("ActionDisabledError — server-side error shape", () => {
  it("extends HttpError", () => {
    const err = new ActionDisabledError("ship", { id: 42 });
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toBeInstanceOf(ActionDisabledError);
  });

  it("populates wire body for row-level rejection (id set, ids omitted)", () => {
    const err = new ActionDisabledError("ship", { id: 42 });
    expect(err.body.statusCode).toBe(409);
    expect((err.body as { name?: unknown }).name).toBe("ActionDisabledError");
    expect((err.body as { action?: unknown }).action).toBe("ship");
    expect((err.body as { id?: unknown }).id).toEqual({ id: 42 });
    expect(err.body).not.toHaveProperty("ids");
    expect(err.body.message).toBe('Action "ship" is disabled for this row');
  });

  it("populates wire body for rows-level rejection (ids set, id omitted)", () => {
    const err = new ActionDisabledError("archive", undefined, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(err.body.statusCode).toBe(409);
    expect((err.body as { name?: unknown }).name).toBe("ActionDisabledError");
    expect((err.body as { action?: unknown }).action).toBe("archive");
    expect((err.body as { ids?: unknown }).ids).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(err.body).not.toHaveProperty("id");
    expect(err.body.message).toContain("3 of the selected rows");
  });

  it("populates message for empty ids array (skip-mode zero-survivors edge case)", () => {
    const err = new ActionDisabledError("archive", undefined, []);
    expect(err.body.message).toContain("0 of the selected rows");
    expect((err.body as { ids?: unknown }).ids).toEqual([]);
  });

  it("composite-ID row rejection threads the object ID as `id`", () => {
    const compositePk = { tenantId: "acme", userId: "u1" };
    const err = new ActionDisabledError("promote", compositePk);
    expect((err.body as { id?: unknown }).id).toEqual(compositePk);
  });
});
