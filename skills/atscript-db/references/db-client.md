# db-client

Browser/SSR fetch client for `moost-db` REST endpoints. Zero runtime deps apart from `@atscript/db` types (type-only at runtime).

## Install

```bash
pnpm add @atscript/db-client
```

## Basic usage

```ts
import { Client } from '@atscript/db-client'
import type { User } from './schema/user.as'

const users = new Client<typeof User>('/api/users')

await users.query()                                      // GET /api/users/query
await users.query({ filter: { active: true } })
await users.pages({ controls: { $sort: { name: 1 } } }, 1, 20)
await users.one(42)                                      // GET /api/users/one/42
await users.one({ orderId: 1, productId: 2 })            // composite key → GET /api/users/one?orderId=1&productId=2
await users.count({ filter: { active: true } })          // GET /api/users/query?$count=1
await users.aggregate({ controls: { $groupBy: ['role'], $select: [...] } })

await users.insert({ name: 'Alice', email: 'a@e.com' })
await users.insert([{ ... }, { ... }])                    // array body → insertMany
await users.update({ id: 1, status: 'active' })          // PATCH
await users.replace({ id: 1, ...full })                   // PUT
await users.remove(42)                                    // DELETE
await users.remove({ orderId: 1, productId: 2 })          // composite → DELETE /?orderId=1&productId=2

await users.meta()                                        // TMetaResponse — cached on the client instance
```

## Constructor options

```ts
new Client<T>(path, {
  baseUrl?: string,                  // prepended to every URL
  fetch?: typeof fetch,              // custom fetch (SSR / testing / auth proxying)
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>),
})
```

`headers` may be a function — re-evaluated per request, useful for token refresh.

## Typed filters

`Own<T>` / `Nav<T>` / `Id<T>` / `Data<T>` are computed from the `.as` type:

```ts
// Own<User>: own-prop fields (no nav props)
// Id<User>:  composite id shape when PK is composite, scalar otherwise
// Data<T> after findMany: Omit<User, keyof Nav> ∪ Pick<User, keysFromDollarWith>
```

Autocomplete works on every filter path, sort key, and `$select` element.

## Error handling

```ts
import { ClientError } from "@atscript/db-client";

try {
  await users.insert({ email: "bad" });
} catch (e) {
  if (e instanceof ClientError) {
    e.status; // HTTP status
    e.body; // parsed JSON body from the server (includes `errors[]`)
    e.errors; // convenience: `body.errors ?? []`
  }
}
```

## Meta + validator caching

- `client.meta()` lazy-fetches `/meta` on first call and caches the response.
- The client builds a runtime validator from the meta type (same validator engine as the server, `refDepth = (@db.deep.insert N) + 0.5` so nested writes match the server's acceptance depth exactly).

```ts
const validator = await client.getValidator();
validator.validate(payload, "insert"); // throws ClientValidationError with `errors: { path, message }[]`
validator.validate(payload, "patch");
validator.validate(payload, "replace");
```

Pre-flight validation saves a round-trip on bad payloads.

## Auth

Use `headers` for bearer / cookie / CSRF:

```ts
const client = new Client<typeof User>("/api/users", {
  headers: async () => ({
    Authorization: `Bearer ${await getToken()}`,
    "X-CSRF-Token": readCsrfCookie(),
  }),
});
```

For cookie-based auth, pass `credentials: 'include'` via a custom `fetch`:

```ts
new Client<typeof User>("/api/users", {
  fetch: (input, init) => globalThis.fetch(input, { ...init, credentials: "include" }),
});
```

URL serialization uses `@uniqu/url/builder` — same grammar the server parses (see `http-query-syntax.md`). For SSR, pass a fetch-compatible function via `fetch` and request-scoped tokens via `headers`.

## `null` on 404

`client.one(id)` returns `null` for HTTP 404. All other non-2xx responses throw `ClientError`.
