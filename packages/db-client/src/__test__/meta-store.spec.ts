import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { Client } from "../client";
import { ClientError, TransportError } from "../client-error";
import { MetaStore, clearMetaStore } from "../meta-store";

const META_A = { searchable: false, fields: { id: {} }, marker: "a" };
const META_B = { searchable: false, fields: { id: {} }, marker: "b" };

type Reply = { status: number; etag?: string; body?: unknown } | Error;

/** A fetch mock answering from `replies` in order (the last one repeats), recording `If-None-Match`. */
function serverMock(...replies: Reply[]) {
  const sent: Array<{
    url: string;
    ifNoneMatch: string | undefined;
    headers: Record<string, string>;
  }> = [];
  let i = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url, ifNoneMatch: headers["If-None-Match"], headers });
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    const h = new Headers();
    if (reply.etag) h.set("etag", reply.etag);
    if (reply.status === 304) return new Response(null, { status: 304, headers: h });
    h.set("content-type", "application/json");
    return new Response(JSON.stringify(reply.body ?? { message: "boom" }), {
      status: reply.status,
      headers: h,
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

afterEach(() => clearMetaStore());

describe("meta store", () => {
  it("stores a 200 by ETag and revalidates a second client of the same URL with a 304", async () => {
    const metaStore = new MetaStore();
    const etag = 'W/"abc"';
    const { fetch, sent } = serverMock({ status: 200, etag, body: META_A }, { status: 304, etag });
    const first = await new Client("/api/todos", { fetch, metaStore }).meta();
    expect(first).toEqual(META_A);
    expect(metaStore.size).toBe(1);
    expect(metaStore.candidates("/api/todos/meta")).toEqual([etag]);

    const second = await new Client("/api/todos", { fetch, metaStore }).meta();
    expect(second).toEqual(META_A);
    expect(second).not.toBe(first); // each caller gets its own copy
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, etag]);
  });

  it("a shared metaKey lets a new route param revalidate against another param's body", async () => {
    const metaStore = new MetaStore();
    const metaKey = "/api/tenant/:id/todos";
    const { fetch, sent } = serverMock(
      { status: 200, etag: 'W/"t"', body: META_A },
      { status: 304, etag: 'W/"t"' },
    );
    await new Client("/api/tenant/1/todos", { fetch, metaStore, metaKey }).meta();
    const meta = await new Client("/api/tenant/2/todos", { fetch, metaStore, metaKey }).meta();
    expect(meta).toEqual(META_A);
    expect(sent.map((s) => [s.url, s.ifNoneMatch])).toEqual([
      ["/api/tenant/1/todos/meta", undefined],
      ["/api/tenant/2/todos/meta", 'W/"t"'],
    ]);
  });

  it("without metaKey, different URLs do not share candidates", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock({ status: 200, etag: 'W/"t"', body: META_A });
    await new Client("/api/tenant/1/todos", { fetch, metaStore }).meta();
    await new Client("/api/tenant/2/todos", { fetch, metaStore }).meta();
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, undefined]);
  });

  it("invalidateMeta drops the client memo; the next meta() revalidates with a 304", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock(
      { status: 200, etag: '"e1"', body: META_A },
      { status: 304, etag: '"e1"' },
    );
    const client = new Client("/api/todos", { fetch, metaStore });
    await client.meta();
    await client.meta();
    expect(sent).toHaveLength(1);
    client.invalidateMeta();
    expect(await client.meta()).toEqual(META_A);
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, '"e1"']);
  });

  it("a changed /meta (200 with a new ETag) replaces what the client returns; both ETags become candidates", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock(
      { status: 200, etag: 'W/"a"', body: META_A },
      { status: 200, etag: 'W/"b"', body: META_B },
      { status: 304, etag: 'W/"a"' },
    );
    const client = new Client("/api/todos", { fetch, metaStore });
    expect(await client.meta()).toEqual(META_A);
    client.invalidateMeta();
    expect(await client.meta()).toEqual(META_B);
    client.invalidateMeta();
    // Most recent first, sent verbatim (weak prefix kept).
    expect(await client.meta()).toEqual(META_A);
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, 'W/"a"', 'W/"b", W/"a"']);
  });

  it("a 304 matching a weak tag with a strong one (or vice versa) still reuses the body", async () => {
    const metaStore = new MetaStore();
    const { fetch } = serverMock(
      { status: 200, etag: 'W/"x"', body: META_A },
      { status: 304, etag: '"x"' },
    );
    await new Client("/api/todos", { fetch, metaStore }).meta();
    expect(await new Client("/api/todos", { fetch, metaStore }).meta()).toEqual(META_A);
  });

  it("a 304 without an ETag header refetches without If-None-Match", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock(
      { status: 200, etag: '"e1"', body: META_A },
      { status: 304 },
      { status: 200, etag: '"e1"', body: META_A },
    );
    await new Client("/api/todos", { fetch, metaStore }).meta();
    expect(await new Client("/api/todos", { fetch, metaStore }).meta()).toEqual(META_A);
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, '"e1"', undefined]);
  });

  it("a 304 naming an ETag the store does not hold refetches without If-None-Match", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock(
      { status: 200, etag: '"e1"', body: META_A },
      { status: 304, etag: '"other"' },
      { status: 200, etag: '"e2"', body: META_B },
    );
    await new Client("/api/todos", { fetch, metaStore }).meta();
    expect(await new Client("/api/todos", { fetch, metaStore }).meta()).toEqual(META_B);
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, '"e1"', undefined]);
    expect(metaStore.candidates("/api/todos/meta")).toEqual(['"e2"', '"e1"']);
  });

  it("never stores failures: a 500 is thrown, not cached, and the next call retries", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock(
      { status: 500, etag: '"err"', body: { message: "boom", statusCode: 500 } },
      { status: 200, etag: '"e1"', body: META_A },
    );
    const client = new Client("/api/todos", { fetch, metaStore });
    await expect(client.meta()).rejects.toBeInstanceOf(ClientError);
    expect(metaStore.size).toBe(0);
    expect(await client.meta()).toEqual(META_A);
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, undefined]);
  });

  it("a conditional request answered with an error status surfaces that error", async () => {
    const metaStore = new MetaStore();
    const { fetch } = serverMock(
      { status: 200, etag: '"e1"', body: META_A },
      { status: 403, body: { message: "forbidden", statusCode: 403 } },
    );
    await new Client("/api/todos", { fetch, metaStore }).meta();
    const err = await new Client("/api/todos", { fetch, metaStore }).meta().catch((e) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect(err.status).toBe(403);
  });

  it("a network error on the conditional request retries without the header and stops sending it for that key", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock(
      { status: 200, etag: '"e1"', body: META_A },
      new TypeError("Failed to fetch"),
      { status: 200, etag: '"e1"', body: META_A },
    );
    await new Client("/api/todos", { fetch, metaStore }).meta();
    expect(await new Client("/api/todos", { fetch, metaStore }).meta()).toEqual(META_A);
    await new Client("/api/todos", { fetch, metaStore }).meta();
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, '"e1"', undefined, undefined]);
  });

  it("a network error on both attempts is a TransportError and nothing is marked", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock(
      { status: 200, etag: '"e1"', body: META_A },
      new TypeError("offline"),
      new TypeError("offline"),
      { status: 304, etag: '"e1"' },
    );
    await new Client("/api/todos", { fetch, metaStore }).meta();
    const client = new Client("/api/todos", { fetch, metaStore });
    await expect(client.meta()).rejects.toBeInstanceOf(TransportError);
    expect(await client.meta()).toEqual(META_A);
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, '"e1"', undefined, '"e1"']);
  });

  it("a 200 without a readable ETag (e.g. cross-origin without Expose-Headers) is not stored", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock({ status: 200, body: META_A });
    await new Client("/api/todos", { fetch, metaStore }).meta();
    await new Client("/api/todos", { fetch, metaStore }).meta();
    expect(metaStore.size).toBe(0);
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, undefined]);
  });

  it("clear() drops every entry: the next request carries no If-None-Match", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock({ status: 200, etag: '"e1"', body: META_A });
    await new Client("/api/todos", { fetch, metaStore }).meta();
    metaStore.clear();
    expect(metaStore.size).toBe(0);
    await new Client("/api/todos", { fetch, metaStore }).meta();
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, undefined]);
  });

  it("clients share the default store; clearMetaStore() empties it", async () => {
    const { fetch, sent } = serverMock(
      { status: 200, etag: '"d"', body: META_A },
      { status: 304, etag: '"d"' },
      { status: 200, etag: '"d"', body: META_A },
    );
    await new Client("/api/todos", { fetch }).meta();
    await new Client("/api/todos", { fetch }).meta();
    clearMetaStore();
    await new Client("/api/todos", { fetch }).meta();
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, '"d"', undefined]);
  });

  it("metaStore: false never sends If-None-Match", async () => {
    const { fetch, sent } = serverMock({ status: 200, etag: '"e1"', body: META_A });
    await new Client("/api/todos", { fetch, metaStore: false }).meta();
    await new Client("/api/todos", { fetch, metaStore: false }).meta();
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, undefined]);
  });

  it("keeps the client's own headers on the conditional request", async () => {
    const metaStore = new MetaStore();
    const { fetch, sent } = serverMock(
      { status: 200, etag: '"e1"', body: META_A },
      { status: 304, etag: '"e1"' },
    );
    const headers = { Authorization: "Bearer t" };
    await new Client("/api/todos", { fetch, metaStore, headers }).meta();
    await new Client("/api/todos", { fetch, metaStore, headers }).meta();
    expect(sent[1]!.headers).toEqual({ Authorization: "Bearer t", "If-None-Match": '"e1"' });
    expect(headers).toEqual({ Authorization: "Bearer t" });
  });

  it("is bounded: the least recently used body is dropped and its ETag no longer sent", async () => {
    const metaStore = new MetaStore({ maxEntries: 1 });
    const { fetch, sent } = serverMock(
      { status: 200, etag: '"a"', body: META_A },
      { status: 200, etag: '"b"', body: META_B },
    );
    await new Client("/api/a", { fetch, metaStore }).meta();
    await new Client("/api/b", { fetch, metaStore }).meta();
    expect(metaStore.size).toBe(1);
    expect(metaStore.candidates("/api/a/meta")).toEqual([]);
    await new Client("/api/a", { fetch, metaStore }).meta();
    expect(sent.map((s) => s.ifNoneMatch)).toEqual([undefined, undefined, undefined]);
  });
});
