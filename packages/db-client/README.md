<p align="center">
  <img src="https://db.atscript.dev/logo.svg" alt="Atscript" width="120" />
</p>

<h1 align="center">@atscript/db-client</h1>

<p align="center">
  Browser-compatible HTTP client for <code>@atscript/moost-db</code> REST endpoints.
</p>

<p align="center">
  <a href="https://db.atscript.dev">Documentation</a> · <a href="https://db.atscript.dev/http/client">HTTP Client Guide</a>
</p>

---

Type-safe HTTP client that mirrors the server-side `AtscriptDbTable` API over REST. Works in browsers, Node.js, and any runtime with `fetch`. Supports the full query surface — filters, sorting, pagination, relation loading, text search, and aggregation.

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

// Query
const active = await users.findMany({ filter: { status: "active" } });
const user = await users.findById("abc-123");

// Write
const { insertedId } = await users.insertOne({ name: "Alice" });
await users.updateOne({ id: insertedId, role: "admin" });
await users.deleteOne(insertedId);

// Metadata
const meta = await users.meta();
```

## Features

- **Full CRUD** — `findMany`, `findOne`, `findById`, `count`, `pages`, `insertOne`, `insertMany`, `updateOne`, `bulkUpdate`, `replaceOne`, `bulkReplace`, `deleteOne`
- **URL query syntax** — filtering, sorting, pagination, field selection, relation loading via `$with`
- **Search** — full-text (`search()`) and vector search via query controls
- **Aggregation** — `$groupBy` with aggregate functions
- **Error handling** — `ClientError` with structured validation errors
- **SSR isomorphism** — `DbInterface<T>` shared between server `AtscriptDbTable` and client `Client`
- **Configurable** — custom `fetch`, static or async headers, base URL

## Documentation

- [HTTP Client Guide](https://db.atscript.dev/http/client) — Full API reference with examples
- [HTTP API Guide](https://db.atscript.dev/http/) — Server-side setup
- [URL Query Syntax](https://db.atscript.dev/http/query-syntax) — Filter, sort, and pagination syntax

## License

MIT
