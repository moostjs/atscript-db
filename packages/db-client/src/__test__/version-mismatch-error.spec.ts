import { describe, it, expect, vi, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { Client } from "../client";
import { ClientError, VersionMismatchError } from "../client-error";

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
    preferredId: ["id"],
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

function fetchWith(errorResponse: { status: number; body: unknown }) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/meta")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(baseMeta),
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

describe("VersionMismatchError — client-side typed marker", () => {
  it("constructs VersionMismatchError when error body kind === 'version_mismatch'", async () => {
    // WHY: this is the load-bearing dispatch — if the dispatcher misses this
    // discriminator, every CAS-protected consumer has to fall back to manual
    // casting and the typed marker provides zero value.
    const fetchFn = fetchWith({
      status: 409,
      body: {
        statusCode: 409,
        error: "Conflict",
        message: "version_mismatch",
        kind: "version_mismatch",
        currentVersion: 6,
      },
    });
    const c = new Client("/api/users", { fetch: fetchFn });

    let caught: unknown;
    try {
      await c.update({ id: 1, name: "X" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(VersionMismatchError);
    expect(caught).toBeInstanceOf(ClientError); // subclass relation preserved
    const err = caught as VersionMismatchError;
    expect(err.status).toBe(409);
    expect(err.currentVersion).toBe(6);
    expect(err.message).toBe("version_mismatch");
  });

  it("falls back to plain ClientError when error body has no kind discriminator", async () => {
    // WHY: a generic 409 (e.g. ALREADY_EXISTS from an insert collision) must
    // not be mistaken for an OCC conflict — that'd send consumers into a
    // refresh-and-retry loop that can never resolve.
    const fetchFn = fetchWith({
      status: 409,
      body: { message: "Conflict", statusCode: 409 },
    });
    const c = new Client("/api/users", { fetch: fetchFn });

    let caught: unknown;
    try {
      await c.update({ id: 1, name: "X" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ClientError);
    expect(caught).not.toBeInstanceOf(VersionMismatchError);
    expect((caught as ClientError).status).toBe(409);
  });

  it("a 409 with kind other than 'version_mismatch' stays generic", async () => {
    // WHY: forward-compat — future kinds (e.g. "unique_constraint") must not
    // accidentally route through VersionMismatchError just because they share
    // status 409.
    const fetchFn = fetchWith({
      status: 409,
      body: {
        statusCode: 409,
        message: "duplicate key",
        kind: "duplicate_key",
      },
    });
    const c = new Client("/api/users", { fetch: fetchFn });

    let caught: unknown;
    try {
      await c.update({ id: 1, name: "X" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ClientError);
    expect(caught).not.toBeInstanceOf(VersionMismatchError);
  });
});
