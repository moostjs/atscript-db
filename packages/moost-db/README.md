<p align="center">
  <img src="https://db.atscript.dev/logo.svg" alt="Atscript" width="120" />
</p>

<h1 align="center">@atscript/moost-db</h1>

<p align="center">
  <strong>Define your models once</strong> — get TypeScript types, runtime validation, and DB metadata from a single <code>.as</code> model.
</p>

<p align="center">
  <a href="https://db.atscript.dev">Documentation</a> · <a href="https://db.atscript.dev/http/">HTTP API Guide</a>
</p>

---

Generic database controller for the [Moost](https://moost.org) framework. Exposes Atscript-defined database tables and views as RESTful HTTP endpoints with zero boilerplate. Works with any `@atscript/db` adapter (SQLite, PostgreSQL, MongoDB, MySQL).

## Installation

```bash
pnpm add @atscript/moost-db
```

Peer dependencies: `moost`, `@moostjs/event-http`, `@atscript/db`, `@atscript/typescript`.

## Quick Start

```ts
import { AsDbController, TableController } from "@atscript/moost-db";
import { User } from "./models/user.as";

@TableController(usersTable)
export class UsersController extends AsDbController<typeof User> {}
```

This gives you: `GET /query`, `GET /pages`, `GET /one/:id`, `POST /`, `PUT /`, `PATCH /`, `DELETE /:id`, `GET /meta`.

## Features

- **Full CRUD** via `AsDbController` — insert, replace, update, delete (single and batch)
- **Read-only** via `AsDbReadableController` — query, paginate, get-one for views
- **URL query syntax** — filtering, sorting, pagination, field selection via query strings
- **Relation loading** with `$with` — eagerly load related data
- **Text search** (`$search`) and **vector search** (`$vector`) with pluggable `computeEmbedding()` hook
- **Aggregation** with `$groupBy`
- **Overridable hooks** — `onWrite`, `onRemove`, `transformFilter`, `computeEmbedding`
- Decorator shortcuts: `@TableController`, `@ReadableController`, `@ViewController`

## Documentation

- [HTTP API Guide](https://db.atscript.dev/http/)
- [Full Documentation](https://db.atscript.dev)

## License

MIT
