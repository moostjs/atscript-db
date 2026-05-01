import { describe, it, expect, vi, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type { TDbActionInfo } from "@atscript/db";

import { Client } from "../client";
import { ActionDisabledError, ClientError } from "../client-error";

let UserType: TAtscriptAnnotatedType;
let baseMeta: Record<string, unknown>;

beforeAll(async () => {
  const fixtures = await import("./fixtures/test-table.as");
  UserType = fixtures.User as unknown as TAtscriptAnnotatedType;
  baseMeta = {
    searchable: false,
    vectorSearchable: false,
    searchIndexes: [],
    primaryKeys: ["id"],
    relations: [],
    fields: {},
    actions: [],
    crud: {},
    type: serializeAnnotatedType(UserType, {
      processAnnotation: ({ key, value }) => {
        if (key.startsWith("meta.") || key.startsWith("expect.") || key.startsWith("db.rel.")) {
          return { key, value };
        }
        if (key === "db.json" || key === "db.patch.strategy" || key.startsWith("db.default")) {
          return { key, value };
        }
        if (key.startsWith("db.")) return undefined;
        return { key, value };
      },
    }),
  };
});

function fetchWith(actions: TDbActionInfo[], errorResponse: { status: number; body: unknown }) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/meta")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ ...baseMeta, actions }),
      });
    }
    return Promise.resolve({
      ok: false,
      status: errorResponse.status,
      statusText: "Error",
      headers: new Map() as unknown as Headers,
      json: () => Promise.resolve(errorResponse.body),
    });
  });
}

const shipAction: TDbActionInfo = {
  name: "ship",
  label: "Ship",
  level: "row",
  processor: "backend",
  value: "/api/users/actions/ship",
};

const archiveAction: TDbActionInfo = {
  name: "archive",
  label: "Archive",
  level: "rows",
  processor: "backend",
  value: "/api/users/actions/archive",
};

describe("ActionDisabledError — client-side typed marker", () => {
  it("constructs ActionDisabledError when error body name === 'ActionDisabledError' (row-level)", async () => {
    const fetchFn = fetchWith([shipAction], {
      status: 409,
      body: {
        name: "ActionDisabledError",
        message: 'Action "ship" is disabled for this row',
        statusCode: 409,
        action: "ship",
        pk: 7,
      },
    });
    const c = new Client("/api/users", { fetch: fetchFn });
    await expect(c.action("ship", 7)).rejects.toBeInstanceOf(ActionDisabledError);

    let caught: unknown;
    try {
      await c.action("ship", 7);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ActionDisabledError);
    expect(caught).toBeInstanceOf(ClientError); // subclass relation preserved
    const err = caught as ActionDisabledError;
    expect(err.action).toBe("ship");
    expect(err.pk).toBe(7);
    expect(err.pks).toBeUndefined();
    expect(err.status).toBe(409);
    expect(err.message).toBe('Action "ship" is disabled for this row');
  });

  it("exposes pks accessor for rows-level rejections", async () => {
    const fetchFn = fetchWith([archiveAction], {
      status: 409,
      body: {
        name: "ActionDisabledError",
        message: 'Action "archive" is disabled for 2 of the selected rows',
        statusCode: 409,
        action: "archive",
        pks: [2, 3],
      },
    });
    const c = new Client("/api/users", { fetch: fetchFn });
    let caught: unknown;
    try {
      await c.action("archive", [1, 2, 3]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ActionDisabledError);
    const err = caught as ActionDisabledError;
    expect(err.action).toBe("archive");
    expect(err.pks).toEqual([2, 3]);
    expect(err.pk).toBeUndefined();
  });

  it("falls back to plain ClientError when error body has no `name: 'ActionDisabledError'`", async () => {
    const fetchFn = fetchWith([shipAction], {
      status: 400,
      body: { message: "bad PK", statusCode: 400 },
    });
    const c = new Client("/api/users", { fetch: fetchFn });
    let caught: unknown;
    try {
      await c.action("ship", 7);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect(caught).not.toBeInstanceOf(ActionDisabledError);
    expect((caught as ClientError).status).toBe(400);
  });

  it("plain ClientError with name field other than ActionDisabledError stays generic", async () => {
    const fetchFn = fetchWith([shipAction], {
      status: 400,
      body: { name: "ValidatorError", message: "invalid", statusCode: 400 },
    });
    const c = new Client("/api/users", { fetch: fetchFn });
    let caught: unknown;
    try {
      await c.action("ship", 7);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect(caught).not.toBeInstanceOf(ActionDisabledError);
  });
});
