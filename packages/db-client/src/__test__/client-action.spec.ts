import { describe, it, expect, vi, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type { TDbActionInfo } from "@atscript/db";

import { Client } from "../client";
import { ActionNotFoundError, ActionUnsupportedError, ClientError } from "../client-error";

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

function metaWith(actions: TDbActionInfo[]): Record<string, unknown> {
  return { ...baseMeta, actions };
}

function fetchWith(actions: TDbActionInfo[], actionResponse: unknown = { message: "ok" }) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/meta")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(metaWith(actions)),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map() as unknown as Headers,
      json: () => Promise.resolve(actionResponse),
    });
  });
}

describe("Client.action — backend processor", () => {
  it("POSTs the scalar PK as a JSON body to the resolved path", async () => {
    const fetchFn = fetchWith([
      {
        name: "block",
        label: "Block",
        level: "row",
        processor: "backend",
        value: "/api/users/actions/block",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    const result = await c.action("block", "abc123");

    expect(result).toEqual({ message: "ok" });
    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(postCall[0]).toBe("/api/users/actions/block");
    const init = postCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toBe("abc123");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("POSTs the composite PK object", async () => {
    const fetchFn = fetchWith([
      {
        name: "promote",
        label: "Promote",
        level: "row",
        processor: "backend",
        value: "/api/members/actions/promote",
      },
    ]);
    const c = new Client("/api/members", { fetch: fetchFn });
    await c.action("promote", { tenantId: "acme", userId: "u1" });

    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual({
      tenantId: "acme",
      userId: "u1",
    });
  });

  it("wraps a single PK into an array for level: 'rows'", async () => {
    const fetchFn = fetchWith([
      {
        name: "lock",
        label: "Lock",
        level: "rows",
        processor: "backend",
        value: "/api/users/actions/lock",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await c.action("lock", "abc");

    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual(["abc"]);
  });

  it("passes an array PK through unchanged for level: 'rows'", async () => {
    const fetchFn = fetchWith([
      {
        name: "lock",
        label: "Lock",
        level: "rows",
        processor: "backend",
        value: "/api/users/actions/lock",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await c.action("lock", ["a", "b", "c"]);

    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual(["a", "b", "c"]);
  });

  it("sends no body for level: 'table'", async () => {
    const fetchFn = fetchWith([
      {
        name: "refresh",
        label: "Refresh",
        level: "table",
        processor: "backend",
        value: "/api/users/actions/refresh",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await c.action("refresh");

    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    const init = postCall[1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("prepends baseUrl to the action's value path", async () => {
    const fetchFn = fetchWith([
      {
        name: "block",
        label: "Block",
        level: "row",
        processor: "backend",
        value: "/api/users/actions/block",
      },
    ]);
    const c = new Client("/api/users", {
      fetch: fetchFn,
      baseUrl: "https://example.com",
    });
    await c.action("block", "abc");
    const postCall = fetchFn.mock.calls.find(([u]) => !u.endsWith("/meta"))!;
    expect(postCall[0]).toBe("https://example.com/api/users/actions/block");
  });

  it("propagates server errors as ClientError", async () => {
    const errBody = { statusCode: 400, message: "bad PK", errors: [] };
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/meta")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () =>
            Promise.resolve(
              metaWith([
                {
                  name: "block",
                  label: "Block",
                  level: "row",
                  processor: "backend",
                  value: "/api/users/actions/block",
                },
              ]),
            ),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: () => Promise.resolve(errBody),
      });
    });
    const c = new Client("/api/users", { fetch: fetchFn });
    await expect(c.action("block", "abc")).rejects.toBeInstanceOf(ClientError);
  });
});

describe("Client.action — navigate processor", () => {
  it("substitutes $1 with the URL-encoded scalar PK and calls the navigate hook (level: 'row')", async () => {
    const fetchFn = fetchWith([
      {
        name: "edit",
        label: "Edit",
        level: "row",
        processor: "navigate",
        value: "/users/$1/edit",
      },
    ]);
    const navigate = vi.fn();
    const c = new Client("/api/users", { fetch: fetchFn, navigate });
    await c.action("edit", "abc/123");
    expect(navigate).toHaveBeenCalledWith("/users/abc%2F123/edit");
  });

  it("joins composite PK values with `/` (each URL-encoded) for level: 'row'", async () => {
    const fetchFn = fetchWith([
      {
        name: "edit",
        label: "Edit",
        level: "row",
        processor: "navigate",
        value: "/members/$1/edit",
      },
    ]);
    const navigate = vi.fn();
    const c = new Client("/api/members", { fetch: fetchFn, navigate });
    await c.action("edit", { tenantId: "acme/co", userId: "jane" });
    expect(navigate).toHaveBeenCalledWith("/members/acme%2Fco/jane/edit");
  });

  it("navigates to value verbatim for level: 'table' (no substitution)", async () => {
    const fetchFn = fetchWith([
      {
        name: "report",
        label: "Report",
        level: "table",
        processor: "navigate",
        value: "/reports/users",
      },
    ]);
    const navigate = vi.fn();
    const c = new Client("/api/users", { fetch: fetchFn, navigate });
    await c.action("report");
    expect(navigate).toHaveBeenCalledWith("/reports/users");
  });

  it("throws ActionUnsupportedError when no navigate option is supplied and no browser is available", async () => {
    const fetchFn = fetchWith([
      {
        name: "edit",
        label: "Edit",
        level: "row",
        processor: "navigate",
        value: "/users/$1/edit",
      },
    ]);
    // Stash and remove globalThis.location to simulate non-browser env.
    const originalLocation = (globalThis as { location?: unknown }).location;
    delete (globalThis as { location?: unknown }).location;
    try {
      const c = new Client("/api/users", { fetch: fetchFn });
      await expect(c.action("edit", "abc")).rejects.toBeInstanceOf(ActionUnsupportedError);
    } finally {
      if (originalLocation !== undefined) {
        (globalThis as { location?: unknown }).location = originalLocation;
      }
    }
  });
});

describe("Client.action — custom processor", () => {
  it("throws ActionUnsupportedError; clients must dispatch custom actions themselves", async () => {
    const fetchFn = fetchWith([
      {
        name: "exportCsv",
        label: "Export",
        level: "table",
        processor: "custom",
        value: "exportCsv",
      },
    ]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await expect(c.action("exportCsv")).rejects.toBeInstanceOf(ActionUnsupportedError);
  });
});

describe("Client.action — unknown action", () => {
  it("throws ActionNotFoundError", async () => {
    const fetchFn = fetchWith([]);
    const c = new Client("/api/users", { fetch: fetchFn });
    await expect(c.action("missing")).rejects.toBeInstanceOf(ActionNotFoundError);
  });
});
