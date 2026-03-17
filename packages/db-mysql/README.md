<p align="center">
  <img src="https://db.atscript.dev/logo.svg" alt="Atscript" width="120" />
</p>

<h1 align="center">@atscript/db-mysql</h1>

<p align="center">
  <strong>Define your models once</strong> — get TypeScript types, runtime validation, and DB metadata from a single <code>.as</code> model.
</p>

<p align="center">
  <a href="https://db.atscript.dev">Documentation</a> · <a href="https://db.atscript.dev/adapters/mysql">MySQL Adapter</a>
</p>

---

MySQL adapter for `@atscript/db` using the `mysql2` driver. Supports native FULLTEXT search, VECTOR columns (MySQL 9.0+), AUTO_INCREMENT, batched multi-row inserts, and full schema sync.

Includes `MysqlPlugin` for `@db.mysql.*` annotations (engine, charset, collation, unsigned, type overrides, ON UPDATE).

## Installation

```bash
pnpm add @atscript/db-mysql mysql2
```

## Quick Start

```typescript
import { DbSpace } from "@atscript/db";
import { createAdapter } from "@atscript/db-mysql";

const db = createAdapter("mysql://root@localhost:3306/mydb");
const users = db.getTable(UsersType);

await users.insertOne({ name: "Alice", email: "alice@example.com" });
```

## Features

- Full CRUD with batched multi-row INSERT (auto-chunking)
- Native FULLTEXT search via `MATCH ... AGAINST`
- VECTOR(N) column type on MySQL 9.0+ with distance functions
- AUTO_INCREMENT with configurable start value
- Storage engine selection (InnoDB, MyISAM, etc.)
- Character set and collation control
- UNSIGNED integer columns, native type overrides, ON UPDATE expressions
- Foreign key constraints with referential actions
- Full schema sync: CREATE, ALTER, DROP, indexes, views

## Documentation

- [MySQL Adapter Guide](https://db.atscript.dev/adapters/mysql)
- [Full Documentation](https://db.atscript.dev)

## License

MIT
