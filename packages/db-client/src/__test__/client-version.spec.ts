import { describe, it, expect, vi, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { Client } from "../client";
import { VersionMismatchError } from "../client-error";
import { ClientValidationError } from "../validator";

/**
 * db-client OCC contract (since 0.1.128):
 * - the version column is server-managed → optional in insert/replace preflight
 *   (the shared validator plugin's skip list; requires the served `/meta` type
 *   to keep the `db.column.version` annotation);
 * - `$cas: { version: N }` is accepted and lifted to the wire shape `version: N`;
 * - `version` + differing `$cas` is ambiguous, `$cas` on a non-versioned table
 *   and `$cas` on insert are rejected client-side;
 * - a 409 `version_mismatch` still dispatches `VersionMismatchError`.
 */

let versionedMeta: Record<string, unknown>;
let plainMeta: Record<string, unknown>;

function serialize(type: TAtscriptAnnotatedType) {
  return serializeAnnotatedType(type, {
    processAnnotation: ({ key, value }) => {
      if (key.startsWith("meta.") || key.startsWith("expect.") || key.startsWith("db.rel.")) {
        return { key, value };
      }
      if (
        key === "db.json" ||
        key === "db.patch.strategy" ||
        key.startsWith("db.default") ||
        key === "db.column.version"
      ) {
        return { key, value };
      }
      if (key.startsWith("db.")) return undefined;
      return { key, value };
    },
  });
}

beforeAll(async () => {
  // Cast: the fixture's generated `.as.d.ts` is refreshed at postinstall, not at
  // test time — the runtime module always carries the compiled `VersionedUser`.
  const fixtures = (await import("./fixtures/test-table.as")) as Record<string, unknown>;
  const base = {
    searchable: false,
    vectorSearchable: false,
    searchIndexes: [],
    primaryKeys: ["id"],
    preferredId: ["id"],
    relations: [],
    fields: {},
    actions: [],
    crud: {},
  };
  versionedMeta = {
    ...base,
    versionColumn: "version",
    type: serialize(fixtures.VersionedUser as unknown as TAtscriptAnnotatedType),
  };
  plainMeta = {
    ...base,
    type: serialize(fixtures.User as unknown as TAtscriptAnnotatedType),
  };
});

function mockFetch(meta: Record<string, unknown>, response: { status: number; body: unknown }) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/meta")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(meta),
      });
    }
    return Promise.resolve({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: "X",
      headers: new Map() as unknown as Headers,
      json: () => Promise.resolve(response.body),
    });
  });
}

function sentBody(fetchFn: ReturnType<typeof vi.fn>): unknown {
  const write = fetchFn.mock.calls.find(([url]) => !String(url).endsWith("/meta"));
  expect(write).toBeDefined();
  return JSON.parse((write![1] as RequestInit).body as string);
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("insert — version is server-managed", () => {
  it("passes preflight without a version and sends the body as-is", async () => {
    const fetchFn = mockFetch(versionedMeta, { status: 201, body: { insertedId: 1 } });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    await expect(client.insert({ name: "Ada" })).resolves.toEqual({ insertedId: 1 });
    expect(sentBody(fetchFn)).toEqual({ name: "Ada" });
  });

  it("a version on insert passes through (the server accepts it)", async () => {
    const fetchFn = mockFetch(versionedMeta, { status: 201, body: { insertedId: 1 } });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    await client.insert({ name: "Ada", version: 0 });
    expect(sentBody(fetchFn)).toEqual({ name: "Ada", version: 0 });
  });

  it("rejects $cas on insert before any request", async () => {
    const fetchFn = mockFetch(versionedMeta, { status: 201, body: { insertedId: 1 } });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    const err = await caught(client.insert({ name: "Ada", $cas: { version: 0 } }));
    expect(err).toBeInstanceOf(ClientValidationError);
    expect((err as ClientValidationError).errors).toEqual([
      { path: "$cas", message: "$cas is not allowed on insert" },
    ]);
    expect(fetchFn.mock.calls.filter(([u]) => !String(u).endsWith("/meta"))).toHaveLength(0);
  });
});

describe("update / replace — $cas lifted to the wire shape", () => {
  it("update({ id, $cas: { version: 4 } }) sends PATCH { id, version: 4 }", async () => {
    const fetchFn = mockFetch(versionedMeta, {
      status: 202,
      body: { matchedCount: 1, modifiedCount: 1 },
    });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    const result = await client.update({ id: 1, $cas: { version: 4 } });
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(sentBody(fetchFn)).toEqual({ id: 1, version: 4 });
  });

  it("a bare version passes preflight unchanged (the wire contract)", async () => {
    const fetchFn = mockFetch(versionedMeta, {
      status: 202,
      body: { matchedCount: 1, modifiedCount: 1 },
    });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    await client.update({ id: 1, name: "B", version: 4 });
    expect(sentBody(fetchFn)).toEqual({ id: 1, name: "B", version: 4 });
  });

  it("replace({ …row, $cas }) lifts too, and the version column is optional in replace preflight", async () => {
    const fetchFn = mockFetch(versionedMeta, {
      status: 201,
      body: { matchedCount: 1, modifiedCount: 1 },
    });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    await client.replace({ id: 1, name: "B", $cas: { version: 2 } } as any);
    expect(sentBody(fetchFn)).toEqual({ id: 1, name: "B", version: 2 });
    fetchFn.mockClear();
    await client.replace({ id: 1, name: "C" } as any); // no version at all
    expect(sentBody(fetchFn)).toEqual({ id: 1, name: "C" });
  });

  it("arrays are normalised per item", async () => {
    const fetchFn = mockFetch(versionedMeta, {
      status: 202,
      body: { matchedCount: 2, modifiedCount: 2 },
    });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    await client.update([
      { id: 1, $cas: { version: 1 } },
      { id: 2, name: "x" },
      { id: 3, version: 3 },
    ]);
    expect(sentBody(fetchFn)).toEqual([
      { id: 1, version: 1 },
      { id: 2, name: "x" },
      { id: 3, version: 3 },
    ]);
  });

  it("never mutates the caller's payload", async () => {
    const fetchFn = mockFetch(versionedMeta, {
      status: 202,
      body: { matchedCount: 1, modifiedCount: 1 },
    });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    const payload = { id: 1, $cas: { version: 4 } };
    await client.update(payload);
    expect(payload).toEqual({ id: 1, $cas: { version: 4 } });
  });
});

const noWrite = (fetchFn: ReturnType<typeof vi.fn>) =>
  expect(fetchFn.mock.calls.filter(([u]) => !String(u).endsWith("/meta"))).toHaveLength(0);

describe("update — client-side rejections (no request is sent)", () => {
  it("version + differing $cas → ClientValidationError at $cas", async () => {
    const fetchFn = mockFetch(versionedMeta, { status: 202, body: {} });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    const err = await caught(client.update({ id: 1, version: 4, $cas: { version: 3 } }));
    expect(err).toBeInstanceOf(ClientValidationError);
    expect((err as ClientValidationError).errors).toEqual([
      { path: "$cas", message: 'Ambiguous version: "version" and "$cas.version" differ' },
    ]);
    noWrite(fetchFn);
  });

  it("version + identical $cas → lifted once", async () => {
    const fetchFn = mockFetch(versionedMeta, {
      status: 202,
      body: { matchedCount: 1, modifiedCount: 1 },
    });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    await client.update({ id: 1, version: 4, $cas: { version: 4 } });
    expect(sentBody(fetchFn)).toEqual({ id: 1, version: 4 });
  });

  it("array item conflict is reported at [i].$cas", async () => {
    const fetchFn = mockFetch(versionedMeta, { status: 202, body: {} });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    const err = await caught(
      client.update([
        { id: 1, version: 1 },
        { id: 2, version: 2, $cas: { version: 9 } },
      ]),
    );
    expect((err as ClientValidationError).errors[0]!.path).toBe("[1].$cas");
    noWrite(fetchFn);
  });

  it("$cas on a non-versioned table → ClientValidationError with the server's message", async () => {
    const fetchFn = mockFetch(plainMeta, { status: 202, body: {} });
    const client = new Client("/api/users", { fetch: fetchFn });
    const err = await caught(client.update({ id: 1, $cas: { version: 1 } }));
    expect(err).toBeInstanceOf(ClientValidationError);
    expect((err as ClientValidationError).errors).toEqual([
      {
        path: "$cas",
        message: "$cas operator: table has no @db.column.version; cannot use $cas",
      },
    ]);
    noWrite(fetchFn);
  });

  it("a malformed $cas (wrong key / non-integer) is rejected with the shared separateCas messages", async () => {
    const fetchFn = mockFetch(versionedMeta, { status: 202, body: {} });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    let err = await caught(client.update({ id: 1, $cas: { v: 1 } }));
    expect((err as ClientValidationError).errors[0]).toEqual({
      path: "$cas.v",
      message: '$cas operator: key "v" does not match version column "version"',
    });
    err = await caught(client.update({ id: 1, $cas: { version: 1.5 } }));
    expect((err as ClientValidationError).errors[0]!.path).toBe("$cas.version");
    noWrite(fetchFn);
  });
});

describe("409 version_mismatch after a $cas lift", () => {
  it("dispatches VersionMismatchError with currentVersion", async () => {
    const fetchFn = mockFetch(versionedMeta, {
      status: 409,
      body: {
        statusCode: 409,
        error: "Conflict",
        message: "version_mismatch",
        kind: "version_mismatch",
        currentVersion: 6,
      },
    });
    const client = new Client("/api/vusers", { fetch: fetchFn });
    const err = await caught(client.update({ id: 1, $cas: { version: 4 } }));
    expect(err).toBeInstanceOf(VersionMismatchError);
    expect((err as VersionMismatchError).currentVersion).toBe(6);
    expect(sentBody(fetchFn)).toEqual({ id: 1, version: 4 });
  });
});
