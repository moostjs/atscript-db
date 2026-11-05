import { describe, it, expect, vi, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { Client } from "../client";
import { ClientValidationError, createClientValidator } from "../validator";
import type { MetaResponse } from "../types";

/**
 * db-client and `@normalize.*` (since 0.1.170): the preflight applies the
 * served type's normalizers before it validates, and sends the normalized
 * data — the client checks and sends what the server stores.
 */

let meta: MetaResponse;

beforeAll(async () => {
  const fixtures = (await import("./fixtures/normalize-writes.as")) as Record<string, unknown>;
  meta = {
    primaryKeys: ["id"],
    preferredId: ["id"],
    relations: [],
    fields: {},
    actions: [],
    crud: {},
    type: serializeAnnotatedType(fixtures.NwUser as unknown as TAtscriptAnnotatedType, {
      refDepth: 0.5,
    }),
  } as unknown as MetaResponse;
});

function mockFetch() {
  return vi.fn().mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map() as unknown as Headers,
      json: () =>
        Promise.resolve(url.endsWith("/meta") ? meta : { matchedCount: 1, modifiedCount: 1 }),
    }),
  );
}

function sentBodies(fetchFn: ReturnType<typeof vi.fn>): unknown[] {
  return fetchFn.mock.calls
    .filter(([url]) => !String(url).endsWith("/meta"))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe("db-client normalizes write data before the preflight and sends it", () => {
  it("insert / replace / update send the normalized data", async () => {
    const fetchFn = mockFetch();
    const client = new Client("/api/users", { fetch: fetchFn });
    const row = { email: " Ann@Example.COM ", name: " Ann ", notes: [{ title: " n " }] };
    await client.insert(row);
    await client.replace({ id: 1, email: "ANN@example.com", name: "Ann", code: "ab" });
    await client.update([
      { id: 1, labels: { $insert: [" Red "] }, contacts: { $update: [{ kind: " EMAIL " }] } },
    ]);
    expect(sentBodies(fetchFn)).toEqual([
      { email: "ann@example.com", name: "Ann", notes: [{ title: "n" }] },
      { id: 1, email: "ann@example.com", name: "Ann", code: "AB" },
      [{ id: 1, labels: { $insert: ["red"] }, contacts: { $update: [{ kind: "email" }] } }],
    ]);
    // the caller's object is left as it was
    expect(row).toEqual({ email: " Ann@Example.COM ", name: " Ann ", notes: [{ title: " n " }] });
  });

  it("validates the normalized value (a pattern the raw input fails)", async () => {
    const client = new Client("/api/users", { fetch: mockFetch() });
    await expect(client.insert({ email: " A@X.io ", name: "a" })).resolves.toBeDefined();
    await expect(client.insert({ email: "a b@x.io", name: "a" })).rejects.toBeInstanceOf(
      ClientValidationError,
    );
  });

  it("ClientValidator.normalize is pure and copy-on-change", () => {
    const v = createClientValidator(meta);
    const clean = [{ email: "a@x", name: "A" }];
    expect(v.normalize(clean, "insert")).toBe(clean);
    expect(v.normalize({ id: 1, name: " B " }, "patch")).toEqual({ id: 1, name: "B" });
  });
});
