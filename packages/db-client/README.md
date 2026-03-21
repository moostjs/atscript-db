<p align="center">
  <img src="https://db.atscript.dev/logo.svg" alt="Atscript" width="120" />
</p>

<h1 align="center">@atscript/db-client</h1>

<p align="center">
  HTTP client for <code>@atscript/moost-db</code> REST endpoints.
</p>

<p align="center">
  <a href="https://db.atscript.dev">Documentation</a> · <a href="https://db.atscript.dev/http/client">HTTP Client Guide</a>
</p>

---

Type-safe HTTP client that mirrors moost-db controller endpoints. Works in browsers, Node.js, and any runtime with `fetch`. Each method maps 1:1 to a controller endpoint — filters, sorting, pagination, relation loading, text search, and aggregation are all supported through typed query controls.

In SSR environments, Moost's `fetch` automatically routes local requests to handlers in-process, so the same `Client` instance works on both server and browser.

## Installation

```bash
pnpm add @atscript/db-client
```

## Quick Start

```typescript
import { Client } from "@atscript/db-client";
import type { User } from "./models/user.as";

const users = new Client<typeof User>("/api/users", {
  baseUrl: "https://api.example.com",
});

// Query                            → GET /query
const active = await users.query({ filter: { status: "active" } });

// Get one                          → GET /one/:id
const user = await users.one("abc-123");

// Insert                           → POST /
const { insertedId } = await users.insert({ name: "Alice" });

// Update                           → PATCH /
await users.update({ id: insertedId, role: "admin" });

// Remove                           → DELETE /:id
await users.remove(insertedId);

// Count                            → GET /query ($count)
const total = await users.count();

// Paginate                         → GET /pages
const page = await users.pages({ filter: { active: true } }, 1, 20);

// Metadata                         → GET /meta
const meta = await users.meta();
```

## Features

- **Typed queries** — filter keys, sort fields, `$with` relation names, and primary keys are type-checked against the Atscript model
- **Full CRUD** — `query`, `count`, `pages`, `one`, `insert`, `update`, `replace`, `remove`
- **Aggregation** — typed `$groupBy` dimensions and measures with inferred result types
- **Search** — full-text and vector search via query controls
- **Client-side validation** — validates writes against the Atscript schema before sending
- **Error handling** — `ClientError` with structured validation errors
- **Configurable** — custom `fetch`, static or async headers, base URL

## Documentation

- [HTTP Client Guide](https://db.atscript.dev/http/client) — Full API reference with examples
- [HTTP API Guide](https://db.atscript.dev/http/) — Server-side setup
- [URL Query Syntax](https://db.atscript.dev/http/query-syntax) — Filter, sort, and pagination syntax

## License

MIT
