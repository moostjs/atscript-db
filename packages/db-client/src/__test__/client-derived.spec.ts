import { describe, it, expect, vi, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { Client } from "../client";
import type { MetaResponse } from "../types";
import { ClientValidationError, createClientValidator } from "../validator";

/**
 * db-client and `@db.column.derived` (since 0.1.142): the served `/meta` type
 * keeps the `db.column.derived` annotation (moost-db's derived-meta.spec.ts),
 * so the shared validator plugin treats derived fields as server-managed on the
 * client too —
 * - insert/replace may omit a required derived field;
 * - `$inc`/`$dec`/`$mul` on a derived field is rejected before any request.
 */

let derivedMeta: MetaResponse;

beforeAll(async () => {
  const fixtures = (await import("./fixtures/test-table.as")) as Record<string, unknown>;
  derivedMeta = {
    searchable: false,
    vectorSearchable: false,
    searchIndexes: [],
    primaryKeys: ["id"],
    preferredId: ["id"],
    relations: [],
    fields: {},
    actions: [],
    crud: {},
    type: serializeAnnotatedType(fixtures.DerivedOrder as unknown as TAtscriptAnnotatedType, {
      refDepth: 0.5,
    }),
  } as unknown as MetaResponse;
});

const row = { id: 1, status: "open", payload: { customer: { id: "c1" }, total: 3 } };

function mockFetch(response: { status: number; body: unknown }) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/meta")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(derivedMeta),
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

const writeCalls = (fetchFn: ReturnType<typeof vi.fn>) =>
  fetchFn.mock.calls.filter(([u]) => !String(u).endsWith("/meta"));

describe("ClientValidator — derived fields are server-managed", () => {
  it("insert and replace accept a row without the required derived fields", () => {
    const v = createClientValidator(derivedMeta);
    expect(() => v.validate(row, "insert")).not.toThrow();
    expect(() => v.validate([row, { ...row, id: 2 }], "insert")).not.toThrow();
    expect(() => v.validate(row, "replace")).not.toThrow();
  });

  it("a supplied derived value still type-checks", () => {
    const v = createClientValidator(derivedMeta);
    expect(() => v.validate({ ...row, amount: 3 }, "insert")).not.toThrow();
    expect(() => v.validate({ ...row, amount: "3" }, "insert")).toThrow(ClientValidationError);
  });

  it.each(["$inc", "$dec", "$mul"])("rejects %s on a derived field", (op) => {
    const v = createClientValidator(derivedMeta);
    let err: unknown;
    try {
      v.validate({ id: 1, amount: { [op]: 2 } }, "patch");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClientValidationError);
    expect((err as ClientValidationError).errors[0]).toMatchObject({
      path: "amount",
      message: expect.stringContaining("not allowed on a @db.column.derived field"),
    });
  });
});

describe("Client — derived fields end to end (mocked fetch)", () => {
  it("insert without derived values is sent as-is", async () => {
    const fetchFn = mockFetch({ status: 201, body: { insertedId: 1 } });
    const client = new Client("/api/orders", { fetch: fetchFn });
    await expect(client.insert(row as any)).resolves.toEqual({ insertedId: 1 });
    expect(JSON.parse((writeCalls(fetchFn)[0][1] as RequestInit).body as string)).toEqual(row);
  });

  it("replace without derived values is sent", async () => {
    const fetchFn = mockFetch({ status: 200, body: { matchedCount: 1, modifiedCount: 1 } });
    const client = new Client("/api/orders", { fetch: fetchFn });
    await client.replace(row as any);
    expect(writeCalls(fetchFn)).toHaveLength(1);
  });

  it("update with $inc on a derived field is rejected before any request", async () => {
    const fetchFn = mockFetch({ status: 200, body: { matchedCount: 1, modifiedCount: 1 } });
    const client = new Client("/api/orders", { fetch: fetchFn });
    await expect(client.update({ id: 1, amount: { $inc: 1 } } as any)).rejects.toBeInstanceOf(
      ClientValidationError,
    );
    expect(writeCalls(fetchFn)).toHaveLength(0);
  });
});
