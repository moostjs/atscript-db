import { describe, it, expect, vi, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { Client } from "../client";
import { TransportError } from "../client-error";

let meta: Record<string, unknown>;

beforeAll(async () => {
  const { User } = await import("./fixtures/test-table.as");
  meta = {
    searchable: false,
    vectorSearchable: false,
    searchIndexes: [],
    primaryKeys: ["id"],
    preferredId: ["id"],
    relations: [],
    fields: {},
    actions: [],
    crud: {},
    type: serializeAnnotatedType(User as unknown as TAtscriptAnnotatedType),
  };
});

// Since 0.1.165 every read / write method takes a per-call `{ signal }` that
// reaches `fetch`, and a `TransportError` caused by an abort says so
// (`aborted`), so callers can tell a cancelled request from a network failure.

function okFetch(body: unknown = []) {
  return vi.fn().mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      json: () => Promise.resolve(url.endsWith("/meta") ? meta : body),
    }),
  );
}

const signalOf = (fetch: ReturnType<typeof vi.fn>) =>
  (fetch.mock.calls.at(-1)?.[1] as RequestInit | undefined)?.signal;

describe("db-client per-call signal", () => {
  it("reads pass the signal to fetch", async () => {
    const fetch = okFetch();
    const c = new Client("/api/t", { fetch });
    const { signal } = new AbortController();
    await c.query({}, { signal });
    expect(signalOf(fetch)).toBe(signal);
    await c.pages({}, 1, 10, { signal });
    expect(signalOf(fetch)).toBe(signal);
    await c.count({}, { signal });
    expect(signalOf(fetch)).toBe(signal);
    await c.one(1, {}, { signal });
    expect(signalOf(fetch)).toBe(signal);
    await c.aggregate({ controls: { $groupBy: ["a"] } } as never, { signal });
    expect(signalOf(fetch)).toBe(signal);
  });

  it("writes pass the signal to fetch", async () => {
    const fetch = okFetch({});
    const c = new Client("/api/t", { fetch });
    const { signal } = new AbortController();
    await c.insert({ name: "a" }, { signal });
    expect(signalOf(fetch)).toBe(signal);
    await c.insert({ name: "a" }, { onConflict: "ignore", signal });
    expect(signalOf(fetch)).toBe(signal);
    expect(fetch.mock.calls.at(-1)?.[0]).toContain("$onConflict=ignore");
    await c.update({ id: 1, name: "b" }, { signal });
    expect(signalOf(fetch)).toBe(signal);
    await c.replace({ id: 1, name: "b", status: "x" }, { signal });
    expect(signalOf(fetch)).toBe(signal);
    await c.remove(1, { signal });
    expect(signalOf(fetch)).toBe(signal);
  });

  it("an aborted request is a TransportError with aborted === true", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const c = new Client("/api/t", { fetch: vi.fn().mockRejectedValue(abort) });
    const error = await c.query({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
    expect((error as TransportError).cause).toBe(abort);
  });

  it("a network failure is not aborted", async () => {
    const c = new Client("/api/t", { fetch: vi.fn().mockRejectedValue(new TypeError("fail")) });
    const error = await c.query({}).catch((e: unknown) => e);
    expect((error as TransportError).aborted).toBe(false);
  });
});
